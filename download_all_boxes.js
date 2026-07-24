/*
 * download_all_boxes.js — Batch download all 1279 box geometries from packmage.cn
 *
 * Usage: node download_all_boxes.js
 * Output: packmage_all_boxes.json
 */

const https = require('https');
const fs = require('fs');
const querystring = require('querystring');

const HOST = 'online.packmage.cn';
const PATH = '/Online/GetBoxData';

// Load existing data to get the catalog
global.window = global;
const vm = require('vm');
const code = fs.readFileSync(__dirname + '/packmage_data.js', 'utf8');
vm.runInThisContext(code);

const catalog = PackmageData.catalog;
const existingBoxes = PackmageData.boxes;
console.log('Catalog:', catalog.length, 'boxes');
console.log('Already downloaded:', Object.keys(existingBoxes).length, 'boxes');

function fetchBox(boxID) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      boxID: boxID,
      inPms: '', // empty = use defaults
      getBox3D: 'false',
      getFullPmsDesc: 'true',
      getRemark: 'false',
      tran: '0'
    });

    const options = {
      hostname: HOST,
      path: PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Referer': 'https://online.packmage.cn/Online/Design/' + boxID,
        'Origin': 'https://online.packmage.cn',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) {
            resolve(null);
            return;
          }
          const inner = typeof json.Data === 'string' ? JSON.parse(json.Data) : json.Data;
          const d = typeof inner.data === 'string' ? JSON.parse(inner.data) : inner.data;
          const cadData = typeof inner.cadData === 'string' ? JSON.parse(inner.cadData) : inner.cadData;

          // Extract in the same format as existing data
          resolve({
            tags: '', // will fill from catalog
            tid: 0,   // will fill from catalog
            cal: { min: cadData.CalMin || 1, max: cadData.CalMax || 3 },
            de: {
              w: d.de.Width,
              h: d.de.Height,
              ox: d.de.OffsetX,
              oy: d.de.OffsetY,
              p: d.de.P,
              sl: d.de.SolidLength,
              dl: d.de.DashLength,
              op: d.de.OutPms
            },
            ce: d.ce,
            pm: cadData.PmItems || [],
            fe: d.fe
          });
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

async function main() {
  // Build a lookup from catalog for tags/tid
  const catalogLookup = {};
  catalog.forEach(c => { catalogLookup[c.id] = c; });

  // Get all box IDs that we need to download
  const allIds = catalog.map(c => c.id);
  const existingIds = new Set(Object.keys(existingBoxes));
  const needDownload = allIds.filter(id => !existingIds.has(id));

  console.log('Need to download:', needDownload.length, 'new boxes');

  // Start with existing boxes
  const allBoxes = {};
  Object.assign(allBoxes, existingBoxes);

  // Fix existing boxes to have tags/tid from catalog
  for (const id in allBoxes) {
    if (catalogLookup[id]) {
      allBoxes[id].tags = catalogLookup[id].tags || allBoxes[id].tags;
      allBoxes[id].tid = catalogLookup[id].tid;
    }
  }

  // Download in batches of 10 concurrent requests
  const BATCH_SIZE = 10;
  let downloaded = 0;
  let failed = 0;

  for (let i = 0; i < needDownload.length; i += BATCH_SIZE) {
    const batch = needDownload.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(id => fetchBox(id)));

    results.forEach((box, j) => {
      const id = batch[j];
      if (box) {
        // Fill tags and tid from catalog
        const cat = catalogLookup[id];
        if (cat) {
          box.tags = cat.tags || '';
          box.tid = cat.tid;
        }
        allBoxes[id] = box;
        downloaded++;
      } else {
        failed++;
      }
    });

    process.stdout.write(`\rDownloaded: ${downloaded}/${needDownload.length} | Failed: ${failed} | Total: ${Object.keys(allBoxes).length}`);
  }

  console.log('\n');
  console.log('Total boxes downloaded:', Object.keys(allBoxes).length);
  console.log('Failed:', failed);

  // Save to file
  const output = {
    categories: PackmageData.categories,
    catalog: catalog,
    boxes: allBoxes
  };

  const jsonStr = JSON.stringify(output);
  fs.writeFileSync(__dirname + '/packmage_all_boxes.json', jsonStr);
  console.log('Saved to packmage_all_boxes.json (' + (jsonStr.length / 1024 / 1024).toFixed(1) + ' MB)');

  // Also generate the JS file
  let jsContent = '// Packmage Box Library Data - ALL ' + Object.keys(allBoxes).length + ' boxes\n';
  jsContent += '// Auto-generated from online.packmage.cn API\n\n';
  jsContent += 'var PackmageData = ';
  jsContent += jsonStr;
  jsContent += ';\n';

  fs.writeFileSync(__dirname + '/packmage_data.js', jsContent);
  console.log('Updated packmage_data.js (' + (jsContent.length / 1024 / 1024).toFixed(1) + ' MB)');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
