# DieCut Designer

刀模设计器——在线浏览、参数化调整、实时预览并导出工业级刀模图。

线上地址：https://057300.xyz/diecut/

---

## 项目简介

DieCut Designer 是一个纯前端（无框架）的刀模设计工具，内置 1293 种标准纸盒盒型。用户可以通过改变长 / 宽 / 高等参数，实时生成对应的刀线（裁切）与压线（折痕）展开图，并一键导出为 SVG / DXF / PDF / PNG 格式，直接对接打样、模切与 CAD 流程。

核心数据流：参数变化 → 防抖 → 调用上游 Packmage API 重算几何 → 前端渲染 SVG 刀模图 / 折叠 3D → 导出。

---

## 功能特性

- **完整盒型库（1293 种）**：覆盖 FEFCO / 卡纸盒 / 礼盒 / 异形盒等，支持关键词与盒型 ID 搜索，按分类浏览。
- **参数化实时调整**：修改长 / 宽 / 高以及其他参数后自动重算（约 0.7 秒防抖），无需手动提交；也可点「重新计算刀模」立即触发。
- **三种尺寸基准**：制造尺寸 / 内尺寸 / 外尺寸可切换填写，并支持自定义基准。
- **专业刀模渲染**：
  - 刀线（裁切）红色实线，压线（折痕）蓝色虚线，符合印前规范。
  - 坐标单位为毫米（mm），可直接用于生产。
  - 标注分级可控：**主尺寸**（橙，长 / 宽 / 高）与**其他参数**（绿，圆角 / 插舌 / 锁扣等）可分别开关；标注文字可在「数值 / 代码 / 代码=数值」间切换；整图的展开宽高标注可单独隐藏。
- **画布交互**：滚轮缩放、拖拽平移，配合 − / + / 适应 按钮，缩放比例实时显示。
- **多种导出格式**：
  - **SVG**：矢量，分层（cut-lines / crease-lines），适合网页与矢量编辑。
  - **DXF**：R12 格式，CUT / CREASE 分层，直接导入 AutoCAD 等 CAD 软件。
  - **PDF**：矢量 PDF，1mm = 2.8346pt，可直接打印或交付。
  - **PNG**：展开图高清位图（2400px），适合汇报与贴图。
- **纸张厚度补偿**：设置纸板厚度后重算，压线位置自动修正；可调范围由盒型本身决定，界面会显示该盒型允许的区间。
- **3D 折盒预览**：基于 Three.js（WebGL）渲染折叠后的立体盒，左键旋转 / 中键平移 / 滚轮缩放；无折叠树的盒型自动退回 2D 展开图。
- **实时统计底栏**：显示展开尺寸、切割线 / 压痕线条数、图上标注取值；切到 3D 时改为显示折叠后尺寸、面板数、铰链数与折叠结构来源。

---

## 技术架构

| 模块 | 文件 | 职责 |
|------|------|------|
| 公共运行时 | `assets/common.js` | `V2` 命名空间：盒型目录 / 几何访问、盒型显示名净化、通用工具与卡片渲染 |
| 列表页 | `assets/list.js` | 首页盒型库：按需分块加载目录，搜索、分类筛选、分页 |
| 详情页 | `assets/detail.js` | 参数面板（主尺寸 + 其他参数）、改动防抖 + 串行重求解、SVG 刀模渲染、缩放平移、重置 |
| 导出 | `assets/export.js` | SVG（分图层）、DXF（R12）、PDF（1:1 物理尺寸） |
| 3D 预览 | `assets/view3d.js` | Three.js 折盒渲染，按需动态加载（不点不下载） |
| 样式 | `assets/style.css` | 响应式布局、深色 / 浅色主题 |
| 本地代理 | `server.js` | 本地静态托管 + Packmage API 代理（端口 8093） |
| 线上代理 | `worker.js` | Cloudflare Worker，线上同源 `/api/*` 代理 |

**技术栈**：原生 HTML + CSS + JavaScript（无前端框架），SVG 渲染，Three.js（3D），Cloudflare Workers（线上 API 代理），GitHub Pages（静态托管）。

