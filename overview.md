# GitHub Pages 尺寸调整修复

## 问题
本地环境尺寸调整正常，但部署到 GitHub Pages 后失效。

## 根因
GitHub Pages 是纯静态文件托管，**无法运行 Node.js 服务器**（server.js）。前端的 `/api/box` 请求在 GitHub Pages 上直接 404，导致 packmage.cn API 调用失败，尺寸参数变化后刀模图无法更新。

同时测试确认 packmage.cn API **不支持 CORS**（响应头无 `Access-Control-Allow-Origin`），浏览器无法直接跨域调用。

## 解决方案：Cloudflare Worker API 代理

### 新增文件
- **worker.js** — Cloudflare Worker 脚本，代理 packmage.cn API（移植 server.js 的 callPackmageAPI 逻辑）
- **config.js** — 环境检测：localhost 用 `/api/box`（server.js），GitHub Pages 用 Worker URL

### 修改文件
- **packmage_boxtypes.js** — `xhr.open('POST', '/api/box')` → `DiecutConfig.apiBase`
- **preview3d.js** — 同上
- **index.html** — 在所有脚本前加载 `config.js`
- **app.js** — API 回调后加 `renderer.fit()`，清理调试代码
- **server.js** — 添加 `Cache-Control: no-cache` 头

## 部署步骤（2分钟）

### 第1步：部署 Cloudflare Worker
1. 登录 https://dash.cloudflare.com
2. 左侧菜单选 **Workers & Pages**
3. 点 **Create** → **Create Worker**
4. 名字填 `diecut-api`，点 **Deploy**
5. 点 **Edit code**，把 `worker.js` 的全部内容粘贴进去
6. 点 **Deploy** 保存
7. 记下 Worker URL（格式：`https://diecut-api.<你的子域名>.workers.dev`）

### 第2步：更新 config.js
把 `config.js` 中的 `PRODUCTION_API_URL` 改成你的 Worker URL：
```js
var PRODUCTION_API_URL = 'https://diecut-api.你的子域名.workers.dev/api/box';
```

### 第3步：提交推送
```bash
git add config.js && git commit -m "update worker url" && git push
```

### 第4步：验证
打开 GitHub Pages 页面，切到 Parameters 标签改 L/W/D，等1~2秒刀模图应自动更新。

## 技术架构
```
浏览器 (GitHub Pages)
  ↓ POST DiecutConfig.apiBase
  ↓
Cloudflare Worker (worker.js)
  ↓ POST + headers (Referer/Origin/UA)
  ↓
packmage.cn API
  ↓ JSON (嵌套多层)
  ↓
Worker 解析+转换 → 返回标准化 JSON
  ↓
浏览器渲染 SVG
```
