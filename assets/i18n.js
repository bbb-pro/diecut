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
    /* 三围单字：尺寸框的提示句（「与宽相同，改宽就会跟着变」）靠 DICT 反查这几个字 */
    '长': 'Length', '宽': 'Width', '高': 'Height',
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
    /* 底部统计 / 状态行（都是 JS 拼字符串，textContent 设进去，只能靠模式兜） */
    [/^(\d+) 条$/, '{1} lines'],
    [/^主尺寸 (\d+)\/(\d+) · 其他参数 (\d+)\/(\d+)$/, 'Main dims {1}/{2} · Other params {3}/{4}'],
    [/^该盒型无标注数据$/, 'No dimension annotations for this box type'],
    [/^（(\d+) 段折叠）$/, '({1} fold steps)'],
    [/^按当前尺寸重算$/, 'from current size'],
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

  /* ---------------- 「其他参数」面板：上游中文参数名 → 英文 ----------------
     上游 pm[].d 是中文参数名（「插舌长」「围边面纸长1」这类），随盒型变化、量很大，
     既有 catalog 标签表（407 码 / 205 个名字）又有盒型专属名，所以单靠一张整词表会漏。
     策略三层：
       ① 整词命中 PARAM_EN（已覆盖 54 个盒型抽样里出现的全部 162 个名字 + catalog 词表）
       ② 「基础词 + 结尾编号」组合：长1 → Length 1、围边面纸宽2 → Wall cover paper width 2
       ③ 都没命中 → 原样回中文（用户 2026-10-27 明确：没有准确英文就用中文，不许瞎编）
     术语按刀模/折叠纸盒行业标准：die line、crease、glue flap、tuck flap、dust flap、
     slot、lock、greyboard、cover paper、lining paper、wrap、square(lip)。 */
  var PARAM_EN = {
    /* —— 主尺寸与三围 —— */
    '长': 'Length', '长度': 'Length', '宽': 'Width', '宽度': 'Width',
    '高': 'Height', '深': 'Depth',
    '外尺寸长': 'Outer length', '外尺寸宽': 'Outer width', '外尺寸高': 'Outer height',
    '内长': 'Inner length', '内宽': 'Inner width', '内高': 'Inner height', '外高': 'Overall outer height',
    '整长': 'Overall length', '顶宽': 'Top width', '侧边长': 'Side edge length',
    '斜线高': 'Diagonal height', '背板高': 'Back panel height', '高低位': 'Height offset',
    '左边高度': 'Left height', '右边高度': 'Right height',
    '长缩位': 'Length allowance', '宽缩位': 'Width allowance', '高缩位': 'Height allowance',
    '向内补偿': 'Inner compensation', '向外补偿': 'Outer compensation', '伸长': 'Extension',
    '松紧度间隙': 'Fit clearance', '内外盒边距': 'Lid/base clearance', '盒距': 'Box spacing',
    /* —— 长度/宽度/半径/角度这类通用量 —— */
    '半径': 'Radius', '角度': 'Angle', '直径': 'Diameter', '距离': 'Distance', '偏移': 'Offset',
    '间距': 'Spacing', '间隔': 'Spacing', '横向间隔': 'Horizontal spacing', '竖向间隔': 'Vertical spacing',
    '槽深': 'Slot depth', '槽口坡度': 'Slot taper', '槽口半径': 'Slot radius',
    '槽口宽度': 'Slot width', '槽口数': 'Slot count', '狭缝宽': 'Slit width',
    '边缘倒角': 'Edge chamfer', '导圆角': 'Fillet radius', '圆角、直角': 'Corner style',
    /* —— 插舌 / 防尘翼 / 黏位 —— */
    '插舌': 'Tuck flap', '插舌长': 'Tuck flap length', '插舌宽': 'Tuck flap width',
    '插舌角度': 'Tuck flap angle', '插舌半径': 'Tuck flap radius', '插舌结构': 'Tuck structure',
    '插舌孔长': 'Tuck slot length', '插舌孔宽': 'Tuck slot width',
    '上插舌样式': 'Top tuck style', '下插舌样式': 'Bottom tuck style',
    '防尘翼长': 'Dust flap length', '防尘摇翼长': 'Dust flap length',
    '防尘摇翼高度': 'Dust flap height', '防尘摇翼半径': 'Dust flap radius',
    '防尘摇翼角度': 'Dust flap angle',
    '黏位长': 'Glue flap length', '黏位角度': 'Glue flap angle',
    '粘位': 'Glue flap', '粘位长': 'Glue flap length',
    '折边': 'Fold', '折边长': 'Fold length', '折边宽': 'Fold width', '折边宽度': 'Fold width',
    '折位长': 'Fold position length',
    '内折': 'Inner fold', '内折长': 'Inner fold length', '内折宽度': 'Inner fold width',
    '内折卡口': 'Inner fold notch',
    '插片长': 'Insert tab length', '挂板长': 'Hanging panel length',
    '手提长': 'Handle length', '手提扣孔': 'Carry handle hole',
    /* —— 锁扣 / 插孔 / 开窗 / 提孔 —— */
    '锁扣': 'Lock', '锁扣宽': 'Lock width', '锁扣深': 'Lock depth', '锁扣半径': 'Lock radius',
    '锁扣长度': 'Lock length', '锁长': 'Lock length', '锁扣间隔': 'Lock spacing',
    '锁扣孔长': 'Lock slot length', '锁扣孔宽': 'Lock slot width', '锁扣孔半径': 'Lock slot radius',
    '自锁长': 'Self-lock length', '后锁间隔': 'Rear lock spacing',
    '插孔长': 'Slot length', '插孔宽': 'Slot width', '插孔数': 'Slot count',
    '上下插孔数': 'Vertical slot count',
    '左右插孔数': 'Side slot count', '上部插扣数': 'Top lock count', '底部插扣数': 'Bottom lock count',
    '上下插孔长': 'Vertical slot length', '上下插孔宽': 'Vertical slot width',
    '上下孔心间距': 'Vertical slot spacing', '左右距离': 'Left/right clearance',
    '孔长': 'Hole length', '孔长度': 'Hole length', '孔宽': 'Hole width', '孔直径': 'Hole diameter',
    '孔心间距': 'Hole spacing', '孔底距': 'Hole-to-bottom distance',
    '侧面孔底距': 'Side hole-to-bottom distance',
    '提孔长度': 'Handle hole length', '提孔宽度': 'Handle hole width', '穿绳孔': 'String hole',
    '开窗': 'Window', '开窗长度': 'Window length', '开窗宽度': 'Window width',
    '开孔长': 'Opening length', '开孔宽': 'Opening width', '开孔半径': 'Opening radius',
    '开孔尺寸': 'Opening size',
    '前面圆弧数': 'Front arc count', '后面圆弧数': 'Rear arc count',
    '卡位宽': 'Retaining slot width', '卷边位': 'Rolled edge',
    /* —— 折叠纸盒结构位（勾底 / 自动底）—— */
    '勾底半径': 'Auto-bottom radius',
    '正唛勾底角度': 'Front panel auto-bottom angle', '侧唛勾底角度': 'Side panel auto-bottom angle',
    '过刀长': 'Over-cut length', '单双刀': 'Single/double cut', '齿刀模型': 'Perforation pattern',
    '球牌': 'Disc',
    /* —— 盒盖 / 地盒 / 天盖 / 内盒 —— */
    '盒盖': 'Lid', '盖长': 'Lid length', '盖宽': 'Lid width', '盖高': 'Lid height',
    '盒盖长': 'Lid length', '盒盖宽': 'Lid width', '盒盖高': 'Lid height', '盒盖深': 'Lid depth',
    '盖盒高': 'Lid height', '上盖面长': 'Top lid face length', '盒盖包边': 'Lid wrap',
    '盖盒包边': 'Lid wrap', '上盖包边': 'Top lid wrap', '天盖包边': 'Top lid wrap',
    '盖内折': 'Lid inner fold', '盖盒内折': 'Lid inner fold',
    '盖内裱长': 'Lid inner lining length', '盖内裱宽': 'Lid inner lining width',
    '盖盒内裱纸厚度': 'Lid inner lining thickness', '天盖裱面厚度': 'Top lid lining thickness',
    '盖面纸长': 'Lid cover paper length', '盖面纸宽': 'Lid cover paper width',
    '盖面纸高': 'Lid cover paper height', '盖面纸厚度': 'Lid cover paper thickness',
    '盖脊宽': 'Lid spine width',
    '地盒长': 'Base length', '地盒宽': 'Base width', '地盒高': 'Base height',
    '盒底长': 'Base bottom length', '盒底宽': 'Base bottom width',
    '底长': 'Bottom length', '底宽': 'Bottom width', '底高': 'Bottom height',
    '盒底内折宽度': 'Base inner fold width', '盒内折': 'Base inner fold',
    '地盒包边': 'Base wrap', '下盒包边': 'Base wrap', '内盒包底': 'Inner box bottom wrap',
    '地盖包边': 'Bottom lid wrap', '底盖包边': 'Bottom lid wrap',
    '地盒内裱纸厚度': 'Base inner lining thickness', '地盒裱面厚度': 'Base lining thickness',
    '地盒面纸厚度': 'Base cover paper thickness', '内裱纸厚度': 'Inner lining thickness',
    '盒脊宽': 'Base spine width', '边脊宽': 'Spine width', '边脊宽度': 'Spine width',
    '皮壳边脊宽': 'Case spine width', '皮壳正面伸长': 'Case front extension',
    '封套背脊': 'Sleeve spine',
    '内盒长': 'Inner box length', '内盒宽': 'Inner box width', '内盒高': 'Inner box height',
    '内盒围边宽': 'Inner box wall width', '内盒侧边间距': 'Inner box side spacing',
    '内盒内裱纸': 'Inner box lining', '内盒内裱纸厚度': 'Inner box lining thickness',
    '内盒内贴厚度': 'Inner box inner lining thickness',
    '内盒面纸厚度': 'Inner box cover paper thickness', '内盒卡纸厚度': 'Inner box card thickness',
    '内盒灰板纸厚': 'Inner box greyboard thickness', '内围条灰板厚度': 'Inner rim greyboard thickness',
    '内页灰板纸厚': 'Inner page greyboard thickness',
    '底盖长': 'Bottom lid length', '底盖面纸': 'Bottom lid cover paper',
    '底盖灰板长': 'Bottom lid greyboard length', '底盖灰板直径': 'Bottom lid greyboard diameter',
    '底面纸长': 'Bottom cover paper length', '底面纸宽': 'Bottom cover paper width',
    '底面纸高': 'Bottom cover paper height',
    '底板宽度': 'Base board width', '底板灰板的厚度': 'Base board greyboard thickness',
    '底片灰板厚度': 'Bottom panel greyboard thickness',
    '底片伸长对齐': 'Bottom panel extension alignment',
    /* —— 板材 / 裱纸 / 包边 —— */
    '灰板厚度': 'Greyboard thickness', '纸板厚度': 'Board thickness', '刀卡厚度': 'Divider thickness',
    '平板厚度': 'Flat board thickness', '装饰厚度': 'Decoration thickness',
    '双面胶': 'Double-sided tape', '裱里纸': 'Lining paper', '裱纸厚度': 'Lining thickness',
    '面纸厚度': 'Cover paper thickness', '里纸厚度': 'Lining paper thickness',
    '外盒灰板厚度': 'Outer box greyboard thickness',
    '外盒面纸厚度': 'Outer box cover paper thickness',
    '外盒内裱纸厚度': 'Outer box inner lining thickness',
    '外盒包边': 'Outer box wrap', '盒面纸厚度': 'Box cover paper thickness',
    '侧板面纸厚度': 'Side panel cover paper thickness',
    '包角宽度': 'Corner wrap width', 'EVA厚度': 'EVA thickness',
    '绸带厚度': 'Ribbon thickness', '塑料片长': 'Plastic sheet length',
    '口袋折叠厚度': 'Pocket fold thickness', '内管芯纸高': 'Core board height', '内管裱纸': 'Tube lining',
    /* —— 围边（皮壳类）—— */
    '围边长': 'Wall length', '围边宽': 'Wall width', '围边纸板高': 'Wall board height',
    '围边卡纸厚度': 'Wall board thickness', '围边内裱纸厚度': 'Wall inner lining thickness',
    '围边面纸长': 'Wall cover paper length', '围边面纸宽': 'Wall cover paper width',
    '围边内折高度': 'Wall inner fold height', '围边凸出高度': 'Wall protrusion height',
    '围边贴里长': 'Wall lining length',
    /* —— 内托 / 卡板 / 夹层 / 抽屉 —— */
    '内托长': 'Insert length', '内托宽': 'Insert width', '内托高': 'Insert height',
    '内托厚度': 'Insert thickness', '内托墙宽': 'Insert wall width', '卡托高': 'Card insert height',
    '卡板高': 'Card panel height', '横向卡板长': 'Horizontal card panel length',
    '竖向卡板长': 'Vertical card panel length',
    '夹层长': 'Divider length', '夹层宽': 'Divider width', '夹层高': 'Divider height',
    '夹层包边': 'Divider wrap', '夹层纸板厚度': 'Divider board thickness',
    '夹层面纸厚度': 'Divider cover paper thickness',
    '抽屉长': 'Drawer length', '抽屉宽': 'Drawer width', '抽屉高': 'Drawer height',
    '抽屉包边': 'Drawer wrap', '抽屉面纸厚度': 'Drawer cover paper thickness',
    /* —— 特殊件 —— */
    '飘口': 'Square (lip)', '上下缩短距离': 'Top/bottom trim', '挂翼半径': 'Hanging wing radius',
    '挂翼自锁长': 'Hanging wing self-lock length', '挂翼自锁角度': 'Hanging wing self-lock angle',
    /* —— 皮壳 / 书型盒 / 封套（第二批取样补的）—— */
    '顶长': 'Top length', '提手长': 'Handle length', '提手宽': 'Handle width',
    '围条长': 'Rim length', '围条宽': 'Rim width', '围条高': 'Rim height',
    '围条纸厚度': 'Rim board thickness', '间隙高': 'Gap height',
    '盖内贴': 'Lid inner liner', '底内贴': 'Base inner liner',
    '天盖面纸厚度': 'Top lid cover paper thickness', '对折边': 'Turned edge',
    '内页长': 'Inner page length', '内页宽': 'Inner page width',
    '书脊': 'Spine', '槽位': 'Slot position',
    '封面长': 'Cover length', '封面宽': 'Cover width',
    '封套长': 'Sleeve length', '封套宽': 'Sleeve width',
    '封套纸板厚': 'Sleeve board thickness', '封套面纸厚': 'Sleeve cover paper thickness',
    '内折长度': 'Inner fold length',
    /* —— 第三批（44 盒型抽样补的）+ 供组合使用的「零件词」—— */
    '高度': 'Height', '防尘翼': 'Dust flap', '开口': 'Opening', '卡口': 'Notch',
    '提手': 'Handle', '边距': 'Margin', '封套': 'Sleeve', '内页': 'Inner page', '封面': 'Cover',
    '左边距': 'Left margin', '开口长': 'Opening length', '提手高': 'Handle height',
    '插孔间距': 'Slot spacing', '卡口长': 'Notch length', '卡口宽': 'Notch width',
    '外盒裱纸厚度': 'Outer box lining thickness', '内盒裱纸厚度': 'Inner box lining thickness',
    '内盒内贴纸厚度': 'Inner box inner liner thickness', '内盒包边': 'Inner box wrap',
    '盖直径': 'Lid diameter',
    /* —— 第四批（87 盒型抽样补的）+ 可参与组合的零件词 —— */
    '窗口': 'Window', '手孔': 'Hand hole', '天盒': 'Top box', '外盒': 'Outer box',
    '围边面纸': 'Wall cover paper', '底面灰板': 'Bottom greyboard', '底裱纸': 'Base lining',
    '底内裱纸': 'Base inner lining', '盖内裱纸': 'Lid inner lining',
    '外盒内贴纸': 'Outer box inner liner', '折叠': 'Fold', '单盖': 'Single lid', '侧盖': 'Side lid',
    '锁底': 'Lock bottom', '勾底': 'Auto-bottom', '正唛勾底': 'Front panel auto-bottom',
    '半盖': 'Half lid', '米字孔数': 'Star hole count', '刀长': 'Rule length',
    '重叠长': 'Overlap length', '放大距离': 'Bleed offset', '窗口上间距': 'Window top spacing',
    '锁扣孔': 'Lock slot', '围边灰板': 'Wall greyboard',
    '盒型选择': 'Box type'
  };

  /* 下拉选项（上游 dl[].t）：样式类枚举 */
  var OPT_EN = {
    '无': 'None', '有': 'Yes',
    '插入式': 'Tuck-in', '插卡式': 'Push-in',
    '导圆': 'Filleted', '半导圆': 'Half fillet', '斜口': 'Bevel',
    '暗扣': 'Snap lock', '锁扣': 'Lock',
    '直角': 'Square corner', '圆角': 'Rounded corner',
    '单刀': 'Single cut', '双刀': 'Double cut'
  };

  var PM_NUM = /^(.*?)\s*([0-9]{1,2})$/;

  /* 长尾兜底：英文「修饰词 + 名词」的语序和中文一致（围条长 → Rim length），
     所以「已知零件词 + 量名后缀」可以安全组合 —— 1295 个盒型里总有想不到的复合名，
     靠这条规则覆盖，剩下的仍回中文，绝不编造。 */
  var PM_SUFFIX = [
    ['厚度', 'thickness'], ['直径', 'diameter'], ['角度', 'angle'], ['半径', 'radius'],
    ['间距', 'spacing'], ['位置', 'position'], ['长度', 'length'], ['高度', 'height'],
    ['宽度', 'width'], ['长', 'length'], ['宽', 'width'], ['高', 'height'], ['深', 'depth'],
    ['数', 'count']
  ];

  function composeParam(word) {
    if (!word) return null;
    for (var i = 0; i < PM_SUFFIX.length; i++) {
      var suf = PM_SUFFIX[i][0];
      if (word.length <= suf.length || word.slice(-suf.length) !== suf) continue;
      var head = word.slice(0, -suf.length);
      if (PARAM_EN[head]) return PARAM_EN[head] + ' ' + PM_SUFFIX[i][1];
    }
    return null;
  }

  /** 参数名：整词 → 基础词+编号 → 零件词组合 → 回中文（绝不编造） */
  V2.paramLabel = function (name) {
    if (V2.LANG !== 'en') return name;
    var raw = String(name == null ? '' : name).trim();
    if (!raw) return raw;
    if (PARAM_EN[raw]) return PARAM_EN[raw];
    var m = PM_NUM.exec(raw);
    var base = m ? m[1] : '';
    var num = m ? ' ' + m[2] : '';
    if (base && PARAM_EN[base]) return PARAM_EN[base] + num;
    var c = composeParam(base || raw);
    if (c) return c + num;
    return raw;
  };

  /** 下拉选项文案：命中就英文，否则回中文 */
  V2.optLabel = function (t) {
    if (V2.LANG !== 'en') return t;
    var raw = String(t == null ? '' : t).trim();
    return OPT_EN[raw] || raw;
  };

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
