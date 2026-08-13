/*
 * packmage_boxtypes.js — Packmage box library integration
 *
 * Converts packmage.cn API data to the DieCut Designer renderer format.
 * Supports dynamic parameter changes via API proxy.
 *
 * Data format (fe array):
 *   [0, style, x1, y1, x2, y2]       — Line segment (style: 0=cut/切线, 1=crease/压痕)
 *   [1, style, cx, cy, r, sa, ea]    — Arc (center, radius, start/end angle in degrees)
 *   [2, style, x1, y1, x2, y2, ...]  — Polyline
 */

/* ===== Geometry cache (in-memory) ===== */
var _geometryCache = {};

/* ===== Auto-detect panels (enclosed faces) and label each with its size =====
 * The packmage API only returns raw cut/crease polylines — no panel names.
 * We reconstruct the planar graph, split segments at intersections, then trace
 * every enclosed face (panel) and annotate it with its W×H bounding box. The
 * outer/exterior face is discarded via a point-in-polygon test.
 */
function computePanelLabels(cuts, creases, bbox) {
  function keyOf(p) {
    return Math.round(p[0] * 100) / 100 + ',' + Math.round(p[1] * 100) / 100;
  }
  // Segment intersection (returns interior point only)
  function segInt(p1, p2, p3, p4) {
    var x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    var x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
    var den = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
    if (Math.abs(den) < 1e-9) return null;
    var t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / den;
    var u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / den;
    if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
    return { point: [x1 + t * (x2 - x1), y1 + t * (y2 - y1)] };
  }

  // Collect segments from polylines (arcs are already polyline-ized upstream)
  var rawSegs = [];
  function addPoly(pts) {
    for (var i = 0; i < pts.length - 1; i++) rawSegs.push([pts[i], pts[i + 1]]);
  }
  cuts.forEach(addPoly);
  creases.forEach(addPoly);
  if (!rawSegs.length) return [];

  // Split every segment at any intersection point
  var S = rawSegs.map(function (s) { return { a: s[0], b: s[1], pts: [s[0], s[1]] }; });
  var n = S.length;
  for (var i = 0; i < n; i++) {
    for (var j = i + 1; j < n; j++) {
      var it = segInt(S[i].a, S[i].b, S[j].a, S[j].b);
      if (!it) continue;
      S[i].pts.push(it.point);
      S[j].pts.push(it.point);
    }
  }

  // Build vertex set + undirected adjacency
  var verts = {};
  var V = [];
  var adj = {};
  function vid(p) {
    var k = keyOf(p);
    if (!(k in verts)) { verts[k] = V.length; V.push(p); }
    return verts[k];
  }
  function edge(p1, p2) {
    var a = vid(p1), b = vid(p2);
    if (a === b) return;
    (adj[a] || (adj[a] = [])).push(b);
    (adj[b] || (adj[b] = [])).push(a);
  }
  S.forEach(function (s) {
    var a = s.a;
    s.pts.sort(function (p1, p2) {
      var d1 = (p1[0] - a[0]) * (p1[0] - a[0]) + (p1[1] - a[1]) * (p1[1] - a[1]);
      var d2 = (p2[0] - a[0]) * (p2[0] - a[0]) + (p2[1] - a[1]) * (p2[1] - a[1]);
      return d1 - d2;
    });
    for (var k = 0; k < s.pts.length - 1; k++) edge(s.pts[k], s.pts[k + 1]);
  });

  // Incident edges sorted by angle (for face tracing)
  var inc = {};
  for (var v in adj) {
    inc[v] = adj[v].map(function (w) {
      return { to: w, ang: Math.atan2(V[w][1] - V[v][1], V[w][0] - V[v][0]) };
    });
    inc[v].sort(function (a, b) { return a.ang - b.ang; });
  }

  // Trace every face by always turning left (CCW / minimal positive angle).
  // inc[v] is angle-sorted, so the next edge is found by binary search in O(log n)
  // instead of scanning the whole incident list — critical at hub vertices.
  function nextIdx(arr, A) {
    var lo = 0, hi = arr.length - 1, ans = arr.length;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].ang > A) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans === arr.length ? 0 : ans; // wrap to the first if none is greater
  }
  var used = {};
  var faces = [];
  for (var v2 in adj) {
    for (var ii = 0; ii < adj[v2].length; ii++) {
      var w = adj[v2][ii];
      if (used[v2 + '>' + w]) continue;
      var cycle = [];
      var cur = v2, nxt = w, guard = 0;
      while (guard++ < 2000) {
        var ek = cur + '>' + nxt;
        if (used[ek]) break;          // edge already consumed by another face
        used[ek] = true;
        cycle.push(cur);
        var dx = V[nxt][0] - V[cur][0], dy = V[nxt][1] - V[cur][1];
        var A = Math.atan2(dy, dx);
        var cand = inc[nxt];
        var best = cand[nextIdx(cand, A)].to;
        cur = nxt; nxt = best;
        if (cur === v2 && nxt === w) break;
      }
      if (cycle.length >= 3) faces.push(cycle);
    }
  }

  // Exterior test point (clearly outside the layout)
  var ox = bbox.minX - 50, oy = bbox.minY - 50;
  function pointIn(cyc, px, py) {
    var inside = false;
    for (var i = 0, j = cyc.length - 1; i < cyc.length; j = i++) {
      var xi = V[cyc[i]][0], yi = V[cyc[i]][1];
      var xj = V[cyc[j]][0], yj = V[cyc[j]][1];
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  var totalArea = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);

  // Collect valid interior panels. Drop the unbounded exterior face, any
  // pathological self-intersecting face, off-canvas faces, and thin slivers
  // (glue tabs / dust locks) whose real area is < 50% of their bounding box.
  var cells = [];
  faces.forEach(function (cyc) {
    if (pointIn(cyc, ox, oy)) return; // skip the unbounded exterior face
    var area = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var cx = 0, cy = 0;
    for (var i = 0; i < cyc.length; i++) {
      var p = V[cyc[i]], q = V[cyc[(i + 1) % cyc.length]];
      area += p[0] * q[1] - q[0] * p[1];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
      cx += p[0]; cy += p[1];
    }
    area = Math.abs(area) / 2;
    if (area > totalArea) return;        // pathological self-intersecting faces
    cx /= cyc.length; cy /= cyc.length;
    if (cx < bbox.minX || cx > bbox.maxX || cy < bbox.minY || cy > bbox.maxY) return; // off-canvas
    var bw = maxX - minX, bh = maxY - minY;
    if (area < bw * bh * 0.5) return;    // thin sliver / tab → not a real panel
    cells.push({ area: area, cx: cx, cy: cy, w: Math.round(bw), h: Math.round(bh) });
  });

  // Keep the largest panels only, capped so the view stays readable.
  // Also drop tiny flaps / dust locks: only show panels whose area is at
  // least 8% of the largest panel. cells are area-sorted, so we stop early.
  cells.sort(function (a, b) { return b.area - a.area; });
  var MAX_LABELS = 40;
  var MIN_RATIO = 0.08;
  var maxArea = cells.length ? cells[0].area : 0;
  var labels = [];
  for (var ci = 0; ci < cells.length && labels.length < MAX_LABELS; ci++) {
    if (cells[ci].area < maxArea * MIN_RATIO) break;
    labels.push({ x: cells[ci].cx, y: cells[ci].cy, text: cells[ci].w + '×' + cells[ci].h });
  }
  return labels;
}

