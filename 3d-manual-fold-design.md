# 手动指定折线（Manual Fold Override）设计

> 目标：在自动折叠结果之上，让用户手动纠正「根面板 / 铰链 / 折向 / 角度」。
> 前提：**自动打底 + 用户改**，不是从零手动建树。默认直接吃 Dijkstra 结果，用户只改看着别扭的那几条。
> 状态：**S1–S4 全部完成并实测通过（2026-09-01，v42）**。S3（铰链指定）/ S4（角度）已落地，另完成一轮 3D 交互优化（资源泄漏修复 + 惯性滑行 + 视角复位统一）。

## 已完成（S1 + S2）

- 上一个会话（v40）已完成：`Preview3D.resolveFaces`（2D/3D 面板路径统一）、面板填充层渲染（`_drawPanels`）、面板点选（含拖拽防误触 `_dragDist>4`）、`selectPanel` 状态。
- 本会话（v41）补齐：
  - renderer.js：压痕线 `data-idx` + `onCreaseClick/onCreaseHover`（S3 基础设施）、`setPanelMarks`（root 绿 / flip 琥珀）、`setCreaseHighlight`
  - app.js：`FoldOv` 存储模块（localStorage `packmage.foldov.<boxId>`，全参数指纹，不匹配即作废并提示）、`selectCrease`、`setFoldRoot`/`toggleFoldFlip`/`clearFoldOv`、`_foldOvMap`（几何点 → 面板 key，最小包含面板胜出）、`renderFoldOvList`（含逐项删除）、`chkPanels` 开关
  - preview3d.js：`Preview3D._overrides` 读取——root 覆盖跳过全部根启发式（含 `_rootBy='crease'` 与 `_pickRootByFit`）；flip 在 `sign` 计算后取反
  - index.html / style.css：「折叠调整（手动）」侧栏区 + 全部样式

### 实测结论（JP012，全部通过）

| 验证项 | 结果 |
|---|---|
| 存储写入 / 读取 / 指纹 | localStorage 含 {v,boxId,fp,items}，fp 为全参数串 |
| 设根 F5 | 树根 F3 → **F5**，清除后回 F3，零残留 |
| 翻转 F1 折向 | `_hinges` 中 sign 1 → **-1** |
| 2D 标记 | panel-root=1 / panel-flip=1（绿/琥珀可见，截图确认） |
| 清除 | localStorage 置 null、`_overrides`=null，回纯自动 |
| 无覆盖回归 | `_overrides=null` 时全部跳过，走 v40 原路径 |

**踩坑**：`setPanelMarks` 最初放在 `renderer.render()` 之前——render 重建整个 SVG，标记被清掉。必须在 render 之后调用（与 `setPanelHighlight` 同一位置）。

**环境**：agent-browser daemon 在本机不稳定，页面每隔一两分钟被重置为 about:blank。**每次测试必须「open + wait + 单次大 eval」一条链完成**，eval 之间共享状态的写法不可靠。

---

## 已完成（S3 + S4，v42）

### S3 铰链指定（三种入口）

| 入口 | 操作 | 存储 |
|---|---|---|
| 线→铰链 | 点压痕线 → 「线→铰链」 | `{t:'hinge', g:[x1,y1,x2,y2], k}`（线的最长直线段） |
| 线→禁止折叠 | 点压痕线 → 「线→禁止折叠」 | `{t:'nofold', g, k}` |
| 两板连铰链 | 选面板A → 「两板连铰链」→ 选面板B | 两 bbox 最长共享边（容差 2mm） |

- 3D 端 `_ovHinges` 在**孤岛 seeding 之后**注入（支持把整座孤岛吸收进主树），`_ovWouldCycle` 沿 parent 链上溯防闭合环，`delete staticHinge[child]` 让用户显式铰链压过「无压痕线冻结」。
- `_ovNofolds` 在 allPairs 评分前过滤 + Pass2/Pass2b rescue 两处二次检查（rescue 自建 overlap 不走 allPairs）。
- `_ovRootKey` 声明块扩展读 hinges/nofolds/angles；`_pickRootByFit` 条件加 `!_ovHinges.length`。

### S4 折叠角度

