# 秋渡的空间

个人网站：动态 / 知识库 / 收藏，右下角一座可以搭建的线条城市。纯静态页面，部署在 Cloudflare Workers（`wrangler.toml`）。

## 文件

- `index.html` —— 整个网站（样式、页面逻辑、编辑器）
- `data.json` —— 网站内容（动态、知识库、收藏、照片、联系方式、发布的城市）
- `assets/city.js` —— 线条城市（three.js，`assets/vendor/`）
- `assets/photos/` 照片，`assets/sky/` 云海背景，`assets/emoji/` 表情

## 编辑与发布

1. 打开 `网址/#edit`，填入对本仓库有 Contents 写权限的 GitHub 令牌解锁编辑（只存本机浏览器）。
2. 编辑后点「发布到线上」，内容写回 `data.json`，约 1 分钟后网站更新。

访客的点赞、评论和城市改动只保存在他们自己的浏览器里。