/* ===== Convert packmage fe array to renderer format ===== */
function convertPackmageGeometry(fe, ox, oy) {
  var cuts = [];
  var creases = [];
  var absOx = Math.abs(ox || 0);
  var absOy = Math.abs(oy || 0);

  for (var i = 0; i < fe.length; i++) {
    var e = fe[i];
    var type = e[0];
    var style = e[1];

    if (type === 0) {
      var line = [
        [e[2] + absOx, e[3] + absOy],
        [e[4] + absOx, e[5] + absOy]
      ];
      if (style === 0) cuts.push(line);
      else creases.push(line);
    } else if (type === 1) {
      var cx = e[2] + absOx;
      var cy = e[3] + absOy;
      var r = e[4];
      var sa = e[5];
      var ea = e[6];
      // Packmage geometry engine uses math coordinates (Y up):
      // 0° = right, 90° = up, 180° = left, 270° = down.
      // SVG uses screen coordinates (Y down):
      // 0° = right, 90° = down, 180° = left, 270° = up.
      // Therefore we interpret sa/ea as math angles and negate sin
      // when converting to SVG point coordinates.
      var angleDiff = ea - sa;
      while (angleDiff < 0) angleDiff += 360;
      while (angleDiff >= 360) angleDiff -= 360;
      if (angleDiff === 0 && sa !== ea) angleDiff = 360; // full circle
      var steps = Math.max(16, Math.ceil(Math.abs(angleDiff) / 3));
      var points = [];
      for (var s = 0; s <= steps; s++) {
        var t = s / steps;
        var angleDeg = sa + angleDiff * t;
        var angle = angleDeg * Math.PI / 180;
        points.push([cx + r * Math.cos(angle), cy - r * Math.sin(angle)]);
      }
      if (style === 0) cuts.push(points);
      else creases.push(points);
    } else if (type === 2) {
      var pts = [];
      for (var j = 2; j < e.length; j += 2) {
        pts.push([e[j] + absOx, e[j + 1] + absOy]);
      }
      if (pts.length >= 2) {
        if (style === 0) cuts.push(pts);
        else creases.push(pts);
      }
    }
  }

  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function updateBBox(pts) {
    for (var k = 0; k < pts.length; k++) {
      if (pts[k][0] < minX) minX = pts[k][0];
      if (pts[k][1] < minY) minY = pts[k][1];
      if (pts[k][0] > maxX) maxX = pts[k][0];
      if (pts[k][1] > maxY) maxY = pts[k][1];
    }
  }
  cuts.forEach(updateBBox);
  creases.forEach(updateBBox);

  if (minX === Infinity) { minX = 0; minY = 0; maxX = 100; maxY = 100; }

  // Dimensions: overall width / height of the die-cut layout, drawn outside
  // the layout bounds so they never overlap the cut/crease lines.
  var dimOffset = 16; // mm, offset from the layout edge
  var dimensions = [
    {
      type: 'h',
      x1: minX, x2: maxX, y1: minY,
      offset: -dimOffset,
      label: (maxX - minX).toFixed(1) + ' mm'
    },
    {
      type: 'v',
      x1: minX, y1: minY, y2: maxY,
      offset: -dimOffset,
      label: (maxY - minY).toFixed(1) + ' mm'
    }
  ];

  return {
    cuts: cuts,
    creases: creases,
    dimensions: dimensions,
    labels: computePanelLabels(cuts, creases, { minX: minX, minY: minY, maxX: maxX, maxY: maxY }),
    bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY }
  };
}

