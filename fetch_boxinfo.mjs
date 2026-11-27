/* 抓上游盒型详情页的「名称 / 标签 / 描述」
 *
 * 源：https://online.packmage.cn/Online/Design/{id}
 *     上游详情页左侧「盒型信息」是**服务端渲染**的，四项全在 HTML 里，
 *     描述同时出现在 <meta name="description">，匿名可读、无需登录。
 * 输出：boxinfo_raw.json  { id: { name, tags, desc } }
 *
 * 用法：
 *   node fetch_boxinfo.mjs           增量（已有且非空的跳过）
 *   node fetch_boxinfo.mjs --force   全量重抓（约 1298 次请求，25 秒左右）
 */
import fs from 'node:fs';
import vm from 'node:vm';

const FORCE = process.argv.includes('--force');
const OUT = 'boxinfo_raw.json';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('packmage_data.js', 'utf8'), ctx);
const ids = Object.keys(ctx.PackmageData.boxes);
console.log('盒型清单', ids.length, '个');

const old = (!FORCE && fs.existsSync(OUT)) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const out = Object.assign({}, old);
const todo = ids.filter((id) => FORCE || !out[id] || !(out[id].desc || '').trim());
console.log('待抓', todo.length, '| 复用已有', ids.length - todo.length);

const CONC = 8, RETRY = 2;
let done = 0;
const fail = [];

function parse(html) {
  const name = (html.match(/盒型名称：<\/b><span title="([^"]*)"/) || [])[1] || '';
  const tags = (html.match(/标签：<\/b><span class="n-row-nowrap" title="([^"]*)"/) || [])[1] || '';
  const desc = (html.match(/<meta name="description" content="([\s\S]*?)" \/>/) || [])[1] || '';
  return {
    name: decodeEnt(name).trim(),
    tags: decodeEnt(tags).trim(),
    desc: decodeEnt(desc).replace(/\s+/g, ' ').trim(),
  };
}

/* 上游正文里混了 HTML 实体（多见于引号、&、单引号），统一还原再清洗 */
function decodeEnt(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function one(id, attempt = 0) {
  try {
    const r = await fetch('https://online.packmage.cn/Online/Design/' + encodeURIComponent(id), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; diecut-sync/1.0)',
        Referer: 'https://online.packmage.cn/Online/Boxes',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    out[id] = parse(await r.text());
  } catch (e) {
    if (attempt < RETRY) return one(id, attempt + 1);
    fail.push([id, e.message]);
  } finally {
    done++;
    if (done % 100 === 0) console.log('  进度', done + '/' + todo.length);
  }
}

let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < todo.length) await one(todo[i++]);
}));

/* 清单里已消失的盒型顺手剔掉，避免分片里留下死条目 */
const alive = {};
ids.forEach((id) => { if (out[id]) alive[id] = out[id]; });
fs.writeFileSync(OUT, JSON.stringify(alive), 'utf8');

const vals = Object.values(alive);
const empty = (s) => !String(s || '').trim();
console.log('\n抓到', vals.length, '/', ids.length, '| 失败', fail.length);
if (fail.length) console.log('失败样本', fail.slice(0, 8));
console.log('名称空', vals.filter((v) => empty(v.name)).length,
  '| 标签空', vals.filter((v) => empty(v.tags)).length,
  '| 描述空', vals.filter((v) => empty(v.desc)).length);
console.log('输出', OUT, (fs.statSync(OUT).size / 1024 / 1024).toFixed(2) + 'MB');
if (fail.length) process.exitCode = 1;