- 面板选中 → 「角度 180°/0°」循环：180° → 0° → 默认。
- 存储 `{t:'angle', p, deg, k}`，`_foldOvMap` 映射 `deg===180 ? 2 : 0`（foldMult）。
- 3D 端在安全阀之后 `if (_ovAngles[key] != null) foldMult = _ovAngles[key];` —— 用户显式角度压过 static-hinge 冻结与 `_useValve`。

### 关键修复：`_panelNear` 包含优先

配对面板时，共享边外侧探针落在**小面板**（F4）bbox 内、距大面板（F3）1.5mm，原实现按「距离最近」选面板，结果两侧都命中 F4，配对失败。修复为**严格包含优先**（最小包含面板胜出），包含不到才按 2mm 容差距离兜底。

### 实测结论（JP012，全部通过）

| 验证项 | 结果 |
|---|---|
| S4 角度循环 180→0→删除 | foldMult 2 / 0 / 移除 |
| S4 角度 3D 生效 | foldMult=2 |
| S3 线→铰链（crease 解析两侧面板） | F9→F0 |
| S3 线→铰链 3D + localStorage | parent=F9，持久化含 4 元几何 g |
| S3 线→禁止折叠 | bans=["F0\|F9"] |
| S3 禁止折叠 3D 生效 | 该对铰链消失（hinges 12→11） |
| S3 两板连铰链（共享边） | F3→F4 |
| 无覆盖回归 | `_overrides=null`，走纯自动 |

---

## 3D 交互优化（v42 同期）

| 项 | 问题 | 修复 |
|---|---|---|
| 资源泄漏 | `render3D` 每次重建 WebGLRenderer + RAF + window 监听，旧的从不 dispose/清理 | `_buildThree` 开头先 `_cleanup`（dispose renderer、cancel RAF、移除 mousemove/mouseup/resize 监听） |
| 旋转无惯性 | 释放即停，手感生硬 | 鼠标速度 EMA 平滑 + `animate()` 循环里 0.94/帧阻尼衰减，甩动后滑行至停 |
| 视角复位漂移 | 初始 `-0.35`，`_viewReset` 却是 `-0.55` | 抽 `HOME_ROTX/HOME_ROTY` 常量，初始与复位统一 |
| 仅左键旋转 | — | 明确只接受主键，避免与其它手势冲突 |

**实测**：重复 render3D 5 次，RAF id 递增（旧的被 cancel）、renderer/handler 各 1 份无堆积；切回 2D 全部清空。惯性释放后 rx 35→73→80 持续滑行并收敛（80° 为 rotX clamp 上限）。

---

## 1. 边界

**做**：根面板指定、铰链指定、折叠方向翻转、折叠角度。
**不做**：工序顺序（stage）—— 只影响折叠动画先后，与成型尺寸无关，视觉上几乎看不出差别，但现有 `vDepth` + 压痕方向的逻辑很绕，性价比极低。
**不做**：全手动建树 —— 40 面板的盒型要点几百次，没有人会用。

---

## 2. 数据模型

```js
// localStorage key: packmage.foldov.<boxId>
{
  v: 1,
  boxId: 'N001',
  fp: 'L200-W150-D50',          // 尺寸指纹，参数一变就整体失效
  items: [
    { t: 'root',   p: [x, y] },                  // 设为固定面，存面板内一点
    { t: 'hinge',  g: [x1,y1,x2,y2] },           // 强制铰链，存压痕线几何
    { t: 'nofold', g: [x1,y1,x2,y2] },           // 禁止这条边成为铰链
    { t: 'flip',   g: [x1,y1,x2,y2] },           // 翻转折向
    { t: 'angle',  g: [x1,y1,x2,y2], deg: 180 }  // 折叠角度
  ]
}
```

### 为什么存几何不存索引

改 L/W/D 后 `fe` 重算，第 7 条线会变成完全不同的东西。索引存储在这个场景下必然串位。

- `fp` 指纹 = `L/W/D` 拼串。不匹配 → 整份覆盖作废（并提示用户），不做模糊匹配。
- 几何项回查用**最近邻**：存的线段与当前 `creases[]` 逐条比对，取中点距离 < 3mm 且方向夹角 < 10° 的。找不到 → 该项静默忽略。

---

## 3. 四个台阶