**为什么需要 API 代理**：Packmage API 不支持浏览器跨域（CORS），前端不能直接调用，必须经同源代理转发。本地用 `server.js`，线上用 Cloudflare Worker。

**数据与构建链**（`data/`、`box/` 均为生成物，请改生成器而非手改单文件）：

| 环节 | 文件 | 说明 |
|------|------|------|
| 盒型清单 | `packmage_boxlib_zh.min.js` | 上游盒型名录 |
| 抓取 | `download_all_boxes.js` | 逐盒拉取参数与几何，产出 `packmage_data.js` |
| 编译 | `build_v2.js` | 产出 `data/catalog.js` 与 `data/geo/NN.js`（13 片） |
| 页面生成 | `build_box_pages.js` | 产出 `box/<ID>/index.html`、`sitemap.xml`，并回写首页 SEO 计数 |

---

## 目录结构

```
057300.xyz/diecut/            # 仓库根即站点根
├── index.html                # 盒型库列表页（SEO 计数由生成器回写）
├── box.html                  # 盒型详情页（?id=<盒型ID>，noindex）
├── robots.txt / sitemap.xml  # SEO（sitemap 由生成器产出）
├── favicon.ico / favicon.svg # 站点图标（`node tools/make-favicon.mjs` 生成）
├── assets/                   # 前端运行时
│   ├── common.js             # V2 公共运行时
│   ├── list.js               # 列表页逻辑
│   ├── detail.js             # 详情页主逻辑
│   ├── export.js             # SVG / DXF / PDF 导出
│   ├── view3d.js             # 3D 预览（懒加载）
│   ├── style.css             # 样式
│   ├── mat/                  # 纸材质贴图
│   └── vendor/three/         # Three.js 本地副本
├── data/                     # ← 生成物：站点数据
│   ├── catalog.js            # 列表索引（分块目录）
│   ├── geo/NN.js             # 几何分片 ×13
│   ├── thumbs/               # 立体缩略图
│   └── 3d/<ID>.json          # 折叠树 ×1218
├── box/<ID>/index.html       # ← 生成物：每盒型静态页（供搜索引擎收录）
├── server.js                 # 本地服务器 + API 代理（8093）
├── worker.js                 # 线上 Cloudflare Worker 代理
├── wrangler.toml             # Worker 配置（本项目部署不走 wrangler）
├── download_all_boxes.js     # 生成器：抓取上游参数与几何
├── build_v2.js               # 生成器：编译 data/
├── build_box_pages.js        # 生成器：生成 box/ + sitemap.xml
├── sync_boxlib.js            # 上游盒型库同步
├── packmage_data.js          # 生成物：抓取中间数据
├── packmage_boxlib_zh.min.js # 上游盒型名录
├── tools/                    # 开发工具
│   ├── install-hooks.mjs     # 安装 pre-push 钩子
│   ├── hooks/pre-push.mjs    # 推送即部署 Worker + 校验资源版本串
│   ├── bump-assets.mjs       # 写静态资源缓存版本串 ?v=<内容哈希>
│   ├── make-favicon.mjs      # 生成 favicon.ico / favicon.svg
│   └── fetch_thumbs.py       # 缩略图抓取
├── v1/                       # 已废弃的自研 3D 折叠路线（保留备查）
├── FEFCO/                    # FEFCO 盒型参考资料
└── screenshots/              # 截图素材
```

> `_` 前缀的临时脚本与 `_backup_*` 目录均不入库（`.gitignore` 整类忽略）。

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

直接打开 https://057300.xyz/diecut/ 即可使用（API 经 Cloudflare Worker Route 同源代理，已配置完成）。

---

## 使用指南

1. **选择盒型**：首页盒型库支持关键词与盒型 ID 搜索、分类浏览；点进任一盒型打开详情页（`box.html?id=<盒型ID>`）。
2. **调整尺寸**：在「尺寸与参数」面板填写长 / 宽 / 高，尺寸基准可在 **制造尺寸 / 内尺寸 / 外尺寸** 之间切换，也支持自定义。
   - 主尺寸之外的项收在「其他参数」里，展开即可调整（原先按参数层级分组的多段列表已合并为单一列表）。
   - 改完无需手动提交：约 0.7 秒防抖后自动重算；也可点「重新计算刀模」立即触发。
   - 某个参数能否真正影响几何，取决于该盒型是否把它纳入求解参数（`op`）——未纳入的项改了尺寸也不变。
   - 越界值会被盒型规则**钳制或重算**（详见「已知约束」），重算后输入框会自动显示实际生效的值。
   - 点「重置」恢复该盒型**首次载入时**的默认值（不是上一次改动的值）。