/* ===== Parse parameter string (ce field) — returns UPPERCASE keys ===== */
function parseParamString(ce) {
  var params = {};
  if (!ce) return params;
  var parts = ce.split(',');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split('=');
    if (kv.length === 2) {
      var key = kv[0].trim().toUpperCase();
      var val = parseFloat(kv[1]);
      if (!isNaN(val)) params[key] = val;
    }
  }
  return params;
}

/* ===== Build param string from current values ===== */
function buildInPms(params, pmItems) {
  // Build the inPms string for the API: L=100,W=75,D=50,CAL=2,CHOOSE=3
  var parts = [];
  // Add input params (Layer 0)
  for (var i = 0; i < pmItems.length; i++) {
    var pm = pmItems[i];
    var name = pm.n || pm.Name;
    var layer = pm.l !== undefined ? pm.l : (pm.Layer !== undefined ? pm.Layer : 0);
    if (layer === 0) {
      var val = params[name.toUpperCase()];
      if (val !== undefined) {
        parts.push(name.toUpperCase() + '=' + val);
      }
    }
  }
  // Add CAL and CHOOSE if present
  if (params.CAL !== undefined) parts.push('CAL=' + params.CAL);
  if (params.CHOOSE !== undefined) parts.push('CHOOSE=' + params.CHOOSE);
  return parts.join(',');
}

