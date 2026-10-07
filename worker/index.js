/* 社交后端：评论（含回复）与点赞，所有访客共享。
   部署在同一个 Cloudflare Worker 上：/api/* 走这里，其余仍是静态网页（wrangler.toml 的 run_worker_first）。
   数据存在一个 Durable Object（自带 SQLite，免费版可用，部署时自动创建，不需要在后台建数据库）。

   GET    /api/social?ids=a,b&vid=…     各条动态的点赞数、我是否赞过、评论列表
   POST   /api/comment  {post,parent,nick,site,text,vid}   发评论 / 回复（site 可不填；带站主令牌时标记为作者）
   POST   /api/like     {target:"p:<动态>"|"c:<评论>", vid, on}
   DELETE /api/comment?id=…            删除评论及其回复（需站主 GitHub 令牌） */
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