3. **视图操作**：`2D 展开图` / `3D 立体` 标签切换。画布鼠标操作：
   - **滚轮** = 缩放（以光标位置为焦点，无需按住 Ctrl）；**Shift + 滚轮** = 横向滚动
   - **按住左键拖动** = 平移（中键同样可用）；光标显示为「可抓取」手形
   - 另配 − / + / 适应 控件，缩放比例实时显示

   标注显示可精细控制：**主尺寸**与**其他参数**分别开关，标注文字在「数值 / 代码 / 代码=数值」间切换，整图展开宽高标注可单独隐藏。
4. **厚度补偿**：设置纸板厚度后重算，压线位置按厚度自动修正。
5. **导出**：顶部导出菜单选择 SVG / DXF / PDF / PNG，浏览器自动下载。
6. **参考信息**：页面下方给出展开尺寸、三种尺寸对照、刀模规格、用途标签与同类盒型，便于选型比对。

---

## 导出格式说明

| 格式 | 用途 | 图层 / 样式 |
|------|------|------------|
| SVG | 矢量编辑、网页 | cut-lines（红实线）/ crease-lines（蓝虚线），单位 mm |
| DXF | CAD（AutoCAD 等） | CUT 层（实线）/ CREASE 层（虚线），R12 格式 |
| PDF | 打印、交付 | 矢量，1mm = 2.8346pt，红刀线 / 蓝压线 |
| PNG | 汇报、贴图 | 展开图高清位图（2400px），线宽按像素反推以保持观感一致 |

SVG / DXF / PDF 均为矢量输出、坐标单位为毫米，刀线与压线分色分图层，便于后续模切与印刷流程；PNG 为位图，仅供预览与汇报。

---

## 部署说明

### 静态托管（GitHub Pages）

项目为纯静态站点，由 GitHub Actions（`.github/workflows/deploy.yml`）自动部署到 GitHub Pages，并绑定自定义域名 `057300.xyz`。

### API 代理（Cloudflare Worker）—— 推送时自动部署

`worker.js` **不走 GitHub Actions**：Pages 的 CI 只发静态文件，动不了 Worker。
为此仓库内置了 **pre-push 钩子**——`git push` 时若推送范围里改动了 `worker.js` 或 `wrangler.toml`，
钩子会用 Cloudflare API Token 把新脚本**直接部署上线**（立即生效，没有 Pages 那种 CDN 传播窗口）。

| 场景 | 命令 |
|------|------|
| 新机器 clone 后装钩子（只需一次） | `node tools/install-hooks.mjs` |
| 看钩子状态 | `node tools/install-hooks.mjs --status` |
| 只判断不部署（自检） | `node tools/hooks/pre-push.mjs --check` |
| 手动强制部署（不改代码也想重发） | `node tools/hooks/pre-push.mjs --force` |
| 临时跳过 | `git push --no-verify` 或 `SKIP_WORKER_DEPLOY=1 git push` |

- 钩子真逻辑在 `tools/hooks/pre-push.mjs`（入库）；`.git/hooks/pre-push` 只是薄壳，由安装脚本生成
- 部署凭据在 `~/.workbuddy/cf-worker-deploy.env`（不入库）；实现细节见技能 `cloudflare-worker-deploy`
- **部署失败不阻塞推送**（静态站该上还是要上），但终端会醒目告警——此时线上 `/api/*` 仍是旧版

### 静态资源缓存版本串（`?v=`）

站点把 `*.js` / `*.css` 缓存 **4 小时**（`max-age=14400`），
而 HTML 只缓存 **10 分钟**（`max-age=600`）。两者不同步 → 发版后最长 4 小时内，
老浏览器会拿到「**新 HTML + 缓存的旧 JS**」这个错配组合。