### S1 基础设施（~150 行）

| 文件 | 改动 |
|---|---|
| `preview3d.js` | 末尾加 `Preview3D.extractPanelsRaster = extractPanelsRaster;`（file-scope 函数，2D 侧调不到） |
| `renderer.js` | 新增 `_drawPanelLayer(panels)`：半透明填充 + `<polygon data-pidx=N>`；`initInteraction` 里加点击/悬停（**注意与现有 pan 拖拽冲突**：mousedown→mouseup 位移 < 4px 才算点击） |
| `app.js` | `render2D` 里调 `extractPanelsRaster` 拿面板；新增侧栏「折叠调整」面板：列出当前覆盖项 + 逐项删除 + 一键清空 |
| `preview3d.js` | 建树入口读 `Preview3D._overrides` |

**副产品（强烈建议做）**：面板填充层让「系统把刀模切成了几块」变成肉眼可见。N001 那种端墙被 21mm 废料带拦腰截断的问题，以前要跑诊断脚本才知道，以后看图就知道。**这同时也是 S2/S3 的前提——点面板得先有面板可点。**

### S2 根面板 + 折向（~80 行）

- `t:'root'` → 找到包含点 `p` 的面板，在 `growTree(root)` 前替换 `root`（跳过 `_pickRootByFit` 那段）
- `t:'flip'` → 在 `_hinges.push` 前把 `sign` 取反
- UI：点面板 → 「设为固定面」；点铰链 → 「翻转方向」

### S3 铰链指定（~120 行）

两种入口，共用 `creaseAdjacency()` 的产出：

1. **点一条压痕线** → 沿该线采样找两侧面板 → 产出 `{a, b, ov}`
2. **点面板 A 再点面板 B** → 取两者最长共享边

强制写入 `parentOf[k] / hingeOf[k]`，在 Dijkstra 之后、rescue pass 之前执行，并标记 `vis[k]=true` 让 rescue 不再覆盖。

`t:'nofold'` 反向操作：从 `allPairs` 里剔除该 pair，让它只能走 rescue 兜底。

### S4 折叠角度（~40 行）

`t:'angle'` → 覆写 `foldMult`。90° = 1，180° = 2，其余按 `deg/90`。

---

## 4. 关键技术决策

**3D 重渲染不用改接口。** `Preview3D.render()` 每次全量重建，加一个 `Preview3D._overrides` 让建树阶段读一下即可，`app.js` 的 `render3D()` 几乎不动。

**与自动逻辑是「覆盖」而非「替换」。** 用户没标记的地方完全走原路径，已标记的地方才插手。这样：
- 新盒型不受影响（没有覆盖项 = 纯自动）
- 自动算法后续改进不会与手动结果冲突
- 用户可以只改一条铰链，其余 38 条照旧

**面板数据来源统一。** 2D 和 3D 都调 `extractPanelsRaster`，保证用户点的面板和 3D 里折叠的是同一块。注意 3D 侧有 raster / rect / de.Face 三条路径（preview3d.js:2169 起），S1 阶段 2D 侧固定用 raster 路径即可，若与 3D 实际使用的路径不一致，命中会错位——**这一条开工时必须先验证**。

---

## 5. 风险

| 风险 | 处理 |
|---|---|
| 2D 面板路径与 3D 实际路径不一致 | 开工第一步先验证，不一致就在 3D 侧暴露实际使用的 polys |
| 点击与 pan 拖拽冲突 | 位移阈值 4px |
| 参数改动后覆盖静默失效 | 指纹不匹配时侧栏显式提示，不静默 |
| 面板填充层遮挡线条 | 填充置于 cut/crease 组之下，透明度 ≤ 0.12 |
| S3 强制铰链造出非法树 | 加环检测，成环则拒绝并提示 |

---

## 6. 验收样本

- **N001**：点端墙那两片 → 「合并为固定面」，或直接指定铰链，看是否出 199×48 完整端墙
- **C023 / JP012 / Q013**：折叠误差分别 63% / 42% / 20%，用 S2 换根节点看是否下降
- **回归**：`_diag_size3.js` + `_diag_size_off.js` 两个样本（i+=43 与 i=3）跑一遍，确保无覆盖时结果零变化
