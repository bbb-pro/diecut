/* i18n.js — 中英词典层（英文工具页用）
 *
 * 设计要点：
 *   1. key 就是中文原文 —— 不用另造一套 key，缺词条时自动回落到中文，永不出现空白/undefined。
 *   2. 三种查询：V2.t(精确串) / V2.tPat(带数字的句子按正则替换) / V2.applyI18n(遍历 DOM 文本与
 *      title、placeholder、alt、aria-label 属性)。静态 HTML 不用改标记，动态渲染的 DOM 也会被扫到。
 *   3. 只有 <html lang> 以 en 开头时才生效；中文页加载本文件等于空转（V2.t 直接返回原文）。
 *
 * ⚠️ 术语一律用包装/刀模行业的英文标准词，不机翻：
 *    die line / die-cut layout（刀模展开图）· crease（压痕）· cut（切割）· blank / flat size（展开尺寸）
 *    manufacturing size（制造尺寸）· inner size（内尺寸）· outer size（外尺寸）
 *    caliper / board thickness（纸板厚度）· compensation（补偿）· tuck flap（插舌）· hinge（铰链）
 *    imposition（拼版）· 1:1 actual size（1:1 实际尺寸）
 */
(function () {
  var V2 = window.V2 = window.V2 || {};

  V2.LANG = /^en/i.test(document.documentElement.lang || '') ? 'en' : 'zh';
  V2.isEn = function () { return V2.LANG === 'en'; };

  /* ---------------- 精确词条：中文原文 -> 英文 ---------------- */
  var DICT = {
    /* 顶栏 / 全局 */
    '通用包装盒型库': 'Universal Box Template Library',
    '刀模展开图 · 参数化设计': 'Die-cut layouts · parametric design',
    '搜索盒型名称、编号或用途': 'Search box name, code or use',
    '搜索盒型名称、编号或用途，如「天地盖」「A038」「化妆品」': 'Search by name, code or use — e.g. "lid and base", "A038", "cosmetics"',
    '打赏': 'Tip',
    '如果这个工具帮到了你，欢迎打赏支持': 'If this tool helped you, a tip is welcome',
    '打赏收款二维码': 'Tip QR code',
    '扫码打赏 · 感谢支持': 'Scan to tip · thank you',
    '导出下载': 'Export',
    '导出刀模图：SVG / DXF / PDF / PNG': 'Export the die-cut drawing: SVG / DXF / PDF / PNG',
    '导出格式': 'Export format',
    '矢量刀模图': 'Vector die line',
    '矢量刀模图，可在 Illustrator / CorelDRAW 中编辑': 'Vector die-cut drawing, editable in Illustrator / CorelDRAW',
    '刀模厂直用': 'For die makers',
    'DXF 刀模图，刀模厂 / 激光切割可直接导入': 'DXF die-cut drawing, ready for die makers / laser cutting',
    '1:1 打印': '1:1 print',
    '按 1:1 实际尺寸打印，可另存为 PDF': 'Prints at 1:1 actual size; save as PDF',
    '高清图片': 'High-res image',
    '高分辨率位图，适合插入文档或做预览图': 'High-resolution bitmap for documents or previews',
    '← 返回盒型库': '← Back to library',
    '盒型库': 'Box library',
    '分类': 'Category',

    /* 参数面板 */
    '尺寸与参数': 'Size & parameters',
    '重置': 'Reset',
    '尺寸类型': 'Dimension type',
    '当前：制造尺寸': 'Current: manufacturing size',
    '当前：内尺寸': 'Current: inner size',
    '当前：外尺寸': 'Current: outer size',
    '制造尺寸': 'Manufacturing',
    '内尺寸': 'Inner',
    '外尺寸': 'Outer',
    '外形尺寸': 'Overall size',
    '长': 'Length',
    '宽': 'Width',
    '高': 'Depth',
    '纸板厚度': 'Board thickness',
    '自定义': 'Custom',
    '厚度': 'Thickness',
    '其他参数': 'Other parameters',
    '重新计算刀模': 'Recalculate die line',
    '就绪': 'Ready',
    '当前未连接求解服务，修改尺寸只会更新标注数值，不会重绘刀模。启动本地服务（node server.js）后即可实算。':
      'The solver service is not connected: changing sizes only updates the dimension labels, the die line is not redrawn. Start the local service (node server.js) to enable live solving.',

    /* 视图 / 画布 */
    '视图切换': 'View',
    '2D 展开图': '2D layout',
    '3D 立体': '3D view',
    '显示刀模展开图（切割线 + 压痕线）': 'Show the flat die-cut layout (cut + crease lines)',
    '把这张刀模展开图实时折叠成 3D 立体盒。改过尺寸之后，会自动按当前尺寸重新折叠':
      'Folds this die-cut layout into a 3D box in real time. After you change the size it re-folds automatically.',
    '适应': 'Fit',
    '主尺寸': 'Main dims',
    '显示主尺寸标注：长 / 宽 / 高这类主参数的尺寸线（橙色）': 'Show main dimension lines — length / width / depth (orange)',
    '显示其他参数标注：圆角、插舌、锁扣等结构参数的尺寸线（绿色）': 'Show other dimensions — radii, tuck flaps, locks (green)',
    '标注文字怎么显示': 'How annotation text is displayed',
    '数值': 'Value',
    '代码=数值': 'Code=value',
    '代码': 'Code',
    '展开尺寸': 'Flat size',
    '显示/隐藏整张图的展开宽（上）与展开高（左）': 'Show or hide the overall blank width (top) and height (left)',
    '切割线': 'Cut lines',
    '压痕线': 'Crease lines',
    '图上标注': 'Annotations',
    '标注位置与数值都取自盒型本身，改尺寸后会一起更新': 'Annotation positions and values come from the box type itself and update with the size',
    '刀模展开图（单位 mm）': 'Die-cut layout (mm)',
    '折叠后尺寸': 'Folded size',
    '3D 立体模型折叠后的外廓包围盒（长 × 宽 × 高）。含锁舌、翼片等外扩部分，可能与左侧制造尺寸有零点几毫米到几毫米的出入':
      'Bounding box of the folded 3D model (L × W × H). It includes protruding locks and flaps, so it may differ from the manufacturing size by a few tenths of a millimetre to a few millimetres.',
    '面板': 'Panels',
    '铰链': 'Hinges',
    '拼版': 'Imposition',
    '折叠结构按标准尺寸生成。改过尺寸之后会自动按当前尺寸重新折叠': 'The fold is built from the standard size and re-folds automatically after you change the size',
    '按标准尺寸生成': 'from standard size',
    '左键旋转 · 中键平移 · 滚轮缩放': 'Drag to rotate · middle-drag to pan · scroll to zoom',

    /* 贴图 */
    '整张展开图 = 一张印刷面': 'Whole blank = one printed sheet',
    '3D 立体图 ·': '3D view ·',
    '贴图': 'Artwork',
    '未贴图': 'No artwork',
    '选择图片': 'Choose image',
    '清除贴图': 'Clear artwork',
    '图片按整张展开图铺到盒面上，折起来图案跟着面板走，不会在折痕处错位':
      'The image is mapped onto the whole blank, so the print follows the panels when folded without drifting at the creases',
    '纸板厚度取自盒型求解结果；是否在立体图上加厚，由 3D 视图里的「纸厚」按钮决定':
      'Board thickness comes from the solver result; whether the 3D view shows it as a solid is controlled by the "Board" button in the 3D view',
    '贴合': 'Fit',
    '铺满展开图': 'Fill the blank',
    '保持比例居中': 'Keep ratio, centred',
    '平面图上': 'On 2D',
    '立体图上': 'On 3D',
    '3D 立体盒上显示这张贴图': 'Show this artwork on the 3D box',
    '不透明度': 'Opacity',
    '平面图上的贴图透明度（方便对照刀模线）': 'Artwork opacity on the 2D layout (so you can still see the die lines)',
    '缩放': 'Scale',
    '横向缩放（1× = 正好铺满展开图）': 'Horizontal scale (1× = exactly fills the blank)',
    '纵向': 'Vertical',
    '纵向缩放；想拉伸成非等比，先解开右边的「等比」': 'Vertical scale — unlock "Lock ratio" to stretch unevenly',
    '等比': 'Lock ratio',
    '锁定横纵比例，一起缩放': 'Lock the aspect ratio so both axes scale together',
    '旋转': 'Rotate',
    '绕展开图中心顺时针旋转': 'Rotate clockwise around the centre of the blank',
    '转 90°': 'Rotate 90°',
    '每次顺时针转 90°': 'Rotate 90° clockwise each time',
    '左右': 'X',
    '左右移动（按展开图宽度的百分比）': 'Move horizontally (% of blank width)',
    '上下': 'Y',
    '上下移动（按展开图高度的百分比）': 'Move vertically (% of blank height)',
    '复位摆放': 'Reset position',
    '回到「铺满展开图、不旋转、居中」': 'Back to "fill the blank, no rotation, centred"',

    /* 右栏信息卡 */
    '三种尺寸对照': 'Three size references',
    '刀模规格': 'Die-cut specs',
    '盒型编号': 'Box code',
    '所属分类': 'Category',
    '向内补偿': 'Inner compensation',
    '向外补偿': 'Outer compensation',
    '切割 / 压痕': 'Cut / crease',
    '用纸面积': 'Board area',
    '用途标签': 'Use tags',
    '同类盒型': 'Similar box types',

    /* 列表页 */
    '盒型分类': 'Categories',
    '全部盒型': 'All box types',
    '可用盒型': 'Box types',
    '结构分类': 'Categories',
    '数据分片': 'Data chunks',
    '尺寸体系': 'Size systems',
    '正在加载…首次加载约 0.5 MB': 'Loading… about 0.5 MB on first load',
    '正在加载盒型数据…': 'Loading box data…',
    '数据加载失败': 'Failed to load data',
    '没有匹配的盒型': 'No matching box types',
    '换个关键词或分类试试': 'Try another keyword or category',
    '尺寸未标注': 'Size not specified',
    '无展开图': 'No layout',
    '展开图未加载': 'Layout not loaded',
    '暂无参考图': 'No preview yet',
    '盒型参考图': 'Box preview',
    '未命名': 'Untitled',
    '厚': 'Board',

    /* 分类名（面包屑、规格卡、同类盒型都会带出来；带前缀与去前缀两种写法都要收） */
    '免费': 'Free',
    'A.管式盒': 'A. Tube boxes',
    'B.管式盒延伸盒型': 'B. Extended tube boxes',
    'D.盘式盒': 'D. Tray boxes',
    'C.天地盖': 'C. Lid & base boxes',
    'E.翻盖盒': 'E. Hinged-lid boxes',
    'I.抽屉盒': 'I. Drawer boxes',
    'Z.异形盒': 'Z. Irregular shapes',
    'L.个性展示盒': 'L. Display boxes',
    'J.常用纸箱': 'J. Common cartons',
    'M.缓冲/格挡 内衬': 'M. Inserts & partitions',
    'F.手提袋': 'F. Paper bags',
    'G.信封/文件夹/封套': 'G. Envelopes & folders',
    'S.标签/吊牌/卡板': 'S. Labels & hang tags',
    'Q.展示架': 'Q. Display stands',
    'R.塑料片材盒pvc/pet': 'R. Plastic sheet boxes (PVC/PET)',
    'JP.礼盒精品盒': 'JP. Gift & premium boxes',
    'BQ.其他': 'BQ. Others',
    'Y.带圆弧盒型': 'Y. Rounded-corner boxes',
    'U 软包装': 'U. Flexible packaging',
    'X 拼版': 'X. Imposition',
    '常用盒型': 'Common box types',
    '管式盒': 'Tube boxes',
    '管式盒延伸盒型': 'Extended tube boxes',
    '盘式盒': 'Tray boxes',
    '天地盖': 'Lid & base box',
    '翻盖盒': 'Hinged-lid box',
    '抽屉盒': 'Drawer box',
    '异形盒': 'Irregular-shaped box',
    '个性展示盒': 'Display box',
    '常用纸箱': 'Common carton',
    '缓冲/格挡 内衬': 'Insert / partition',
    '手提袋': 'Paper bag',
    '信封/文件夹/封套': 'Envelope / folder',
    '标签/吊牌/卡板': 'Label / hang tag',
    '展示架': 'Display stand',
    '塑料片材盒': 'Plastic sheet box',
    '礼盒精品盒': 'Gift & premium box',
    '带圆弧盒型': 'Rounded-corner box',
    '软包装': 'Flexible packaging',
    '拼版': 'Imposition',
    '其他': 'Other',

    /* 上游参数名（400 多个标签 = 186 个基础词，这里收高频的一批；
       没收到的会回落到中文 —— 后面紧跟的参数代码（如 of / d2）仍能对上求解串） */
    '偏移': 'Offset',
    '半径': 'Radius',
    '角度': 'Angle',
    '插舌长': 'Tuck length',
    '插舌宽': 'Tuck width',
    '插片长': 'Flap length',
    '插孔宽': 'Slot width',
    '插孔长': 'Slot length',
    '插舌半径': 'Tuck radius',
    '长度': 'Length',
    '宽度': 'Width',
    '孔长': 'Hole length',
    '孔宽': 'Hole width',
    '孔直径': 'Hole diameter',
    '直径': 'Diameter',
    '间隔': 'Spacing',
    '间距': 'Gap',
    '竖向间隔': 'Vertical spacing',
    '高低位': 'Step offset',
    '防尘翼长': 'Dust-flap length',
    '底长': 'Base length',
    '底宽': 'Base width',
    '底高': 'Base depth',
    '锁长': 'Lock length',
    '自锁长': 'Self-lock length',
    '斜线高': 'Slant height',
    '内折宽度': 'Inner-fold width',
    '黏位长': 'Glue-flap length',
    '后锁间隔': 'Rear-lock spacing',
    '圆角、直角': 'Round / square corner',
    '内盒高': 'Inner-box depth',
    '内盒长': 'Inner-box length',
    '内盒宽': 'Inner-box width',
    '围边面纸长': 'Wrap paper length',
    '围边面纸宽': 'Wrap paper width',
    '内托长': 'Insert length',
    '内托宽': 'Insert width',
    '内盒内裱纸厚度': 'Inner liner thickness',
    '圆角': 'Corner radius',
    '数量': 'Quantity',
    '位置': 'Position',
    '深度': 'Depth',
    '厚度': 'Thickness',
    '宽度2': 'Width 2',
    '角度间隔': 'Angular spacing',

    /* 3D 视图面板（view3d.js 拼出来的按钮与纸张名） */
    '纸种 ⌄': 'Paper ⌄',
    '纸种': 'Paper',
    '纸厚': 'Board',
    '自动旋转': 'Auto-spin',
    '复位视角': 'Reset view',
    '网格': 'Grid',
    '▶ 自动折叠': '▶ Auto-fold',
    '⏸ 暂停': '⏸ Pause',
    '折叠速度 慢': 'Fold speed — slow',
    '快': 'Fast',
    '加载中…': 'Loading…',
    '换纸张材质 / 盒体颜色': 'Change paper material / box colour',
    '按纸板厚度把盒面挤成薄板（厚度取自盒型求解结果，开关注会被记住）':
      'Extrude the panels to the board thickness (taken from the solver result; the toggle is remembered)',
    '让模型自己慢慢转圈，方便看背面': 'Slowly spin the model so you can see the back',
    '回到刚进来时的视角（不改动自动折叠 / 自动旋转的开关）':
      'Back to the initial camera angle (the auto-fold / auto-spin switches stay as they are)',
    '显示 / 隐藏脚下的地面网格（选择会记住）': 'Show or hide the ground grid (the choice is remembered)',
    '纸板原色': 'Natural board',
    '瓦楞纸': 'Corrugated',
    '牛皮纸': 'Kraft',
    '金卡纸': 'Gold board',
    '银卡纸': 'Silver board',
    '青色纸': 'Cyan paper',
    '粉色纸': 'Pink paper',
    '红色纸': 'Red paper',

    /* 状态 / 提示（动态） */
    '缺少盒型编号': 'Box code missing',
    '请从盒型库进入': 'Please open it from the box library',
    '返回盒型库': 'Back to the library',
    '正在求解…': 'Solving…',
    '正在加载 3D 立体视图…': 'Loading 3D view…',
    '3D 立体图已就绪': '3D view ready',
    '该盒型没有折叠结构（平面件／对折卡），暂无 3D 立体图': 'This box type has no fold structure (flat piece or folded card), so there is no 3D view',
    '正在按当前尺寸重新折叠…': 'Re-folding for the current size…',
    '3D 立体图已按当前尺寸重新折叠': '3D view re-folded for the current size',
    '按当前尺寸重算失败，暂显示标准尺寸的 3D 图': 'Re-solve failed; showing the 3D view at the standard size',
    '未连接求解服务，已保留原刀模图形（尺寸标注已更新）': 'Solver not connected — the original die line is kept (dimension labels updated)',
    '已恢复为默认参数': 'Restored to default parameters',
    '这张图读不出来，换一张试试': 'This image could not be read — try another one',
    '参数越界，已自动调整到可用范围': 'Value out of range — adjusted to the allowed range automatically'
  };

  /* ---------------- 带数字/变量的句子：正则 -> 英文 ---------------- */
  /* {1}{2}… 对应捕获组 */
  var PATTERNS = [
    [/^(\d+) 个盒型$/, '{1} box types'],
    [/^共 (\d+) 个盒型 · 点击卡片查看刀模展开图与内外制造尺寸$/,
      '{1} box types · tap a card for the die-cut layout and inner / manufacturing size references'],
    [/^搜索「(.+?)」，命中 (\d+) 个盒型$/, 'Search "{1}" — {2} matches'],
    [/^厚 (.+)$/, 'Board {1}'],
    [/^当前：(.+)$/, function (m) { return 'Current: ' + (DICT[m[1]] || m[1]); }],
    [/^与(.+?)相同，改(.+?)就会跟着变$/, function (m) {
      return 'Same as ' + (DICT[m[1]] || m[1]) + ' — changing ' + (DICT[m[2]] || m[2]) + ' updates this too';
    }],
    [/^(.+?)由盒型结构推算，不可单独调整$/, function (m) {
      return (DICT[m[1]] || m[1]) + ' is derived from the box structure and cannot be edited';
    }],
    [/^此盒型不含(.+)$/, function (m) { return 'This box type has no ' + (DICT[m[1]] || m[1]); }],
    [/^求解参数 CAL，可调 (\d+–\d+) mm$/, 'Solver parameter CAL, adjustable {1} mm'],
    [/^已贴图（(\d+) × (\d+)），平面图与立体图同步显示$/, 'Artwork applied ({1} × {2}) — shown on both 2D and 3D'],
    [/^已按新尺寸求解（展开 (.+?) × (.+?) mm）(.*)$/, 'Recalculated for the new size (flat {1} × {2} mm){3}'],
    [/^(.+?) 渲染失败（其余区域正常，可尝试强制刷新）$/, '{1} failed to render (the rest is fine; try a hard refresh)'],
    [/^3D 视图加载失败：(.+)$/, '3D view failed to load: {1}'],
    [/^按当前尺寸重算 3D 失败：(.+)$/, 'Re-solving the 3D view failed: {1}'],
    [/^未找到盒型 (.+)$/, 'Box type {1} not found'],
    [/^打印失败：(.+)$/, 'Printing failed: {1}'],
    [/^刀模图 XML 非法：(.+)$/, 'Invalid die-cut XML: {1}'],
    [/^打印时把「缩放」设为 100%（实际大小）/, 'When printing, set Scale to 100% (actual size)'],
    /* 兜底：参数标签带序号的写法（「长 1」「偏移 2」）——译基础词、保留序号 */
    [/^(.+?)\s+(\d+)$/, function (m) { return (DICT[m[1]] || m[1]) + ' ' + m[2]; }]
  ];

  function applyPatterns(s) {
    for (var i = 0; i < PATTERNS.length; i++) {
      var re = PATTERNS[i][0], rep = PATTERNS[i][1];
      var m = re.exec(s);
      if (!m) continue;
      if (typeof rep === 'function') return rep(m);
      return rep.replace(/\{(\d+)\}/g, function (_, n) { return m[n] == null ? '' : m[n]; });
    }
    return null;
  }

  /** 精确 or 模式翻译；中文环境直接返回原文 */
  V2.t = function (s) {
    if (V2.LANG !== 'en') return s;
    if (s == null) return s;
    var raw = String(s);
    var key = raw.trim();
    if (!key) return raw;
    var hit = DICT[key];
    if (hit == null) hit = applyPatterns(key);
    if (hit == null) return raw;                       /* 缺词条 → 回中文，绝不吐空 */
    /* 保留原有的首尾空白，避免行内排版串在一起 */
    return raw.replace(key, hit);
  };

  /* ---------------- 整段 HTML 覆写（含 <b> 等行内标签的复杂句子） ---------------- */
  var HTML_BY_ID = {
    expNote: 'SVG / DXF are exported at <b>1:1 actual size (mm)</b>: cut lines on the <b>CUT</b> layer, crease lines on the <b>CREASE</b> layer.',
    sizeNote: 'Inner / outer sizes are taken from the box type&rsquo;s own dimension annotations — structural allowances such as tuck flaps and inserts are already included, which is closer to the physical box than a calculated compensation (board thickness = inner + outer compensation).',
    offlineNote: '<span>ℹ️</span><span>The solver service is not connected: changing sizes only updates the dimension labels, the die line is not redrawn. Start the local service (<code>node server.js</code>) to enable live solving.</span>'
  };

  /* ---------------- 文本节点 + 属性翻译 ---------------- */
  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, TEXTAREA: 1 };

  function trTextNode(node) {
    var v = node.nodeValue;
    if (!v || !/[\u4e00-\u9fa5]/.test(v)) return;
    var out = V2.t(v);
    if (out !== v) node.nodeValue = out;
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { trTextNode(root); return; }
    if (root.nodeType !== 1) return;
    if (SKIP[root.tagName]) return;

    var i, el;
    if (root.id && HTML_BY_ID[root.id]) root.innerHTML = HTML_BY_ID[root.id];
    for (i = 0; i < ATTRS.length; i++) {
      var a = root.getAttribute && root.getAttribute(ATTRS[i]);
      if (a && /[\u4e00-\u9fa5]/.test(a)) {
        var na = V2.t(a);
        if (na !== a) root.setAttribute(ATTRS[i], na);
      }
    }
    var kids = root.childNodes || [];
    for (i = 0; i < kids.length; i++) walk(kids[i]);
  }

  /** 翻译一棵子树（幂等：英文串不含中文，重复调用不会二次替换） */
  V2.applyI18n = function (root) {
    if (V2.LANG !== 'en') return;
    walk(root || document.body);
  };

  /** 等 DOM 就绪 + 观察动态渲染的节点（列表卡片、状态行都是 JS 拼出来的） */
  function boot() {
    if (V2.LANG !== 'en') return;
    V2.applyI18n(document.body);
    if (!window.MutationObserver) return;
    var pending = null;
    var mo = new MutationObserver(function (recs) {
      if (pending) return;
      pending = setTimeout(function () {
        pending = null;
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          if (r.type === 'characterData') trTextNode(r.target);
          else if (r.type === 'attributes') walk(r.target);
          else for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
        }
      }, 120);
    });
    mo.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