2026-09-22 就因此崩过一次：新版 `box.html` 删掉了 `#advParams` / `#advWrap`，
而浏览器里缓存的旧 `detail.js` 仍在写这两个元素 →
`TypeError: Cannot set properties of null (setting 'innerHTML')`，
被启动链的 `catch` 写进状态栏，表现为「刀模图不显示 + 按钮下方一条报错」。

对策：按源码内容算哈希写进资源 URL，内容一变标识就变，缓存立即失效。

```bash
# 改完 assets/ 里的脚本后跑一次（写进 index.html / box.html）
node tools/bump-assets.mjs

# 只校验是否同步（exit 1 = 未同步，供钩子调用）
node tools/bump-assets.mjs --check
```

- 哈希覆盖 `assets/*.js` + `style.css` + `data/catalog.js` + `data/geo/*.js`（当前 20 个文件）
- `common.js` / `detail.js` 会把版本串**继承**给动态加载的 `catalog.js`、`geo/NN.js`、`view3d.js`，全站一次发版一起换
- **忘了跑也不会坏**：pre-push 钩子会检测到「改了脚本但 `?v=` 没同步」并醒目告警（不阻塞推送）
- 本地 `server.js` 已做 `req.url.split('?')[0]`，带版本串照样能跑

### 站点图标（favicon）

```bash
node tools/make-favicon.mjs   # → favicon.ico（16/32/48）+ favicon.svg
```

图案是等轴测立方体（呼应「展开图折成立体盒」），配色沿用刀模标注的主尺寸橙 `#de7a00`。
改图案就改 `tools/make-favicon.mjs` 里的顶点/颜色常量后重跑；它是**唯一真源**，
不要手改那两个产物文件。

> ⚠️ 站点部署在 `/diecut/` 子路径下，浏览器**只会自动请求域名根** `/favicon.ico`
> （那个位置不归我们管）。所以两个 HTML 必须**显式**写 `<link rel="icon">`，
> 光把文件放在站点目录里是不生效的。`box/<ID>/` 这类子目录页面还要多退一级
> （生成器 `build_box_pages.js` 里已写成 `../../favicon.ico`）。


## 已知约束

- **参数受盒型规则约束（在上游求解器里，不在前端）**：超出允许范围的值不会被拒绝，而是被**钳制到边界**或**按公式重算**，界面会把实际生效值回填到输入框并在状态栏说明改了几项。以 JP008（长100 / 高20 / 高2 80 / 高低位10 / 长1 95 / 高1 40 / 半径40）为例实测：

  | 参数 | 规则 | 传越界值 → 实际生效 |
  |---|---|---|
  | 长1 `l1` | ≤ 长 − 4mm | 999 → 96 |
  | 半径 `r1` | ≤ 长1 ÷ 2 | 999 → 47.5 |
  | 高 `d`、高2 `d2` | ≥ 10mm | 1 → 10 |
  | 高低位 `of` | ≤ 长 | 999 → 100 |
  | 纸厚 `cal` | ≤ 3mm | 4 → 3 |

  另外**改一个参数会连带重算关联参数**（改「长」→ 长1/半径跟着变；改「高2」→ 高1 跟着变）。这些规则**按盒型不同**，前端不做硬校验（否则会与上游不一致）：
  同一条「高低位上限」在 JP008 是 100（=长）、A036 是 3、E055 是 4；「半径上限」在 A036 是 5、E055 是 18.67；「纸厚上限」在 A036 是 20、E055 是 15。
  极端取值下上游也会算出自相矛盾的结果（E055 纸厚给 15 → 半径 −46），所以真实值一律以重算后回填的为准。
- 数据按需分块加载：列表页只取目录索引，几何分片与缩略图在进入详情页时才拉取，无需一次性下载整库。
- 3D 预览使用 Three.js 本地副本（`assets/vendor/three/`），不依赖 CDN；仅 1218 个盒型具备折叠树，其余盒型该按钮置灰并退回 2D 展开图。
- 参数改动会实时重求解几何（含「其他参数」面板内的项）；但某个参数能否真正影响几何，取决于该盒型是否把它纳入求解参数（`op`）——未纳入的项即使在界面上可输入，也不会改变尺寸。
