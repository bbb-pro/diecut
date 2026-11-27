#!/usr/bin/env node
/* ============================================================
   tools/boxinfo-lib.js —— 盒型信息清洗的单一实现

   build_boxinfo.js（生成 data/info 分片）与 build_v2.js（生成 data/catalog.js
   的盒型名）共用这里的词表与函数，避免两处规则漂移。

   数据源：boxinfo_raw.json（fetch_boxinfo.mjs 抓的上游详情页内容）
   ============================================================ */

'use strict';

/* ---------------- 词表 ---------------- */

/* 营销 / SEO 词：出现在名字或标签里就说明它不是结构描述 */
const SEO_WORD = /设计|印刷|定制|定做|厂家|生产|制作|批发|报价|方案|加工|包装盒型|包装盒结构|包装结构|包装材料|包装项目|一站式|直销|采购|供应/;
/* 结构词：真正描述盒型的名字里一定会出现这些字 */
const TYPE_WORD = /盒|箱|袋|卡|托|盘|架|筒|管|罐|匣|册|签|牌|衬|格|套|板|片|封|兜|篮|槽|提手|展示|挂钩|手提/;
/* 只是材质的泛称，当名字没有区分度（「彩盒」「纸盒」叫不出结构） */
const GENERIC = /^(彩盒|纸盒|卡纸盒|瓦楞纸盒|瓦楞盒|白盒|牛皮纸盒|礼品盒|精品盒|包装盒|纸箱|包装|纸卡|卡板)$/;

/* 行业 / 用途词：key 是归一化后的场景标签，值是能命中它的原文词。
   顺序无关，匹配时按词长倒序，避免「电子」抢在「电子产品」前面。 */
const SCENE = {
  化妆品: ['化妆品', '美妆', '护肤', '彩妆', '香水', '面膜', '洗面奶', '口红'],
  玩具: ['玩具', '积木', '毛绒', '手办', '拼图', '模型'],
  母婴: ['母婴', '婴儿', '儿童', '童装', '奶瓶', '纸尿裤'],
  食品: ['食品', '零食', '饼干', '糖果', '巧克力', '坚果', '月饼', '粽子', '蛋糕', '烘焙', '熟食', '餐饮', '披萨', '快餐', '调味'],
  生鲜: ['生鲜', '蔬菜', '水果', '海鲜', '水产', '肉类', '禽蛋', '鸡蛋', '苹果', '橙子', '车厘子', '草莓', '葡萄'],
  饮料: ['饮料', '果汁', '茶饮', '矿泉水', '汽水', '啤酒'],
  酒: ['白酒', '红酒', '葡萄酒', '洋酒', '酒类', '酒瓶'],
  茶叶: ['茶叶', '茶包', '红茶', '绿茶'],
  咖啡: ['咖啡', '咖啡豆'],
  药品: ['药品', '医药', '药盒', '口服液', '胶囊', '药片'],
  保健品: ['保健品', '保健', '营养品', '膳食'],
  医疗器械: ['医疗器械', '口罩', '试剂', '体温计'],
  电子产品: ['电子产品', '电子配件', '数码', '3C', '电器', '家电', '耳机', '数据线', '充电器', '电池', 'U盘', '摄像头'],
  手机: ['手机', '平板', '智能手表'],
  服饰: ['服饰', '服装', '鞋', '内衣', '袜子', '帽子', '围巾', '衬衫', 'T恤'],
  日用品: ['日用品', '日化', '洗护', '清洁', '毛巾', '牙刷'],
  文具: ['文具', '办公', '笔盒', '笔记本', '本册', '文件夹'],
  工艺品: ['工艺品', '陶瓷', '玻璃制品', '木制', '手工', '摆件', '茶具', '餐具'],
  礼品: ['礼品', '赠品', '伴手礼', '促销品'],
  珠宝: ['珠宝', '首饰', '黄金', '项链', '戒指', '手镯'],
  饰品: ['饰品', '发饰', '配饰', '头饰'],
  图书: ['图书', '书籍', '书刊', '杂志', '画册'],
  宠物: ['宠物', '猫粮', '狗粮'],
  烟草: ['烟草', '香烟', '卷烟'],
  农产品: ['农产品', '农副', '土特产', '干货', '杂粮'],
  鲜花: ['鲜花', '花束', '花艺'],
  五金: ['五金', '工具', '螺丝', '紧固件'],
  汽配: ['汽配', '汽车零件', '车灯', '滤清器'],
  /* 注意：不要把「运输包装」「展示包装」这类**包装类型**放进场景词表 ——
     它们说的是结构/流通方式，不是行业（0002 那句「适用于作为运输包装」会误判成快递行业） */
  电商物流: ['快递包装', '电商包装', '物流包装'],
};

/* 词长倒序的「原文词 → 场景」索引 */
const SCENE_WORDS = [];
Object.keys(SCENE).forEach((label) => {
  SCENE[label].forEach((w) => SCENE_WORDS.push([w, label]));
});
SCENE_WORDS.sort((a, b) => b[0].length - a[0].length);

