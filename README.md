# DieCut Designer

刀模设计器——在线浏览、参数化调整、实时预览并导出工业级刀模图。

线上地址：http://057300.xyz/diecut/

---

## 项目简介

DieCut Designer 是一个纯前端（无框架）的刀模设计工具，内置 千余种 种标准纸盒盒型。用户可以通过改变长 / 宽 / 高等参数，实时生成对应的刀线（裁切）与压线（折痕）展开图，并一键导出为 SVG / DXF / PDF 三种格式，直接对接打样、模切与 CAD 流程。

核心数据流：参数变化 → 防抖 → 调用 Packmage API 计算几何 → 前端渲染 SVG 刀模图 → 导出。

---

## 功能特性

- **完整盒型库（1278 种）**：覆盖 FEFCO / 卡纸盒 / 礼盒 / 异形盒等，支持关键词与盒型 ID 搜索，按分类浏览。
- **参数化实时调整**：修改长（L）、宽（W）、高（D）等参数后，刀模图在 1~2 秒内自动重算并刷新，自动适配视图。
- **专业刀模渲染**：
  - 刀线（裁切）红色实线，压线（折痕）蓝色虚线，符合印前规范。
  - 坐标单位为毫米（mm），可直接用于生产。
  - 支持尺寸标注（Dimensions）、网格（Grid）、部件标签（Labels）独立开关。
- **画布交互**：滚轮缩放、拖拽平移、双击适配视图，以及 1:1 / FIT 快捷按钮，缩放比例实时显示。
- **多种导出格式**：
  - **SVG**：矢量，分层（cut-lines / crease-lines），适合网页与矢量编辑。
  - **DXF**：R12 格式，CUT / CREASE 分层，直接导入 AutoCAD 等 CAD 软件。
  - **PDF**：矢量 PDF，1mm = 2.8346pt，可直接打印或交付。
- **纸张厚度补偿（Compensation）**：可选 0.3 ~ 3.0mm 厚度，自动修正压线位置（考虑纸板反弹量）。
- **3D 折盒预览**：基于 Three.js（WebGL）渲染折叠后的 3D 纸盒，支持鼠标旋转 / 缩放；Three.js 不可用时回退到轻量方案。
- **派生参数显示**：实时计算并展示表面积、体积等相关数据。

---

## 技术架构

| 模块 | 文件 | 职责 |
|------|------|------|
| 主应用逻辑 | `app.js` | 状态管理、UI 事件、参数面板、盒型选择、渲染调度 |
| 盒型数据 | `packmage_data.js` | 1278 种盒型的完整数据（约 6.7MB） |
| 盒型逻辑 | `packmage_boxtypes.js` | 参数构建（buildInPms）、API 调用、几何数据转换（fe → cuts/creases） |
| 渲染引擎 | `renderer.js` | SVG 绘制（刀线 / 压线 / 标注 / 网格）、缩放平移（pan/zoom） |
| 3D 预览 | `preview3d.js` | Three.js WebGL 折盒渲染与交互 |
| 导出 | `exporter.js` | SVG / DXF / PDF 生成与下载 |
| 环境配置 | `config.js` | API 地址切换（本地 `/api/box` vs 线上同源代理） |
| 本地代理 | `server.js` | 本地 Node 服务器 + Packmage API 代理 |
| 线上代理 | `worker.js` | Cloudflare Worker —— 线上 API 代理（经 Worker Route 同源部署） |
| 样式 | `style.css` | 响应式布局、深色 / 浅色主题 |

**技术栈**：原生 HTML + CSS + JavaScript（无前端框架），SVG 渲染，Three.js（3D），Cloudflare Workers（线上 API 代理），GitHub Pages（静态托管）。

**为什么需要 API 代理**： API 不支持浏览器跨域（CORS），因此前端不能直接调用，必须通过同源代理转发请求。本地用 `server.js`，线上用 Cloudflare Worker。

---

## 目录结构

```
diecut/
├── index.html              # 主页面
├── style.css               # 样式
├── app.js                  # 主逻辑
├── packme_data.js          # 盒型数据库（1278 种）
├── packme_boxtypes.js      # 盒型参数与 API 逻辑
├── renderer.js             # SVG 渲染引擎
├── preview3d.js            # 3D 预览
├── exporter.js             # 导出（SVG/DXF/PDF）
├── config.js               # 环境配置（API 地址）
├── server.js               # 本地开发服务器 + API 代理
├── worker.js               # Cloudflare Worker（线上 API 代理）
└── wrangler.toml           # Worker 部署配置
```

---

## 快速开始

### 本地运行

```bash
# 需要 Node.js
node server.js
# 打开浏览器访问 http://localhost:8093
```

本地模式由 `server.js` 同时托管静态文件并代理 `/api/box` 请求，无需额外配置。

### 线上访问

直接打开 http://057300.xyz/diecut/ 即可使用（API 经 Cloudflare Worker Route 同源代理，已配置完成）。

---

## 使用指南

1. **选择盒型**：在左侧 Box Library 搜索或浏览分类，点击任一盒型载入。
2. **调整参数**：切到 Parameters 标签，拖动 L / W / D 等滑块，刀模图会实时更新。
   - 修改参数后需等待约 1~2 秒（含防抖与 API 计算延迟）。
   - 点 Reset 可恢复默认参数。
3. **视图操作**：在画布上滚轮缩放、拖拽平移、双击适配；或用右侧 Zoom 控件（+/−/FIT/1:1）。
4. **显示开关**：Dimensions（尺寸标注）、Grid（网格）、Labels（部件标签）可分别开关。
5. **厚度补偿**：顶部 Compensation 勾选后选择纸板厚度，压线位置会自动修正。
6. **导出**：点击顶部 SVG / DXF / PDF 按钮，浏览器自动下载对应文件。

---

## 导出格式说明

| 格式 | 用途 | 图层 / 样式 |
|------|------|------------|
| SVG | 矢量编辑、网页 | cut-lines（红实线）/ crease-lines（蓝虚线），单位 mm |
| DXF | CAD（AutoCAD 等） | CUT 层（实线）/ CREASE 层（虚线），R12 格式 |
| PDF | 打印、交付 | 矢量，1mm = 2.8346pt，红刀线 / 蓝压线 |

所有导出均为矢量，坐标单位为毫米，刀线与压线分色分图层，便于后续模切与印刷流程。

---

## 部署说明

### 静态托管（GitHub Pages）

项目为纯静态站点，由 GitHub Actions（`.github/workflows/deploy.yml`）自动部署到 GitHub Pages，并绑定自定义域名 `057300.xyz`。


## 已知约束

- 参数需在 Packme允许的合理范围内，超出范围时 API 会返回默认几何数据并提示。
- 首次访问需加载约 6.7MB 的盒型数据文件，建议保持网络畅通；浏览器会缓存该文件。
- 3D 预览依赖 Three.js CDN，弱网环境下可能回退到基础预览。