/* ===== Fetch geometry from API (with caching) ===== */
function fetchGeometryFromAPI(boxID, inPms, callback) {
  var cacheKey = boxID + '|' + inPms;
  if (_geometryCache[cacheKey]) {
    callback(_geometryCache[cacheKey]);
    return;
  }

  var body = JSON.stringify({ boxID: boxID, inPms: inPms });
  var xhr = new XMLHttpRequest();
  xhr.open('POST', DiecutConfig.apiBase, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      if (xhr.status === 200) {
        try {
          var result = JSON.parse(xhr.responseText);
          if (result.success && result.box) {
            _geometryCache[cacheKey] = result.box;
            callback(result.box);
          } else {
            callback(null);
          }
        } catch (e) {
          callback(null);
        }
      } else {
        callback(null);
      }
    }
  };
  xhr.send(body);
}

/* ===== Build box types from PackmageData ===== */
function buildPackmageBoxTypes() {
  if (typeof PackmageData === 'undefined' || !PackmageData.boxes) return [];

  var result = [];
  var boxIds = Object.keys(PackmageData.boxes);

  for (var i = 0; i < boxIds.length; i++) {
    var id = boxIds[i];
    var b = PackmageData.boxes[id];

    var defaults = parseParamString(b.ce);

    // Build params list (Layer 0 = input, editable)
    var params = [];
    var derived = [];
    var pmItems = b.pm || [];

    for (var j = 0; j < pmItems.length; j++) {
      var pm = pmItems[j];
      var pName = pm.n || pm.Name;
      var pDesc = pm.d || pm.Desc || pm.Description || pName;
      var pDefault = pm.v !== undefined ? pm.v : pm.DefaultV;
      var pLayer = pm.l !== undefined ? pm.l : (pm.Layer !== undefined ? pm.Layer : 0);

      if (pLayer === 0) {
        var pMin = Math.max(1, Math.round(pDefault * 0.3));
        var pMax = Math.max(pMin + 1, Math.round(pDefault * 3));
        params.push({
          key: pName.toUpperCase(),
          label: pName + ' (' + pDesc + ')',
          default: pDefault,
          min: pMin,
          max: pMax,
          step: 1
        });
      } else {
        derived.push({
          key: pName.toUpperCase(),
          label: pDesc,
          formula: ''
        });
      }
    }

    // Find category name using bitmask tid
    var catName = 'Other';
    if (PackmageData.categories) {
      for (var c = 0; c < PackmageData.categories.length; c++) {
        var cat = PackmageData.categories[c];
        var idx = cat.idx !== undefined ? cat.idx : cat.tid;
        if (b.tid === 0) {
          // tid=0 means "free" category
          if (idx === 0) { catName = cat.name; break; }
        } else if ((b.tid & (1 << idx)) !== 0) {
          catName = cat.name;
          break;
        }
      }
    }

    var shortName = b.tags ? b.tags.split(',')[0] : id;

    // Create closure for each box
    (function(boxId, boxData, boxPmItems, boxDefaults) {
      result.push({
        id: boxId,
        name: shortName,
        fullName: b.tags,
        category: catName,
        tid: b.tid,
        tags: b.tags,
        params: params,
        derived: derived,
        packmageData: boxData,
        pmItems: boxPmItems,
        defaults: boxDefaults,
        currentBoxData: boxData, // current geometry data (may be updated by API)
        isLive: false, // whether geometry was fetched from API
        compute: function(p) {
          // Apply defaults from ce string
          var defStr = this.currentBoxData ? this.currentBoxData.ce : this.packmageData.ce;
          var defs = parseParamString(defStr);
          for (var key in defs) {
            if (p[key.toUpperCase()] === undefined) {
              p[key.toUpperCase()] = defs[key];
            }
          }
          // Set derived values from pm items
          var pms = this.currentBoxData ? this.currentBoxData.pm : this.packmageData.pm;
          for (var i = 0; i < pms.length; i++) {
            var pm = pms[i];
            var layer = pm.l !== undefined ? pm.l : (pm.Layer !== undefined ? pm.Layer : 0);
            var name = pm.n || pm.Name;
            if (layer !== 0) {
              p[name.toUpperCase()] = pm.v !== undefined ? pm.v : pm.DefaultV;
            }
          }
          // KDF dimensions
          var de = this.currentBoxData ? this.currentBoxData.de : this.packmageData.de;
          p.KDFL = de.w;
          p.KDFW = de.h;
          p.SOLID_LEN = de.sl;
          p.DASH_LEN = de.dl;
          p.PARTS = de.p;
          return p;
        },
        draw: function(p, comp) {
          var data = this.currentBoxData || this.packmageData;
          return convertPackmageGeometry(
            data.fe,
            data.de.ox,
            data.de.oy
          );
        },
        // Called when parameters change — fetch new geometry from API
        updateGeometry: function(p, callback) {
          var self = this;
          var inPms = buildInPms(p, this.pmItems);

          // If inPms matches defaults, use cached data
          var defaultInPms = buildInPms(this.defaults, this.pmItems);
          if (inPms === defaultInPms || inPms === '') {
            this.currentBoxData = this.packmageData;
            this.isLive = false;
            if (callback) callback(true);
            return;
          }

          // Fetch from API
          fetchGeometryFromAPI(this.id, inPms, function(boxData) {
            if (boxData) {
              self.currentBoxData = boxData;
              self.isLive = true;
              if (callback) callback(true);
            } else {
              // Fallback: use default geometry (won't be parametrically correct)
              if (callback) callback(false);
            }
          });
        }
      });
    })(id, b, pmItems, defaults);
  }

  return result;
}