/* 「通常用于…」这类断言句 —— 用途只从这里取，避免把 SEO 尾巴里的行业名当用途 */
const ASSERT = /(?:通常用于|常用于|常作为|常被用于|适用于|广泛应用于|广泛用于|多用于|一般用于|主要用于|可用于|用作|适合用于|适合于|适合各种|用来包装|用于包装)/;

/* ---------------- 清洗 ---------------- */

/* 对外文案不出现品牌名（2026-10-22 用户明确要求）。
   上游正文里 46 处「包装魔术师里面该盒型模板有…」→「该盒型模板有…」 */
function cleanDesc(s) {
  return String(s || '')
    .replace(/包装魔术师里面该盒型模板/g, '该盒型模板')
    .replace(/包装魔术师/g, '')
    .replace(/Packmage|packmage/gi, '')
    .replace(/^[，,、]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 上游「盒型名称」本身有一半是关键词串（A038 = 「双插盒,内隔层,锁扣,…」），
   还有的直接是一段描述（0202A = 「纸箱（英文 carton…）」）。
   按逗号/句读切段，取第一个「像结构名」的候选。 */
/* 字符串直通也要过一遍「像不像名字」：
   实测上游会给出「有瓦楞纸箱」（多一个「有」）、「异形盒结构」「文具包装展示」
   （只说了属性没说是哪种盒）这类不能当标题的。 */
const BAD_TAIL = /(结构|展示|包装|设计|特点|效果|样式|说明|系列|类型|等)$/;

function acceptable(s) {
  if (/^[有的是和与及]/.test(s)) return false;
  /* 盒型名几乎不带「的」—— 带「的」的基本是把描述切了一半
     （0202A 的候选里就有「纸箱常用的有三层」） */
  if (/的/.test(s)) return false;
  if (BAD_TAIL.test(s) && !/(盒|箱|袋|架|卡|托|盘|筒)$/.test(s)) return false;
  return true;
}

/* 上游 tags 里混着被逗号切碎的描述片段（「各层分为里纸」「瓦楞纸」「芯纸」），
   当结构 chip 太脏，含这些虚词/动词的一律不要 */
const BAD_CHIP = /分为|以及|包括|可以|需要|使用|通过|进行|采用|就是|的是|常用|一般/;

function cleanName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length >= 2 && s.length <= 14 && !SEO_WORD.test(s) && !/[，,、。；;：:|｜\/]/.test(s) &&
    TYPE_WORD.test(s) && !GENERIC.test(s) && acceptable(s)) return s;
  const parts = s.split(/[,，、。；;：:（）()【】\[\]\/|｜]/).map((t) => t.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 2 || p.length > 14) continue;
    if (SEO_WORD.test(p)) continue;
    if (!TYPE_WORD.test(p)) continue;
    if (GENERIC.test(p)) continue;
    if (!acceptable(p)) continue;
    return p;
  }
  return '';
}

/* 断言句：把有「通常用于 / 适用于 / 用作…」的句子全部挑出来。
   ❗ 只取第一句会漏 —— 0002 的第一处「适用于」在第 4 条，后面还有别的行业说明 */
function assertClause(desc) {
  const s = String(desc || '');
  if (!ASSERT.test(s)) return '';
  return s.split(/[。；;]/).filter((x) => ASSERT.test(x)).join('。');
}

/* 名称兜底：上游 name 是纯 SEO 串（「彩盒设计|电子产品包装设计」）时，
   从描述首句「这是一款底部自动闭合的完全叠盖式管式盒」里取结构名。
   ❗ 只在 cleanName 失败时用 —— 上游 name 的第一段通常仍是最准的。 */
function nameFromDesc(desc) {
  const m = String(desc || '').slice(0, 80).match(/(?:这是一款|是一款|本款|这是一)([^。；,，]{2,40})/);
  if (!m) return '';
  let s = m[1].trim();
  const k = s.lastIndexOf('的');            // 「底部自动闭合的完全叠盖式管式盒」→ 取「的」之后
  if (k >= 0 && s.length - k - 1 >= 3) s = s.slice(k + 1);
  s = s.replace(/[，,、\s]+$/, '');
  if (s.length < 2 || s.length > 16) return '';
  /* 描述里的部位短语别当名字（「顶部带有摩擦插片」「底部带插锁封口」都是半句话） */
  if (/^(顶部|底部|侧面|正面|背面|上部|下部|内部|外部|带有|有|的|是)/.test(s)) return '';
  if (!TYPE_WORD.test(s)) return '';
  if (SEO_WORD.test(s) || GENERIC.test(s) || !acceptable(s)) return '';
  return s;
}

/* 有 346 条描述是「标签串 + 正文」粘在一起
   （异形盒,精品盒,手工盒,…结构特点：1 …）。
   标签串本身已经在「结构 & 材质」栏了，正文里再带一遍既啰嗦又占篇幅 → 剥掉。
   ❗ 只认「整段都等于某个已知标签」的逗号分段，别把正文里的逗号也当分隔符吃掉。 */
