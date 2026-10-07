/* 社交后端：评论（含回复）与点赞，所有访客共享。
   部署在同一个 Cloudflare Worker 上：/api/* 走这里，其余仍是静态网页（wrangler.toml 的 run_worker_first）。
   数据存在一个 Durable Object（自带 SQLite，免费版可用，部署时自动创建，不需要在后台建数据库）。

   GET    /api/social?ids=a,b&vid=…     各条动态的点赞数、我是否赞过、评论列表
   POST   /api/comment  {post,parent,nick,site,text,vid}   发评论 / 回复（site 可不填；带站主令牌时标记为作者）
   POST   /api/like     {target:"p:<动态>"|"c:<评论>", vid, on}
   DELETE /api/comment?id=…            删除评论及其回复（需站主 GitHub 令牌）

   共享城市（所有访客看到、改的是同一座城）：城市拆成一条条记录（一格楼、一列地块、一段路、一个方块、一座连廊），
   每次改动只传有变化的记录，按记录合并，互不覆盖；每次改动都记日志，站主可以回滚到任意时间。
   GET  /api/city?since=rev            rev 之后变化的记录 {rev, ch:[[k, v|null]…]}（since=0 = 整座城）
   POST /api/city  {since, set:[[k, v|null]…]}   提交改动，返回 since 之后所有变化（含自己的）
   POST /api/city/reset {set}          站主：整座城换成这份（首次建立共享城市 / 恢复）
   POST /api/city/rollback {to}        站主：把 to（毫秒时间戳）之后的所有改动撤回 */
import { DurableObject } from "cloudflare:workers";

const REPO = "AsamiAkito/knowledge-base";            // 站主 = 对这个仓库有写权限的 GitHub 令牌
const ID = /^[\w-]{1,48}$/, VID = /^[\w-]{8,48}$/;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);