/* ===== Get catalog for browsing ===== */
function getPackmageCatalog() {
  if (typeof PackmageData === 'undefined') return { categories: [], boxes: [] };
  return {
    categories: PackmageData.categories || [],
    boxes: PackmageData.catalog || []
  };
}

/* ===== Check if a box ID has geometry data ===== */
function hasPackmageGeometry(boxId) {
  return typeof PackmageData !== 'undefined' &&
    PackmageData.boxes &&
    PackmageData.boxes[boxId];
}

/* ===== Get box info from catalog ===== */
function getBoxInfoFromCatalog(boxId) {
  if (typeof PackmageData === 'undefined' || !PackmageData.catalog) return null;
  for (var i = 0; i < PackmageData.catalog.length; i++) {
    if (PackmageData.catalog[i].id === boxId) {
      return PackmageData.catalog[i];
    }
  }
  return null;
}

/* Export */
if (typeof window !== 'undefined') {
  window.PackmageBoxTypes = {
    build: buildPackmageBoxTypes,
    getCatalog: getPackmageCatalog,
    hasGeometry: hasPackmageGeometry,
    getBoxInfo: getBoxInfoFromCatalog,
    convertGeometry: convertPackmageGeometry,
    parseParams: parseParamString,
    buildInPms: buildInPms,
    fetchGeometry: fetchGeometryFromAPI
  };
}