const HEAD_MARK = /^(.*?)((?:包装盒设计|包装结构设计|纸盒包装设计|结构设计|设计|结构)?特点|结构说明|说明)[：:]([\s\S]*)$/;

function stripHeadTags(desc, tags) {
  const s = String(desc || '').trim();
  if (!s) return '';
  const parts = s.split(/[,，]/);
  let i = 0;
  let rest = '';
  while (i < parts.length) {
    const p = parts[i].trim();
    if (tags.indexOf(p) >= 0) { i++; continue; }
    const m = p.match(HEAD_MARK);
    if (m && tags.indexOf(m[1].trim()) >= 0) { rest = m[2] + '：' + m[3]; break; }
    return s;                       // 第一段就不是标签 → 本来就是正文，原样返回
  }
  if (i >= parts.length && !rest) return s;
  const tail = rest || parts.slice(i).join('，');
  return (tail || '').trim();
}

function scenesOf(desc, tagList) {
  const out = [];
  const push = (label) => { if (out.indexOf(label) < 0) out.push(label); };

  // ① 断言句里出现的行业词（高置信）
  const clause = assertClause(desc);
  if (clause) {
    for (const [w, label] of SCENE_WORDS) {
      if (clause.indexOf(w) >= 0) push(label);
    }
  }
  // ② 标签里以「包装 / 盒」结尾的行业词（中置信，只补前面没提到的）
  const tagHits = [];
  tagList.forEach((t) => {
    for (const [w, label] of SCENE_WORDS) {
      if (t.indexOf(w) >= 0 && /(包装|盒|箱|袋)$/.test(t)) { tagHits.push(label); break; }
    }
  });
  tagHits.forEach(push);

  return out.slice(0, 4);
}

/* 结构与材质：标签去掉 SEO 词与行业词后的剩余，按原顺序、限长 2~12 字 */
function structsOf(tagList, sceneLabels, name) {
  const out = [];
  const seen = {};
  tagList.forEach((t) => {
    const s = String(t || '').trim();
    if (!s || s.length < 2 || s.length > 12) return;
    if (SEO_WORD.test(s)) return;
    if (BAD_CHIP.test(s)) return;
    if (s === name) return;                    // 与标题重复的不再当 chip
    if (seen[s]) return;
    // 行业词（含「化妆品包装」这类）不进结构栏，它们已经在「适用场景」里了
    for (let i = 0; i < SCENE_WORDS.length; i++) {
      const [w, label] = SCENE_WORDS[i];
      if (s.indexOf(w) >= 0 && /(包装|盒|箱|袋)$/.test(s) && sceneLabels.indexOf(label) >= 0) return;
    }
    seen[s] = 1;
    out.push(s);
  });
  return out.slice(0, 8);
}


/* 「a,b,c」→ ['a','b','c']，中英文逗号都认 */
function splitChips(s) {
  return String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

/* 单条盒型信息 → { n 名称, u 适用场景, s 结构材质, d 结构说明 }
   data/info 分片与 box/<ID>/ 静态页共用这一个入口，规则不会漂。
   raw 来自 boxinfo_raw.json；fallbackTags 是 catalog 里那条盒型的 tags。 */
function buildRecord(id, raw, fallbackTags) {
  const r = raw || {};
  const tags = splitChips(r.tags).length ? splitChips(r.tags) : (fallbackTags || []);
  const name = cleanName(r.name) || nameFromDesc(r.desc) || '';
  const desc0 = String(r.desc || '');
  let desc = stripHeadTags(cleanDesc(desc0), tags);
  // 剥完还留着「名称 + 逗号」开头的，一并去掉（名称已经是标题了）
  if (name) {
    const pfx = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[,，]');
    desc = desc.replace(pfx, '').trim();
  }
  // 描述跟标签串一模一样（70 个 JP 精品盒就是这样）→ 视为没有正文
  const flat = (s) => s.replace(/[\s,，、]/g, '');
  if (!desc || desc.length < 20 || flat(desc) === flat(r.tags)) desc = '';
  /* 少数盒型的「描述」其实是站点推广文案（「最简单的包装结构3D在线设计网站，拥有上千款盒型库…」），
     跟这个盒型没关系，留着既没信息量又踩对外文案的品牌约束 */
  if (/3D在线设计网站|上千款盒型|在线设计网站/.test(desc)) desc = '';

  const u = scenesOf(desc, tags);
  /* 去重时把「实际会显示的那个名字」也算上（name 拿不到时页面显示 tags[0]）——
     否则 0202A 这种 h1 叫「纸箱」、chips 里又列一个「纸箱」 */
  const s = structsOf(tags, u, name || tags[0] || '');

  const rec = {};
  if (name) rec.n = name;
  if (u.length) rec.u = u.join(',');
  if (s.length) rec.s = s.join(',');
  if (desc) rec.d = desc;
  return rec;
}

module.exports = {
  SEO_WORD, TYPE_WORD, GENERIC, SCENE, SCENE_WORDS, ASSERT,
  cleanDesc, cleanName, nameFromDesc, assertClause, stripHeadTags, scenesOf, structsOf, splitChips,
  buildRecord
};