export class Social extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, post TEXT NOT NULL, parent TEXT, nick TEXT, text TEXT, ts INTEGER, ip TEXT, owner INTEGER DEFAULT 0)`);
    try { this.sql.exec(`ALTER TABLE comments ADD COLUMN site TEXT`); } catch (e) { }          // 新增「网站」列（已存在时忽略）
    this.sql.exec(`CREATE INDEX IF NOT EXISTS comments_post ON comments(post)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS comments_ip ON comments(ip, ts)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS likes(target TEXT NOT NULL, vid TEXT NOT NULL, ts INTEGER, PRIMARY KEY(target, vid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS city_kv(k TEXT PRIMARY KEY, v TEXT, rev INTEGER)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS city_kv_rev ON city_kv(rev)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS city_log(rev INTEGER PRIMARY KEY, k TEXT, old TEXT, new TEXT, ts INTEGER, ip TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS city_log_ts ON city_log(ts)`);
    this.owners = new Map();                          // 令牌摘要 → 校验通过的过期时间
    this.hits = new Map();                            // 点赞限流：ip → [时间…]
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname.replace(/^\/api\//, ""), m = req.method;
    try {
      if (m === "GET" && path === "social") return this.list(url);
      if (m === "POST" && path === "comment") return await this.comment(req);
      if (m === "POST" && path === "like") return await this.like(req);
      if (m === "DELETE" && path === "comment") return await this.remove(req, url);
      if (m === "GET" && path === "city") return this.cityGet(+url.searchParams.get("since") || 0);
      if (m === "POST" && path === "city") return await this.cityPost(req);
      if (m === "POST" && path === "city/reset") return await this.cityReset(req);
      if (m === "POST" && path === "city/rollback") return await this.cityRollback(req);
      return bad("not found", 404);
    } catch (e) { return bad("server error", 500); }
  }

  list(url) {
    const ids = (url.searchParams.get("ids") || "").split(",").filter(x => ID.test(x)).slice(0, 200), vid = url.searchParams.get("vid") || "";
    const posts = {};
    ids.forEach(id => {
      const likes = this.count("p:" + id), liked = VID.test(vid) && this.has("p:" + id, vid);
      const comments = this.sql.exec(`SELECT id, parent, nick, text, ts, owner, site FROM comments WHERE post = ? ORDER BY ts`, id).toArray()
        .map(c => ({ ...c, owner: !!c.owner, likes: this.count("c:" + c.id), liked: VID.test(vid) && this.has("c:" + c.id, vid) }));
      posts[id] = { likes, liked, comments };
    });
    return json({ posts });
  }

  async comment(req) {
    const b = await req.json().catch(() => ({})), ip = await ipKey(req), now = Date.now();
    const post = String(b.post || ""), text = String(b.text || "").trim().slice(0, 300), nick = String(b.nick || "").trim().slice(0, 20) || "访客";
    if (!ID.test(post) || !text) return bad("内容不完整");
    let parent = b.parent ? String(b.parent) : null;
    let site = String(b.site || "").trim().slice(0, 120);                       // 网站（可不填）：只收 http(s) 地址
    if (site && !/^https?:\/\//i.test(site)) site = "https://" + site;
    try { site = site ? new URL(site).href : ""; } catch (e) { site = ""; }
    if (site && !/^https?:/.test(site)) site = "";
    if (parent && !this.sql.exec(`SELECT 1 FROM comments WHERE id = ? AND post = ?`, parent, post).toArray().length) parent = null;
    /* 限流：同一来源 1 分钟最多 3 条，1 天最多 50 条 */
    const recent = (ms) => this.sql.exec(`SELECT COUNT(*) AS n FROM comments WHERE ip = ? AND ts > ?`, ip, now - ms).one().n;
    if (recent(60e3) >= 3 || recent(864e5) >= 50) return bad("发得太快了，稍后再试", 429);
    const owner = await this.isOwner(req);
    const id = now.toString(36) + Math.random().toString(36).slice(2, 7);
    this.sql.exec(`INSERT INTO comments(id, post, parent, nick, text, ts, ip, owner, site) VALUES (?,?,?,?,?,?,?,?,?)`, id, post, parent, nick, text, now, ip, owner ? 1 : 0, site || null);
    return json({ comment: { id, parent, nick, text, ts: now, owner, site: site || null, likes: 0, liked: false } });
  }

  async like(req) {
    const b = await req.json().catch(() => ({})), target = String(b.target || ""), vid = String(b.vid || ""), ip = await ipKey(req);
    if (!/^[pc]:[\w-]{1,48}$/.test(target) || !VID.test(vid)) return bad("参数不对");
    const now = Date.now(), h = (this.hits.get(ip) || []).filter(t => t > now - 60e3); h.push(now); this.hits.set(ip, h);
    if (h.length > 120) return bad("点得太快了", 429);
    if (b.on) this.sql.exec(`INSERT OR IGNORE INTO likes(target, vid, ts) VALUES (?,?,?)`, target, vid, now);
    else this.sql.exec(`DELETE FROM likes WHERE target = ? AND vid = ?`, target, vid);
    return json({ likes: this.count(target), liked: this.has(target, vid) });
  }

  async remove(req, url) {
    if (!(await this.isOwner(req))) return bad("没有权限", 403);
    const id = url.searchParams.get("id") || "";
    const ids = [id, ...this.sql.exec(`SELECT id FROM comments WHERE parent = ?`, id).toArray().map(r => r.id)];
    ids.forEach(x => { this.sql.exec(`DELETE FROM comments WHERE id = ?`, x); this.sql.exec(`DELETE FROM likes WHERE target = ?`, "c:" + x); });
    return json({ removed: ids.length });
  }

  /* ---------- 共享城市 ---------- */
  cityRev() { return this.sql.exec(`SELECT COALESCE(MAX(rev), 0) AS r FROM city_log`).one().r; }
  cityGet(since) {
    const rows = this.sql.exec(since ? `SELECT k, v FROM city_kv WHERE rev > ?` : `SELECT k, v FROM city_kv WHERE v IS NOT NULL AND rev > ?`, since).toArray();
    return json({ rev: this.cityRev(), ch: rows.map(r => [r.k, r.v]) });
  }
  /* 写入一批记录（值没变的跳过），每条记一行日志 */
  cityWrite(set, ip) {
    let rev = this.cityRev(); const now = Date.now(); let n = 0;
    set.forEach(([k, v]) => {
      const old = this.sql.exec(`SELECT v FROM city_kv WHERE k = ?`, k).toArray()[0], ov = old ? old.v : null;
      if (ov === v) return;
      rev++; n++;
      this.sql.exec(`INSERT INTO city_log(rev, k, old, new, ts, ip) VALUES (?,?,?,?,?,?)`, rev, k, ov, v, now, ip);
      this.sql.exec(`INSERT INTO city_kv(k, v, rev) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, rev = excluded.rev`, k, v, rev);
    });
    return n;
  }
  async cityPost(req) {
    const b = await req.json().catch(() => ({})), ip = await ipKey(req), now = Date.now();
    const set = citySet(b.set, 3000); if (!set) return bad("参数不对");
    if (!this.cityRev()) return bad("共享城市还没建立", 409);
    /* 限流：同一来源 1 分钟最多 40 次提交、2000 条改动 */
    const h = (this.hits.get("c:" + ip) || []).filter(t => t > now - 60e3); h.push(now); this.hits.set("c:" + ip, h);
    const recent = this.sql.exec(`SELECT COUNT(*) AS n FROM city_log WHERE ip = ? AND ts > ?`, ip, now - 60e3).one().n;
    if (h.length > 40 || recent + set.length > 2000) return bad("改得太快了，稍后再试", 429);
    this.cityWrite(set, ip);
    return this.cityGet(+b.since || 0);
  }
  async cityReset(req) {
    if (!(await this.isOwner(req))) return bad("没有权限", 403);
    const b = await req.json().catch(() => ({})), set = citySet(b.set, 200000); if (!set) return bad("参数不对");
    const keep = new Set(set.map(x => x[0]));
    const gone = this.sql.exec(`SELECT k FROM city_kv WHERE v IS NOT NULL`).toArray().filter(r => !keep.has(r.k)).map(r => [r.k, null]);
    this.cityWrite([...gone, ...set], "owner");
    return this.cityGet(+b.since || 0);
  }
  async cityRollback(req) {
    if (!(await this.isOwner(req))) return bad("没有权限", 403);
    const b = await req.json().catch(() => ({})), to = +b.to; if (!(to > 0)) return bad("参数不对");
    /* 每条记录取 to 之后第一次改动前的值 */
    const rows = this.sql.exec(`SELECT k, old FROM city_log WHERE ts > ? ORDER BY rev`, to).toArray(), first = new Map();
    rows.forEach(r => { if (!first.has(r.k)) first.set(r.k, r.old); });
    const n = this.cityWrite([...first], "rollback");
    return json({ reverted: n, rev: this.cityRev() });
  }

  count(target) { return this.sql.exec(`SELECT COUNT(*) AS n FROM likes WHERE target = ?`, target).one().n; }
  has(target, vid) { return this.sql.exec(`SELECT 1 FROM likes WHERE target = ? AND vid = ?`, target, vid).toArray().length > 0; }

  /* 站主校验：令牌对仓库有写权限（问 GitHub，结果缓存 10 分钟） */
  async isOwner(req) {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.get("Authorization") || ""); if (!m) return false;
    const key = await sha(m[1]), until = this.owners.get(key);
    if (until && until > Date.now()) return true;
    const r = await fetch("https://api.github.com/repos/" + REPO, { headers: { Authorization: "Bearer " + m[1], Accept: "application/vnd.github+json", "User-Agent": "knowledge-base-social" } }).catch(() => null);
    const ok = !!(r && r.ok && (await r.json()).permissions?.push);
    if (ok) this.owners.set(key, Date.now() + 600e3);
    return ok;
  }
}

/* 城市记录校验：键是「类型:坐标」，值是 JSON 文本（null = 删除） */
const CITY_KEY = /^(?:[ctr]:-?\d{1,4},-?\d{1,4}|b:-?\d{1,4}(?:\.\d{1,4})?,-?\d{1,4}(?:\.\d{1,4})?,-?\d{1,4}(?:\.\d{1,4})?|g:-?\d{1,4}(?:,-?\d{1,4}){5}|m:(?:wv|world))$/;
function citySet(a, max) {
  if (!Array.isArray(a) || a.length > max) return null;
  const out = [];
  for (const x of a) {
    if (!Array.isArray(x) || typeof x[0] !== "string" || !CITY_KEY.test(x[0])) return null;
    const v = x[1] == null ? null : String(x[1]);
    if (v != null) { if (v.length > 32000) return null; try { JSON.parse(v); } catch (e) { return null; } }
    out.push([x[0], v]);
  }
  return out;
}
async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/* 来源标识：只存 IP 的摘要（不存原始 IP） */
async function ipKey(req) { return (await sha("kb-social|" + (req.headers.get("CF-Connecting-IP") || "local"))).slice(0, 20); }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.headers.get("Origin") && new URL(req.headers.get("Origin")).host !== url.host) return bad("forbidden", 403);   // 只接受本站页面发来的写请求
      return env.SOCIAL.get(env.SOCIAL.idFromName("main")).fetch(req);
    }
    return env.ASSETS.fetch(req);
  }
};
