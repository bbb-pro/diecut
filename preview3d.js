/*
 * preview3d.js — 3D Paper Box Preview (Three.js WebGL)
 *
 * Builds a folded 3D carton from packmage's `de.Face` rectangles:
 *   - M0..M5 are the six body panels (front/back/left/right/top/bottom).
 *   - Every other face (M6/M7, S1T/S1B, S3T/S3B, S5, …) is treated as a
 *     flap/tab attached to ONE edge of a body panel. Attachment is detected
 *     GENERICALLY by finding the shared crease edge between the flap rectangle
 *     and a body rectangle — so any box type folds correctly, not just RSC.
 *
 * Features:
 *   - Drag-rotate / wheel-zoom (mouse + touch)
 *   - Per-face artwork (贴图): upload an image, assign to 正/背/左/右/顶/底
 *   - Fold animation (3D折叠): foldProgress 0 = flat net, 1 = closed box
 *   - Falls back to simple CSS 3D if Three.js is unavailable
 */

var Preview3D = {};

/* ===== Shared state ===== */
Preview3D.faceTextures = {};   // faceKey -> dataURL (user artwork)
Preview3D.foldProgress = 0;    // 0 = flat net (展开图), 1 = fully folded/closed
Preview3D._flapPivots = [];    // legacy, kept for compat
Preview3D._faces = [];         // [{mesh, netPos, netQuat, boxPos, boxQuat}]
Preview3D._cache = null;       // {boxType, faceData, params, container}

/* ===== Public: set/clear per-face artwork ===== */
Preview3D.setFaceTexture = function(key, dataURL) {
  if (dataURL) Preview3D.faceTextures[key] = dataURL;
  else delete Preview3D.faceTextures[key];
  Preview3D._rebuildIfCached();
};
Preview3D.clearFaceTextures = function() {
  Preview3D.faceTextures = {};
  Preview3D._rebuildIfCached();
};

/* ===== Public: set fold progress (0..1) ===== */
Preview3D.setFold = function(p) {
  Preview3D.foldProgress = Math.max(0, Math.min(1, p));
  Preview3D._applyFold();
};

Preview3D._rebuildIfCached = function() {
  var c = Preview3D._cache;
  if (!c) return;
  // Rebuild using cached face data (no API round-trip)
  Preview3D._buildThree(c.container, c.boxType, c.params, c.faceData);
};

Preview3D._applyFold = function() {
  var g = Preview3D.foldProgress;
  if (!Preview3D._hinges) return;
  // SEQUENCED fold, one time-slot per ASSEMBLY STAGE (工序) — see the stage
  // derivation in _buildThree. Stages run in order: wrap the walls into a tube,
  // close the bottom, close the top, then push the tucks in. A small overlap
  // makes consecutive stages flow into each other instead of stop-and-go.
  // Faces are nested in the scene graph, so a flap keeps riding its parent wall
  // while it waits for its own slot — it never floats away.
  var n = Preview3D._stageCount || 1;
  var slot = 1 / n;
  var overlap = slot * 0.3;
  Preview3D._hinges.forEach(function(h) {
    var s = h.stage || 0;
    var start = s * slot - overlap; if (start < 0) start = 0;
    var end = (s + 1) * slot;          // stage s is fully folded at (s+1)/n
    var dur = end - start; if (dur < 1e-6) dur = slot;
    var t = (g - start) / dur;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    t = t * t * (3 - 2 * t);           // smoothstep easing
    // Slightly less than 90° so the box never fully closes — interior flaps
    // remain visible and the structure reads clearly (packmage-style preview).
    var maxFold = 0.98;
    var mult = (h.foldMult == null) ? 1 : h.foldMult;
    if (mult === 0) {
      // Static hinge: no crease → panel stays in parent's plane (no rotation)
      h.group.setRotationFromAxisAngle(h.axis, 0);
    } else {
      h.group.setRotationFromAxisAngle(h.axis, h.sign * Math.PI / 2 * t * maxFold * mult);
    }
  });
};

/* ===== Entry point ===== */
Preview3D.render = function(container, boxType, params) {
  Preview3D._cleanup(container);

  // Try cached face data on the boxType first
  var faceData = null;
  if (boxType.currentBoxData && boxType.currentBoxData.de && boxType.currentBoxData.de.face) {
    faceData = _parse(boxType.currentBoxData.de.face);
  }
  if (!faceData && boxType.packmageData && boxType.packmageData.de && boxType.packmageData.de.face) {
    faceData = _parse(boxType.packmageData.de.face);
  }
  // Fallback: some boxes (e.g. T-series) ship an EMPTY de.Face from the API, yet
  // their die-line (drawn from fe) is correct. Recover panels from fe so the 3D
  // view matches the 2D dieline instead of rendering nothing / missing faces.
  var _isReconstructed = false;
  if (!faceData) {
    var _fe = (boxType.currentBoxData && boxType.currentBoxData.fe) ||
              (boxType.packmageData && boxType.packmageData.fe);
    var _ox = boxType.currentBoxData && boxType.currentBoxData.de ? boxType.currentBoxData.de.ox : 0;
    var _oy = boxType.currentBoxData && boxType.currentBoxData.de ? boxType.currentBoxData.de.oy : 0;
    if (!_ox && boxType.packmageData && boxType.packmageData.de) { _ox = boxType.packmageData.de.ox; _oy = boxType.packmageData.de.oy; }
    faceData = reconstructFacesFromFE(_fe, _ox, _oy);
    _isReconstructed = true;
  }

  if (faceData) {
    if (typeof THREE !== 'undefined') {
      Preview3D._buildThree(container, boxType, params, faceData, _isReconstructed);
    } else {
      Preview3D._renderSimple(container, boxType, params);
    }
  } else {
    Preview3D._fetchAndRender(container, boxType, params);
  }
};

function _parse(face) {
  if (!face) return null;
  try { return typeof face === 'string' ? JSON.parse(face) : face; }
  catch (e) { return null; }
}

Preview3D._cleanup = function(container) {
  Preview3D._viewReset = null;
  Preview3D._viewZoom = null;
  if (container._animId) { cancelAnimationFrame(container._animId); container._animId = null; }
  if (container._threeRenderer) { container._threeRenderer.dispose(); container._threeRenderer = null; }
  if (container._mouseMoveHandler) {
    window.removeEventListener('mousemove', container._mouseMoveHandler);
    window.removeEventListener('mouseup', container._mouseUpHandler);
    container._mouseMoveHandler = container._mouseUpHandler = null;
  }
  if (container._resizeHandler) {
    window.removeEventListener('resize', container._resizeHandler);
    container._resizeHandler = null;
  }
  container.innerHTML = '';
};

/* ===== Fetch Face data from API (face not in local data) ===== */
Preview3D._fetchAndRender = function(container, boxType, params) {
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:400px;color:#888;font-size:14px;">正在加载 3D 数据…</div>';
  var xhr = new XMLHttpRequest();
  xhr.open('POST', DiecutConfig.apiBase, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  // Don't leave the user stuck on "loading" forever if the proxy is down/slow:
  // on timeout or network error, drop to the simple (no-WebGL) renderer instead.
  xhr.timeout = 15000;
  xhr.ontimeout = function() { Preview3D._renderSimple(container, boxType, params); };
  xhr.onerror = function() { Preview3D._renderSimple(container, boxType, params); };
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    try {
      var resp = JSON.parse(xhr.responseText);
      var fd = null;
      if (resp.success && resp.box && resp.box.de && resp.box.de.face) {
        fd = _parse(resp.box.de.face);
        if (boxType.currentBoxData) boxType.currentBoxData.de = boxType.currentBoxData.de || {};
        if (boxType.currentBoxData) boxType.currentBoxData.de.face = resp.box.de.face;
        if (boxType.currentBoxData && resp.box.fe) boxType.currentBoxData.fe = resp.box.fe;
      }
      // Fallback: API returned no de.Face (e.g. T-series) — rebuild panels from fe.
      var _fdIsReconstructed = false;
      if (!fd && resp.success && resp.box && resp.box.fe) {
        var fox = resp.box.de ? resp.box.de.ox : 0;
        var foy = resp.box.de ? resp.box.de.oy : 0;
        fd = reconstructFacesFromFE(resp.box.fe, fox, foy);
        _fdIsReconstructed = true;
        if (fd && boxType.currentBoxData) {
          boxType.currentBoxData.fe = resp.box.fe;
          boxType.currentBoxData.de = boxType.currentBoxData.de || {};
          boxType.currentBoxData.de.ox = fox; boxType.currentBoxData.de.oy = foy;
        }
      }
      if (fd && typeof THREE !== 'undefined') {
        Preview3D._buildThree(container, boxType, params, fd, _fdIsReconstructed);
      } else {
        Preview3D._renderSimple(container, boxType, params);
      }
    } catch (e) {
      Preview3D._renderSimple(container, boxType, params);
    }
  };
  xhr.send(JSON.stringify({ boxID: boxType.id, inPms: '' }));
};

/* ===== Generate SVG data URI from die-cut geometry (default texture) ===== */
Preview3D._generateSVGDataURI = function(boxType) {
  var boxData = boxType.currentBoxData || boxType.packmageData;
  if (!boxData || !boxData.fe) return null;
  var fe = boxData.fe;
  if (typeof PackmageBoxTypes !== 'undefined' && PackmageBoxTypes.convertGeometry) {
    var data = PackmageBoxTypes.convertGeometry(fe, boxData.de.ox, boxData.de.oy);
    var bb = data.bbox;
    var w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    if (w <= 0 || h <= 0) return null;
    var pad = 2;
    var parts = [];
    parts.push('<rect x="' + (bb.minX - pad) + '" y="' + (bb.minY - pad) +
      '" width="' + (w + pad * 2) + '" height="' + (h + pad * 2) + '" fill="#fff8f0"/>');
    data.cuts.forEach(function(line) {
      if (line.length < 2) return;
      var d = 'M' + line[0][0].toFixed(1) + ',' + line[0][1].toFixed(1);
      for (var i = 1; i < line.length; i++) d += 'L' + line[i][0].toFixed(1) + ',' + line[i][1].toFixed(1);
      parts.push('<path d="' + d + '" stroke="#e53e3e" stroke-width="0.8" fill="none"/>');
    });
    data.creases.forEach(function(line) {
      if (line.length < 2) return;
      var d = 'M' + line[0][0].toFixed(1) + ',' + line[0][1].toFixed(1);
      for (var i = 1; i < line.length; i++) d += 'L' + line[i][0].toFixed(1) + ',' + line[i][1].toFixed(1);
      parts.push('<path d="' + d + '" stroke="#3182ce" stroke-width="0.5" fill="none" stroke-dasharray="2,1"/>');
    });
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
      (bb.minX - pad) + ' ' + (bb.minY - pad) + ' ' + (w + pad * 2) + ' ' + (h + pad * 2) +
      '" width="' + (w + pad * 2) + '" height="' + (h + pad * 2) + '">' +
      parts.join('') + '</svg>';
    return {
      uri: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
      width: w + pad * 2, height: h + pad * 2,
      minX: bb.minX - pad, minY: bb.minY - pad
    };
  }
  return null;
};

/* ===== Assign a texture (user artwork preferred, else die-cut SVG crop) ===== */
function assignTexture(mat, key, rect, svgInfo) {
  var userURL = Preview3D.faceTextures[key];
  if (userURL) {
    var img = new Image();
    img.onload = function() {
      var ts = 2;
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(rect.w * ts));
      cv.height = Math.max(1, Math.round(rect.h * ts));
      var ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      // cover-fit the artwork onto the face
      var ir = img.width / img.height, fr = rect.w / rect.h;
      var dw, dh, dx, dy;
      if (ir > fr) { dh = cv.height; dw = dh * ir; dx = (cv.width - dw) / 2; dy = 0; }
      else { dw = cv.width; dh = dw / ir; dx = 0; dy = (cv.height - dh) / 2; }
      ctx.drawImage(img, dx, dy, dw, dh);
      var tex = new THREE.CanvasTexture(cv);
      tex.needsUpdate = true;
      mat.map = tex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    };
    img.src = userURL;
  } else if (svgInfo) {
    var svgImg = new Image();
    svgImg.onload = function() {
      var ts2 = 2;
      var cv2 = document.createElement('canvas');
      cv2.width = Math.max(1, Math.round(rect.w * ts2));
      cv2.height = Math.max(1, Math.round(rect.h * ts2));
      var ctx2 = cv2.getContext('2d');
      ctx2.fillStyle = '#fff8f0';
      ctx2.fillRect(0, 0, cv2.width, cv2.height);
      var sx = rect.x1 - svgInfo.minX, sy = rect.y1 - svgInfo.minY;
      try {
        ctx2.drawImage(svgImg, sx, sy, rect.w, rect.h, 0, 0, cv2.width, cv2.height);
      } catch (e) {}
      var tex2 = new THREE.CanvasTexture(cv2);
      tex2.needsUpdate = true;
      mat.map = tex2;
      mat.needsUpdate = true;
    };
    svgImg.src = svgInfo.uri;
  }
}

/* ===== Geometry helpers (net 2D rect edges) ===== */
function rectEdges(r) {
  // returns 4 edges: {x1,y1,x2,y2,orient:'h'|'v'}
  return [
    { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y1, orient: 'h' }, // top
    { x1: r.x1, y1: r.y2, x2: r.x2, y2: r.y2, orient: 'h' }, // bottom
    { x1: r.x1, y1: r.y1, x2: r.x1, y2: r.y2, orient: 'v' }, // left
    { x1: r.x2, y1: r.y1, x2: r.x2, y2: r.y2, orient: 'v' }  // right
  ];
}
function edgesOverlap(a, b) {
  if (a.orient !== b.orient) return null;
  // Tolerance 3mm: after clipRect() grid cells may shift by 0.5-2mm between
  // neighbouring panels (coarse-grid decomposition places each panel's edges
  // on the nearest grid line, which differs slightly across a crease boundary).
  var TOL = 3;
  if (a.orient === 'h') {
    if (Math.abs(a.y1 - b.y1) > TOL) return null;
    var lo = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
    var hi = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
    if (hi - lo < 5) return null;
    var midY = (a.y1 + b.y1) / 2;   // use average y for the hinge line
    return { x1: lo, y1: midY, x2: hi, y2: midY, orient: 'h', cx: (lo + hi) / 2, cy: midY,
             dir: { x: hi > lo ? 1 : -1, y: 0 }, len: hi - lo };
  } else {
    if (Math.abs(a.x1 - b.x1) > TOL) return null;
    var lo2 = Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
    var hi2 = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
    if (hi2 - lo2 < 5) return null;
    var midX = (a.x1 + b.x1) / 2;   // use average x for the hinge line
    return { x1: midX, y1: lo2, x2: midX, y2: hi2, orient: 'v', cx: midX, cy: (lo2 + hi2) / 2,
             dir: { x: 0, y: hi2 > lo2 ? 1 : -1 }, len: hi2 - lo2 };
  }
}

// UNION coverage of overlap edge `ov` by real crease segments. Returns the
// fraction of `ov`'s length that runs along ANY collinear crease line. This is
// the reliable test for "are these two faces CREASED together (a fold hinge) or
// merely CUT apart?". Cut contacts return 0.00; real folds return ~0.8–1.0.
function creaseCoverFrac(ov, creases) {
  var ivals = [];
  var TOL = 3;   // must match edgesOverlap tolerance
  for (var li = 0; li < creases.length; li++) {
    var L = creases[li];
    for (var pi = 0; pi < L.length - 1; pi++) {
      var p0 = L[pi], p1 = L[pi + 1];
      // Support both object notation {x,y} (from _buildThree extraction)
      // and array notation [x,y] (from convertGeometry output)
      var p0x = p0.x !== undefined ? p0.x : p0[0];
      var p0y = p0.y !== undefined ? p0.y : p0[1];
      var p1x = p1.x !== undefined ? p1.x : p1[0];
      var p1y = p1.y !== undefined ? p1.y : p1[1];
      if (ov.orient === 'h') {
        if (Math.abs(p0y - p1y) > TOL) continue;
        if (Math.abs(p0y - ov.cy) > TOL) continue;   // match against midpoint
        var c0 = Math.min(p0x, p1x), c1 = Math.max(p0x, p1x);
        var lo = Math.max(c0, ov.x1), hi = Math.min(c1, ov.x2);
        if (hi - lo > 1e-6) ivals.push([lo, hi]);
      } else {
        if (Math.abs(p0x - p1x) > TOL) continue;
        if (Math.abs(p0x - ov.cx) > TOL) continue;   // match against midpoint
        var c0y = Math.min(p0y, p1y), c1y = Math.max(p0y, p1y);
        var lo2 = Math.max(c0y, ov.y1), hi2 = Math.min(c1y, ov.y2);
        if (hi2 - lo2 > 1e-6) ivals.push([lo2, hi2]);
      }
    }
  }
  if (!ivals.length) return 0;
  ivals.sort(function (a, b) { return a[0] - b[0]; });
  var total = 0, cl = ivals[0][0], ch = ivals[0][1];
  for (var i = 1; i < ivals.length; i++) {
    if (ivals[i][0] <= ch) ch = Math.max(ch, ivals[i][1]);
    else { total += (ch - cl); cl = ivals[i][0]; ch = ivals[i][1]; }
  }
  total += (ch - cl);
  return total / ov.len;
}

/* ===== Reconstruct face rectangles from die-cut lines (fe) =====
 * Some boxes (e.g. T-series) return an EMPTY de.Face from the API, yet their
 * die-line (drawn from fe cut/crease lines) is perfectly correct. The 3D view
 * needs rectangular panels, so when de.Face is missing we recover them from the
 * same fe geometry the dieline uses. This keeps 2D and 3D in lock-step.
 *
 * Method: build the orthogonal grid from CREASE endpoints, classify each grid
 * cell as "inside the paper" via an even-odd ray cast against CUT segments
 * (tolerates partial creases and rounded-corner arcs), then merge adjacent
 * inside cells unless a crease/cut spans their shared edge. Output is the same
 * { key: [x1,y1,x2,y2] } shape de.Face uses. */
function reconstructFacesFromFE(fe, ox, oy) {
  if (!fe || !fe.length) return null;
  var absOx = Math.abs(ox || 0), absOy = Math.abs(oy || 0);
  var cuts = [], creases = [];
  for (var i = 0; i < fe.length; i++) {
    var e = fe[i], type = e[0], style = e[1];
    if (type === 0) {
      var line = [[e[2] + absOx, e[3] + absOy], [e[4] + absOx, e[5] + absOy]];
      if (style === 0) cuts.push(line); else creases.push(line);
    } else if (type === 1) {
      var cx = e[2] + absOx, cy = e[3] + absOy, r = e[4], sa = e[5], ea2 = e[6];
      var ad = ea2 - sa; while (ad < 0) ad += 360; while (ad >= 360) ad -= 360;
      if (ad === 0 && sa !== ea2) ad = 360;
      var steps = Math.max(16, Math.ceil(Math.abs(ad) / 3)), pts = [];
      for (var s = 0; s <= steps; s++) { var t = s / steps, ang = (sa + ad * t) * Math.PI / 180; pts.push([cx + r * Math.cos(ang), cy - r * Math.sin(ang)]); }
      if (style === 0) cuts.push(pts); else creases.push(pts);
    } else if (type === 2) {
      var p2 = []; for (var j = 2; j < e.length; j += 2) p2.push([e[j] + absOx, e[j + 1] + absOy]);
      if (p2.length >= 2) { if (style === 0) cuts.push(p2); else creases.push(p2); }
    }
  }
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function ub(list) { for (var k = 0; k < list.length; k++) { var p = list[k]; for (var m = 0; m < p.length; m++) { if (p[m][0] < minX) minX = p[m][0]; if (p[m][1] < minY) minY = p[m][1]; if (p[m][0] > maxX) maxX = p[m][0]; if (p[m][1] > maxY) maxY = p[m][1]; } } }
  ub(cuts); ub(creases);
  if (minX === Infinity) { minX = 0; minY = 0; maxX = 100; maxY = 100; }

  var hSegs = [], vSegs = [], cutH = [], cutV = [];
  function addAxis(list, hArr, vArr) {
    for (var li = 0; li < list.length; li++) { var pl = list[li];
      for (var ii = 0; ii + 1 < pl.length; ii++) { var a = pl[ii], b = pl[ii + 1];
        if (Math.abs(a[1] - b[1]) < 1e-6) hArr.push({ y0: a[1], x1: Math.min(a[0], b[0]), x2: Math.max(a[0], b[0]) });
        else if (Math.abs(a[0] - b[0]) < 1e-6) vArr.push({ x0: a[0], y1: Math.min(a[1], b[1]), y2: Math.max(a[1], b[1]) });
      }
    }
  }
  addAxis(creases, hSegs, vSegs);
  addAxis(cuts, cutH, cutV);

  var Xset = {}, Yset = {};
  Xset[minX] = 1; Xset[maxX] = 1; Yset[minY] = 1; Yset[maxY] = 1;
  // Crease endpoints (panel folds) — every rectangle edge should sit on a crease.
  vSegs.forEach(function (s) { Xset[s.x0] = 1; });
  hSegs.forEach(function (s) { Yset[s.y0] = 1; });
  // Cut endpoints (real die boundaries) — rectangles must hug the cut, not over-run it.
  cutV.forEach(function (s) { Xset[s.x0] = 1; });
  cutH.forEach(function (s) { Yset[s.y0] = 1; });
  var XS = Object.keys(Xset).map(Number).sort(function (a, b) { return a - b; });
  var YS = Object.keys(Yset).map(Number).sort(function (a, b) { return a - b; });

  function inside(cx, cy) {
    var cross = 0;
    for (var li = 0; li < cuts.length; li++) { var pl = cuts[li];
      for (var ii = 0; ii + 1 < pl.length; ii++) { var a = pl[ii], b = pl[ii + 1];
        var ya = a[1], yb = b[1];
        if ((ya > cy) !== (yb > cy)) { var xi = a[0] + (b[0] - a[0]) * (cy - ya) / (yb - ya); if (xi > cx) cross++; }
      }
    }
    return (cross % 2) === 1;
  }
  var inG = [];
  for (var xi = 0; xi + 1 < XS.length; xi++) { inG[xi] = [];
    for (var yi = 0; yi + 1 < YS.length; yi++) {
      var xa = XS[xi], xb = XS[xi + 1], ya = YS[yi], yb = YS[yi + 1];
      inG[xi][yi] = (xb - xa >= 1 && yb - ya >= 1) && inside((xa + xb) / 2, (ya + yb) / 2);
    }
  }
  function edgeSpan(segs, isH, fixed, lo, hi) {
    // Crease/cut endpoints are routinely drawn 0.5-1 mm short of each other
    // (manufacturing relief in packmage data). The grid inserts 1 mm sliver
    // cells in those gaps and the flood-fill used to LEAK through them,
    // over-merging panels across a real crease — e.g. T004A's two middle
    // walls (120 + 98 mm) fused into one 218 mm slab that never folds, so the
    // tube could never close. Extend every segment by a small EPS at both
    // ends so the separation test bridges those relief gaps.
    var EPS = 1.5;
    for (var s = 0; s < segs.length; s++) { var g = segs[s];
      if (isH) { if (Math.abs(g.y0 - fixed) < 1e-6) { var ov = Math.min(g.x2 + EPS, hi) - Math.max(g.x1 - EPS, lo); if (ov >= (hi - lo) * 0.5) return true; } }
      else { if (Math.abs(g.x0 - fixed) < 1e-6) { var ov2 = Math.min(g.y2 + EPS, hi) - Math.max(g.y1 - EPS, lo); if (ov2 >= (hi - lo) * 0.5) return true; } }
    }
    return false;
  }
  /* Over-hang is removed by the local re-tile pass further below (retilePanel):
     any panel that over-runs the die is re-tiled on a fine cut-following grid so
     the rectangle hugs the 2D dieline instead of floating outside it. Crease
     (fold) edges are never moved, so folds and face count stay exactly as intended. */
  var owner = [];
  for (var xi2 = 0; xi2 + 1 < XS.length; xi2++) { owner[xi2] = []; for (var yi2 = 0; yi2 + 1 < YS.length; yi2++) owner[xi2][yi2] = -1; }
  var nid = 0;
  for (var xi3 = 0; xi3 + 1 < XS.length; xi3++) { for (var yi3 = 0; yi3 + 1 < YS.length; yi3++) {
    if (!inG[xi3][yi3] || owner[xi3][yi3] !== -1) continue;
    var stack = [[xi3, yi3]]; owner[xi3][yi3] = nid;
    while (stack.length) { var cur = stack.pop(), ci = cur[0], cj = cur[1];
      var neigh = [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]];
      for (var nn = 0; nn < 4; nn++) { var ni = neigh[nn][0], nj = neigh[nn][1];
        if (ni < 0 || nj < 0 || ni + 1 >= XS.length || nj + 1 >= YS.length) continue;
        if (!inG[ni][nj] || owner[ni][nj] !== -1) continue;
        var xa2 = XS[Math.min(ci, ni)], xb2 = XS[Math.max(ci, ni) + 1], ya2 = YS[Math.min(cj, nj)], yb2 = YS[Math.max(cj, nj) + 1];
        var sep = false;
        if (ni === ci + 1) sep = edgeSpan(vSegs, false, XS[ci + 1], ya2, yb2) || edgeSpan(cutV, false, XS[ci + 1], ya2, yb2);
        else if (ni === ci - 1) sep = edgeSpan(vSegs, false, XS[ci], ya2, yb2) || edgeSpan(cutV, false, XS[ci], ya2, yb2);
        else if (nj === cj + 1) sep = edgeSpan(hSegs, true, YS[cj + 1], xa2, xb2) || edgeSpan(cutH, true, YS[cj + 1], xa2, xb2);
        else if (nj === cj - 1) sep = edgeSpan(hSegs, true, YS[cj], xa2, xb2) || edgeSpan(cutH, true, YS[cj], xa2, xb2);
        if (!sep) { owner[ni][nj] = nid; stack.push([ni, nj]); }
      }
    }
    nid++;
  }}
  /* ---- Rectangular decomposition ----
     The old single-bounding-box merge produced panels that stuck out past the
     die-cut (e.g. T004A's lid: the bbox covered the bottom strip + both top tabs,
     but the centre-top is actually a gap, so one rectangle over-filled the paper).
     Here each connected paper-component is tiled with the minimal set of
     axis-aligned rectangles, every one lying entirely inside the paper (no
     overhang). The fold tree consumes rectangles, so this removes the visible
     "panels outside the die-cut" while keeping all real panels. */
  var compCells = {};
  for (var xi4 = 0; xi4 + 1 < XS.length; xi4++) { for (var yi4 = 0; yi4 + 1 < YS.length; yi4++) {
    var id = owner[xi4][yi4]; if (id < 0) continue;
    if (!compCells[id]) compCells[id] = [];
    compCells[id].push([xi4, yi4]);
  }}
  var rects = [];
  Object.keys(compCells).forEach(function (cid) {
    var cells = compCells[cid];
    var mask = {}, covered = {};
    cells.forEach(function (c) { mask[c[0] + ',' + c[1]] = 1; });
    cells.forEach(function (c) {
      var key = c[0] + ',' + c[1];
      if (covered[key]) return;
      var x0 = c[0], x1 = c[0];
      while (mask[(x1 + 1) + ',' + c[1]] && !covered[(x1 + 1) + ',' + c[1]]) x1++;
      var y0 = c[1], y1 = c[1], ok = true;
      while (ok) {
        for (var xx = x0; xx <= x1; xx++) {
          if (!mask[xx + ',' + (y1 + 1)] || covered[xx + ',' + (y1 + 1)]) { ok = false; break; }
        }
        if (ok) y1++;
      }
      for (var xx2 = x0; xx2 <= x1; xx2++) for (var yy2 = y0; yy2 <= y1; yy2++) covered[xx2 + ',' + yy2] = 1;
      rects.push([XS[x0], YS[y0], XS[x1 + 1], YS[y1 + 1]]);
    });
  });
  /* Merge adjacent collinear rects to collapse staircases from slanted edges
     (keep merging while the union stays >=90% inside the paper). */
  var merged = true, guard = 0;
  while (merged && guard++ < 60) {
    merged = false;
    for (var mi = 0; mi < rects.length; mi++) {
      for (var mj = mi + 1; mj < rects.length; mj++) {
        var A = rects[mi], B = rects[mj]; if (!A || !B) continue;
        var canV = (Math.abs(A[2] - B[0]) < 1e-6 || Math.abs(A[0] - B[2]) < 1e-6) && Math.abs(A[1] - B[1]) < 1e-6 && Math.abs(A[3] - B[3]) < 1e-6;
        var canH = (Math.abs(A[3] - B[1]) < 1e-6 || Math.abs(A[1] - B[3]) < 1e-6) && Math.abs(A[0] - B[0]) < 1e-6 && Math.abs(A[2] - B[2]) < 1e-6;
        if (!canV && !canH) continue;
        // Never merge two DIFFERENT panels across a shared CREASE (fold) line —
        // that would weld two faces into one and corrupt the fold tree. Only merge
        // rects of the SAME panel (their shared edge is an internal grid line, not
        // a crease).
        var ux0 = Math.min(A[0], B[0]), uy0 = Math.min(A[1], B[1]), ux1 = Math.max(A[2], B[2]), uy1 = Math.max(A[3], B[3]);
        if (canV) { var sx = (Math.abs(A[2] - B[0]) < 1e-6) ? A[2] : A[0]; if (edgeSpan(vSegs, false, sx, uy0, uy1)) continue; }
        if (canH) { var sy = (Math.abs(A[3] - B[1]) < 1e-6) ? A[3] : A[1]; if (edgeSpan(hSegs, true, sy, ux0, ux1)) continue; }
        var n = 0, tot = 0;
        for (var a = 0; a <= 6; a++) for (var b = 0; b <= 6; b++) { tot++; if (inside(ux0 + (ux1 - ux0) * a / 6, uy0 + (uy1 - uy0) * b / 6)) n++; }
        if (n / tot >= 0.9) { rects[mi] = [ux0, uy0, ux1, uy1]; rects[mj] = null; merged = true; }
      }
    }
    rects = rects.filter(function (r) { return r; });
  }
  /* Second merge pass: merge rectangles with PARTIAL edge overlap.
     Trapezoidal panels may be decomposed into a wide-bottom + narrow-top
     rectangle pair. The first merge pass can't merge them (requires exact
     x/y alignment). This pass allows partial overlap, merging them into a
     bounding-box rectangle if the union is >=85% inside the paper and no
     crease separates them. The ShapeGeometry in _buildThree then clips this
     rectangle to the actual trapezoid shape. */
  var merged2 = true, guard2 = 0;
  while (merged2 && guard2++ < 30) {
    merged2 = false;
    for (var mi2 = 0; mi2 < rects.length; mi2++) {
      for (var mj2 = mi2 + 1; mj2 < rects.length; mj2++) {
        var A2 = rects[mi2], B2 = rects[mj2]; if (!A2 || !B2) continue;
        var sharedY2 = -1;
        if (Math.abs(A2[3] - B2[1]) < 1e-6) sharedY2 = A2[3];
        else if (Math.abs(A2[1] - B2[3]) < 1e-6) sharedY2 = A2[1];
        if (sharedY2 < 0) continue;
        var oxLo = Math.max(A2[0], B2[0]), oxHi = Math.min(A2[2], B2[2]);
        if (oxHi - oxLo < 5) continue;
        var fullXLo = Math.min(A2[0], B2[0]), fullXHi = Math.max(A2[2], B2[2]);
        if (edgeSpan(hSegs, true, sharedY2, fullXLo, fullXHi)) continue;
        var ux02 = Math.min(A2[0], B2[0]), uy02 = Math.min(A2[1], B2[1]);
        var ux12 = Math.max(A2[2], B2[2]), uy12 = Math.max(A2[3], B2[3]);
        var n2 = 0, tot2 = 0;
        for (var a2 = 0; a2 <= 8; a2++) for (var b2 = 0; b2 <= 8; b2++) {
          tot2++; if (inside(ux02 + (ux12 - ux02) * a2 / 8, uy02 + (uy12 - uy02) * b2 / 8)) n2++;
        }
        if (n2 / tot2 >= 0.85) { rects[mi2] = [ux02, uy02, ux12, uy12]; rects[mj2] = null; merged2 = true; }
      }
    }
    rects = rects.filter(function(r) { return r; });
  }
  /* Clip over-hanging panels by ADAPTIVE edge shrinking (NOT re-tiling).
     The OLD retilePanel() shattered large rectangles into dozens of sub-rects
     on a fine grid.  Those sub-rects lost alignment with coarse-grid neighbours,
     creating 2–15 mm gaps that broke fold-tree hinge detection (needs >=8 mm
     shared edge).  Result: 22 isolated faces (including 9700 mm² panels)
     silently disappeared from the 3D view — the "残缺" bug.
     The OLD clipRect used fixed 1.5mm shrink — insufficient for panels where
     an ARC/angled cut slices diagonally across (overhang can be 10+ mm), causing
     the "底部不对" bug where bottom flaps extend far past the die boundary.
     NEW approach — adaptiveClip(r): for each edge, binary-search inward to find
     where the edge first enters the paper, then pad 0.5mm for safety.
     Output is a SINGLE rectangle per panel, preserving neighbour alignment.    */
  function adaptiveClip(r) {
    var x1 = r[0], y1 = r[1], x2 = r[2], y2 = r[3];
    var w = x2 - x1, h = y2 - y1;
    if (w < 4 || h < 4) return r;

    var Nsamp = 32;
    function edgeFrac(ax, ay, bx, by) {
      var n = 0;
      for (var i = 0; i <= Nsamp; i++) {
        var t = i / Nsamp, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        if (inside(px, py)) n++;
      }
      return n / (Nsamp + 1);
    }

    // Quick check: if edge is fully inside (>95%), don't trim it at all
    var FULL_THRESH = 0.95;
    var tF = edgeFrac(x1, y1, x2, y1), bF = edgeFrac(x1, y2, x2, y2);
    var lF = edgeFrac(x1, y1, x1, y2), rF = edgeFrac(x2, y1, x2, y2);

    // For edges that need trimming, use binary search to find exact clip point
    function findClipInward(ax, ay, bx, by, frac) {
      if (frac >= FULL_THRESH) return null; // no trim needed
      // Binary search: find distance d from start where edge enters paper
      var lo = 0, hi = 1;
      for (var iter = 0; iter < 12; iter++) {
        var mid = (lo + hi) / 2;
        var mx = ax + (bx - ax) * mid, my = ay + (by - ay) * mid;
        // Check if point mid is inside AND the segment from mid to end has >50% inside
        var midIn = inside(mx, my);
        var tailFrac = edgeFrac(mx, my, bx, by);
        if (midIn && tailFrac > 0.5) { lo = mid; } else { hi = mid; }
      }
      // Return the clip position: at 'lo' (just inside), plus 0.5mm safety padding
      var tClip = Math.max(0, lo - 0.005); // small nudge inward
      return { x: ax + (bx - ax) * tClip, y: ay + (by - ay) * tClip };
    }

    var cx1 = x1, cy1 = y1, cx2 = x2, cy2 = y2;

    // Trim top edge (y = y1, moving downward → increase y1)
    if (tF < FULL_THRESH) {
      var tp = findClipInward(x1, y1, x2, y1, tF);
      if (tp) cy1 = tp.y + 0.5; // 0.5mm safety
    }
    // Trim bottom edge (y = y2, moving upward → decrease y2)
    if (bF < FULL_THRESH) {
      var bp = findClipInward(x1, y2, x2, y2, bF);
      if (bp) cy2 = bp.y - 0.5;
    }
    // Trim left edge (x = x1, moving rightward → increase x1)
    if (lF < FULL_THRESH) {
      var lp = findClipInward(x1, y1, x1, y2, lF);
      if (lp) cx1 = lp.x + 0.5;
    }
    // Trim right edge (x = x2, moving leftward → decrease x2)
    if (rF < FULL_THRESH) {
      var rp = findClipInward(x2, y1, x2, y2, rF);
      if (rp) cx2 = rp.x - 0.5;
    }

    if (cx2 - cx1 < 4 || cy2 - cy1 < 4) return r;
    return [cx1, cy1, cx2, cy2];
  }

  var CLIP_THRESH = 0.04;
  var clipped = [];
  rects.forEach(function (r) {
    var w = r[2] - r[0], h = r[3] - r[1], Nchk = 12, out = 0, tot = 0;
    for (var a = 0; a <= Nchk; a++) for (var b = 0; b <= Nchk; b++) { tot++; if (!inside(r[0] + w * a / Nchk, r[1] + h * b / Nchk)) out++; }
    if (tot > 0 && out / tot > CLIP_THRESH) {
      clipped.push(adaptiveClip(r));
    } else {
      clipped.push(r);
    }
  });
  rects = clipped;
  /* drop sub-1mm slivers */
  var out = {}, idx = 0;
  rects.forEach(function (r) {
    if (r[2] - r[0] < 1 || r[3] - r[1] < 1) return;
    out['F' + idx] = r; idx++;
  });
  return idx > 0 ? out : null;
}

/* ===== Extract TRUE face polygons directly from the FE line network =====
 * This is the Packmage-style approach: the die-cut is a planar straight-line
 * graph (cut + crease lines). Each panel is a region of that planar subdivision,
 * so we build the planar graph, walk every face, and keep the interior regions
 * as real polygons (trapezoids, rectangles, anything). No rectangle-overfill and
 * no brittle ray-cast clipping — the polygon IS the panel shape.
 * Returns an array of { pts:[[x,y]...], cx, cy, x1,y1,x2,y2, w, h, area }.
 */
function extractPlanarFaces(fe, ox, oy) {
  if (!fe || !fe.length) return [];
  var absOx = Math.abs(ox || 0), absOy = Math.abs(oy || 0);

  // 1. Expand FE elements into polyline segments (both cut + crease).
  var segs = [];
  for (var i = 0; i < fe.length; i++) {
    var e = fe[i], type = e[0], style = e[1], pts = [];
    if (type === 0) {
      pts = [[e[2] + absOx, e[3] + absOy], [e[4] + absOx, e[5] + absOy]];
    } else if (type === 1) {
      var cx = e[2] + absOx, cy = e[3] + absOy, r = e[4], sa = e[5], ea = e[6];
      var ad = ea - sa; while (ad < 0) ad += 360; while (ad >= 360) ad -= 360;
      if (ad === 0 && sa !== ea) ad = 360;
      var steps = Math.max(16, Math.ceil(Math.abs(ad) / 3));
      for (var s = 0; s <= steps; s++) {
        var ang = (sa + ad * s / steps) * Math.PI / 180;
        pts.push([cx + r * Math.cos(ang), cy - r * Math.sin(ang)]);
      }
    } else if (type === 2) {
      for (var j = 2; j < e.length; j += 2) pts.push([e[j] + absOx, e[j + 1] + absOy]);
    }
    for (var k = 0; k + 1 < pts.length; k++) segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
  }

  // 2. Split segments wherever they cross, so the graph is planar.
  function r3(p) { return Math.round(p * 1000) / 1000; }
  function key(p) { return r3(p[0]) + ',' + r3(p[1]); }
  function intersect(s1, s2) {
    var x1 = s1[0], y1 = s1[1], x2 = s1[2], y2 = s1[3];
    var x3 = s2[0], y3 = s2[1], x4 = s2[2], y4 = s2[3];
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x4 - x3)) / den;
    var u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x2 - x1)) / den;
    if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }
  var changed = true, guard = 0;
  while (changed && guard < 16) {
    changed = false; guard++;
    var seen = {};
    for (var si = 0; si < segs.length; si++) {
      seen[key([segs[si][0], segs[si][1]])] = 1; seen[key([segs[si][2], segs[si][3]])] = 1;
    }
    for (var a = 0; a < segs.length && !changed; a++) {
      for (var b = a + 1; b < segs.length; b++) {
        var ip = intersect(segs[a], segs[b]);
        if (!ip) continue;
        var ik = key(ip);
        if (seen[ik]) continue;
        seen[ik] = 1; changed = true;
        var s1c = segs[a]; segs[a] = [s1c[0], s1c[1], ip[0], ip[1]]; segs.push([ip[0], ip[1], s1c[2], s1c[3]]);
        var s2c = segs[b]; segs[b] = [s2c[0], s2c[1], ip[0], ip[1]]; segs.push([ip[0], ip[1], s2c[2], s2c[3]]);
        break;
      }
    }
  }

  // 3. Build adjacency (each vertex -> sorted list of neighbours with angle).
  var vmap = {}, verts = [];
  function vid(p) {
    var k = key(p);
    if (!(k in vmap)) { vmap[k] = verts.length; verts.push([p[0], p[1]]); }
    return vmap[k];
  }
  var adj = {};
  for (var gi = 0; gi < segs.length; gi++) {
    var s = segs[gi];
    var a = vid([s[0], s[1]]), b = vid([s[2], s[3]]);
    if (a === b) continue;
    var ax = verts[a][0], ay = verts[a][1], bx = verts[b][0], by = verts[b][1];
    adj[a] = adj[a] || []; adj[a].push([b, Math.atan2(by - ay, bx - ax)]);
    adj[b] = adj[b] || []; adj[b].push([a, Math.atan2(ay - by, ax - bx)]);
  }
  for (var vk in adj) adj[vk].sort(function (p, q) { return p[1] - q[1]; });

  // 4. Walk every face (turn right / previous edge in CCW-sorted adjacency).
  var used = {}, faces = [];
  for (var v in adj) {
    v = +v; // for-in yields string keys; vertex indices are numeric -> coerce so comparisons below are type-safe
    var edges0 = adj[v];
    for (var ei = 0; ei < edges0.length; ei++) {
      var n0 = edges0[ei][0];
      if (used[v + ',' + n0]) continue;
      var poly = [verts[v].slice()], cur = n0, came = v, usedKey;
      used[v + ',' + n0] = true;
      var steps2 = 0;
      while (steps2++ < 4000) {
        var es = adj[cur] || [];
        var idx = -1;
        for (var k2 = 0; k2 < es.length; k2++) { if (es[k2][0] === came) { idx = k2; break; } }
        if (idx === -1) break;
        var nx = es[(idx - 1 + es.length) % es.length];
        usedKey = cur + ',' + nx[0];
        used[usedKey] = true;
        poly.push(verts[nx[0]].slice());
        came = cur; cur = nx[0];
        if (cur === v) break;
      }
      if (poly.length >= 3) {
        var dp = [poly[0]];
        for (var di = 1; di < poly.length; di++) {
          var dx = poly[di][0] - dp[dp.length - 1][0], dy = poly[di][1] - dp[dp.length - 1][1];
          if (dx * dx + dy * dy > 1e-8) dp.push(poly[di]);
        }
        if (dp.length >= 3) faces.push(dp);
      }
    }
  }

  // 5. Keep interior faces (drop the outer/background face + degenerate slivers).
  function polyArea(p) {
    var a = 0;
    for (var i = 0; i < p.length; i++) {
      var x1 = p[i][0], y1 = p[i][1], x2 = p[(i + 1) % p.length][0], y2 = p[(i + 1) % p.length][1];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  }
  // sort by |area| desc; index 0 is the outer face (largest) -> drop it
  faces.sort(function (p, q) { return Math.abs(polyArea(q)) - Math.abs(polyArea(p)); });
  var result = [];
  for (var fi = 1; fi < faces.length; fi++) {
    var fp = faces[fi], a = Math.abs(polyArea(fp));
    if (a < 1) continue; // drop slivers
    var xs = [], ys = [];
    for (var pi = 0; pi < fp.length; pi++) { xs.push(fp[pi][0]); ys.push(fp[pi][1]); }
    var x1 = Math.min.apply(null, xs), y1 = Math.min.apply(null, ys);
    var x2 = Math.max.apply(null, xs), y2 = Math.max.apply(null, ys);
    var cx = 0, cy = 0; for (var ci = 0; ci < fp.length; ci++) { cx += fp[ci][0]; cy += fp[ci][1]; }
    cx /= fp.length; cy /= fp.length;
    // simplify: drop near-collinear middle points (keep corners)
    var simp = [fp[0]];
    for (var si2 = 1; si2 < fp.length - 1; si2++) {
      var p0 = fp[si2 - 1], p1 = fp[si2], p2 = fp[si2 + 1];
      var cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      var len = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
      if (Math.abs(cross) > 1e-3 * (len + 1)) simp.push(p1); // keep if not collinear
    }
    simp.push(fp[fp.length - 1]);
    if (simp.length < 3) simp = fp;
    result.push({ pts: simp, cx: cx, cy: cy, x1: x1, y1: y1, x2: x2, y2: y2, w: x2 - x1, h: y2 - y1, area: a });
  }
  return result;
}

/* Sutherland-Hodgman clip of a polygon to an axis-aligned rect R=[x1,y1,x2,y2].
 * Used to split a (possibly merged) extracted face into the exact panel region
 * defined by a faceData rect, so each panel keeps its true shape but sits at the
 * correct position/size. */
function clipPolyToRect(pts, R) {
  var edges = [
    { axis: 'x', val: R[0], sign: 1 }, { axis: 'x', val: R[2], sign: -1 },
    { axis: 'y', val: R[1], sign: 1 }, { axis: 'y', val: R[3], sign: -1 }
  ];
  var out = pts;
  for (var e = 0; e < edges.length; e++) {
    var ed = edges[e]; var input = out; out = [];
    if (!input.length) break;
    for (var i = 0; i < input.length; i++) {
      var cur = input[i], prev = input[(i + input.length - 1) % input.length];
      var curIn, prevIn;
      if (ed.axis === 'x') { curIn = ed.sign > 0 ? cur[0] >= ed.val : cur[0] <= ed.val; prevIn = ed.sign > 0 ? prev[0] >= ed.val : prev[0] <= ed.val; }
      else { curIn = ed.sign > 0 ? cur[1] >= ed.val : cur[1] <= ed.val; prevIn = ed.sign > 0 ? prev[1] >= ed.val : prev[1] <= ed.val; }
      if (curIn) { if (!prevIn) out.push(_clipIntersect(prev, cur, ed)); out.push(cur); }
      else if (prevIn) { out.push(_clipIntersect(prev, cur, ed)); }
    }
    if (!out.length) break;
  }
  return out;
}
function _clipIntersect(p1, p2, ed) {
  if (ed.axis === 'x') { var t = (ed.val - p1[0]) / (p2[0] - p1[0]); return [ed.val, p1[1] + t * (p2[1] - p1[1])]; }
  var t2 = (ed.val - p1[1]) / (p2[1] - p1[1]); return [p1[0] + t2 * (p2[0] - p1[0]), ed.val];
}
function polyArea(p) { var a = 0; for (var i = 0; i < p.length; i++) { var x1 = p[i][0], y1 = p[i][1], x2 = p[(i + 1) % p.length][0], y2 = p[(i + 1) % p.length][1]; a += x1 * y2 - x2 * y1; } return a / 2; }

/* Map planar polygons onto the existing faceData keys (so hinge logic & fold
 * transforms keep working). For each face rect we pick the extracted face that
 * best represents it (overlap + centroid-inside, weighted by face area so a real
 * panel beats a tiny sliver), then CLIP that face to the rect. This splits merged
 * faces per-panel and keeps true shapes. If the clipped result is degenerate or
 * far smaller than the rect, fall back to the rectangle. */
function matchPlanarToFaces(planarFaces, faceData) {
  var map = {};
  if (!planarFaces || !planarFaces.length || !faceData) return map;
  planarFaces.forEach(function (pf) {
    var xs = [], ys = [];
    pf.pts.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
    pf._bb = [Math.min.apply(0, xs), Math.min.apply(0, ys), Math.max.apply(0, xs), Math.max.apply(0, ys)];
  });
  Object.keys(faceData).forEach(function (key) {
    var R = faceData[key];
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < planarFaces.length; i++) {
      var pf = planarFaces[i], bb = pf._bb;
      var ox = Math.min(bb[2], R[2]) - Math.max(bb[0], R[0]);
      var oy = Math.min(bb[3], R[3]) - Math.max(bb[1], R[1]);
      if (ox <= 0 || oy <= 0) continue;
      var ov = ox * oy;
      var inside = pf.cx >= R[0] && pf.cx <= R[2] && pf.cy >= R[1] && pf.cy <= R[3];
      var score = ov + (inside ? pf.area * 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = pf; }
    }
    var poly;
    if (best) poly = clipPolyToRect(best.pts, R);
    var rectArea = Math.abs((R[2] - R[0]) * (R[3] - R[1]));
    if (!poly || poly.length < 3 || Math.abs(polyArea(poly)) < rectArea * 0.05) {
      poly = [[R[0], R[1]], [R[2], R[1]], [R[2], R[3]], [R[0], R[3]]];
    }
    map[key] = poly;
  });
  return map;
}


/* ===== Build the full Three.js scene ===== */
Preview3D._buildThree = function(container, boxType, params, faceData, isReconstructed) {
  // Cache for quick texture updates
  Preview3D._cache = { boxType: boxType, faceData: faceData, params: params, container: container };

  // Always start from a clean container. When this is reached via _fetchAndRender,
  // the container still holds the "正在加载 3D 数据…" placeholder — leaving it in
  // place makes the loading text stick above the canvas (looked like "stuck loading").
  container.innerHTML = '';

  var svgInfo = Preview3D._generateSVGDataURI(boxType);

  function fr(name) {
    var r = faceData[name];
    if (!r) return null;
    return { x1: r[0], y1: r[1], x2: r[2], y2: r[3],
             w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]),
             cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2 };
  }

  var M = {};
  ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'].forEach(function(k) { M[k] = fr(k); });

  // Reference panel for the L/W/D readout, camera distance and light placement.
  // Prefer M0, else fall back to the largest face: book-style / display boxes name
  // their faces MS31/M45/M71/… and have no M0 at all, and used to be dumped to the
  // plain CSS box even though the crease-hierarchy fold never needed M0.
  var areaOf = {};
  var faceKeys = Object.keys(faceData).filter(function(k) { return !!fr(k); });
  faceKeys.forEach(function(k) { var r = fr(k); areaOf[k] = r.w * r.h; });
  if (!faceKeys.length) { Preview3D._renderSimple(container, boxType, params); return; }
  var root = faceKeys.slice().sort(function(a, b) { return areaOf[b] - areaOf[a]; })[0];
  var refR = fr(M.M0 ? 'M0' : root);

  var L = refR.w, D = refR.h;
  var W = M.M1 ? M.M1.w : (M.M3 ? M.M3.w : Math.min(L, D) * 0.6);

  // ---- Three.js setup ----
  // Use the container's REAL size (not a hard-coded 560) so the 3D view fills the
  // area on every screen — especially short phones where a fixed 560px canvas
  // would overflow / get clipped by overflow:hidden.
  var containerW = container.clientWidth || 800;
  var containerH = container.clientHeight || 560;
  if (containerH < 120) containerH = 560;   // guard against a not-yet-laid-out box
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f0);
  var camera = new THREE.PerspectiveCamera(40, containerW / containerH, 1, 5000);
  var renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(containerW, containerH);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  container._threeRenderer = renderer;
  // Expose for debugging/screenshot
  window._p3dScene = scene;
  window._p3dCamera = camera;
  window._p3dRenderer = renderer;

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  var dl1 = new THREE.DirectionalLight(0xffffff, 0.4); dl1.position.set(L, D, W); scene.add(dl1);
  var dl2 = new THREE.DirectionalLight(0xffffff, 0.18); dl2.position.set(-L, -D / 2, -W); scene.add(dl2);

  var viewGroup = new THREE.Group();   // holds view (rotateX/Y) only
  scene.add(viewGroup);
  var boxGroup = new THREE.Group();    // holds fold state (net <-> box)
  viewGroup.add(boxGroup);
  Preview3D._flapPivots = [];

  // ---- Crease-hierarchy hinge fold (packmage-style) ----
  // Every face is parented to its parent face in the scene graph. A hinge Group
  // sits ON the shared crease edge and rotates the child 0..90deg about that edge.
  // Folding = animating the hinge ANGLE (never lerping absolute poses), so flaps
  // ride with their parent and the carton assembles exactly like the real thing.
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  Object.keys(faceData).forEach(function(k) {
    var r = fr(k); if (!r) return;
    minX = Math.min(minX, r.x1); maxX = Math.max(maxX, r.x2);
    minY = Math.min(minY, r.y1); maxY = Math.max(maxY, r.y2);
  });
  var bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2;

  // Parent tree + hinge (crease) edges, grown from the largest face (`root` above).
  // Two rectangles can touch in the net WITHOUT being creased together — they are
  // merely CUT apart. In A038 the top panel M2 sits flush against the top flap S3B,
  // yet the real crease of S3B runs along the wall M3 below it. In B001 the four
  // top flaps S0T/S1T/S2T/S3T sit flush against EACH OTHER along cut lines, so pure
  // geometry cannot tell a flap from its neighbour. The reliable fix (see below): a
  // hinge is only accepted where a real CREASE line runs along the shared edge —
  // cut contacts are rejected outright. Among accepted hinges we still grow the
  // tree Prim-style (best coverage first) so a long fold wins over a stub.
  function edgeLen(e) { return Math.abs(e.x2 - e.x1) + Math.abs(e.y2 - e.y1); }

  // Real crease (fold) lines, when the die geometry is available. A fold hinge
  // exists ONLY where a crease runs along the shared edge — never where the two
  // faces are merely CUT apart. Geometry-only adjacency cannot tell the
  // difference and used to glue a flap to its neighbour instead of its wall
  // (the B001 bug: top flaps S0T/S1T/S2T/S3T sat flush against each other along
  // cut lines yet scored full coverage). convertGeometry's output is in the same
  // coordinate frame as de.Face (confirmed: the crease bbox sits inside the face
  // bbox), so shared-edge vs crease comparison is direct.
  //
  // Crease (fold) lines — authoritative source for which shared edges are real
  // hinges vs. mere cut contacts (adjacent in the net but separate pieces).
  //
  // For pre-computed de.Face (packmage server): use convertGeometry output.
  // For reconstructed faces: extract crease polylines DIRECTLY from fe (style≠0
  // segments, offset-corrected to match face coordinates). This avoids the
  // misalignment that killed hinges when using convertGeometry on reconstructed
  // faces, while still filtering out cut contacts that would produce wrong folds.
  var creases = null;
  var _bd = boxType.currentBoxData || boxType.packmageData;
  if (_bd && _bd.fe) {
    try {
      var absOx = Math.abs(_bd.de ? _bd.de.ox : 0);
      var absOy = Math.abs(_bd.de ? _bd.de.oy : 0);
      var rawCreases = [];
      _bd.fe.forEach(function (f) {
        if (f[1] === 0) return;   // style 0 = cut line, skip
        var pts;
        if (f[0] === 0) {       // straight line segment
          pts = [{ x: f[2] + absOx, y: f[3] + absOy }, { x: f[4] + absOx, y: f[5] + absOy }];
        } else if (f[0] === 1) { // arc — expand to polyline (same format as reconstructFacesFromFE)
          var _acx = f[2] + absOx, _acy = f[3] + absOy, _ar = f[4], _asa = f[5], _aea = f[6];
          var _aad = _aea - _asa; while (_aad < 0) _aad += 360; while (_aad >= 360) _aad -= 360;
          if (_aad === 0 && _asa !== _aea) _aad = 360;
          var _asteps = Math.max(16, Math.ceil(Math.abs(_aad) / 3));
          pts = [];
          for (var _as = 0; _as <= _asteps; _as++) {
            var _at = _as / _asteps, _aang = (_asa + _aad * _at) * Math.PI / 180;
            pts.push({ x: _acx + _ar * Math.cos(_aang), y: _acy - _ar * Math.sin(_aang) });
          }
        } else if (f[0] === 2) { // polyline
          pts = [];
          for (var pi = 2; pi < f.length; pi += 2) pts.push({ x: f[pi] + absOx, y: f[pi + 1] + absOy });
        }
        if (pts && pts.length >= 2) rawCreases.push(pts);
      });
      creases = rawCreases;
    } catch (e) { creases = null; }
  }
  // Fallback: try convertGeometry if raw extraction yielded nothing (e.g. API data)
  if (!creases && !isReconstructed && typeof PackmageBoxTypes !== 'undefined' && PackmageBoxTypes.convertGeometry) {
    try {
      var _cg = PackmageBoxTypes.convertGeometry(_bd.fe, _bd.de ? _bd.de.ox : 0, _bd.de ? _bd.de.oy : 0);
      creases = _cg.creases;
    } catch (e) { /* keep null */ }
  }

  // ---- Extract CUT lines for paper-boundary clipping (ShapeGeometry) ----
  // Used to clip each face rectangle to the actual die-cut shape, so
  // trapezoidal / non-rectangular panels render correctly in 3D.
  var cuts3d = null;
  if (_bd && _bd.fe) {
    try {
      var rawCuts3d = [];
      _bd.fe.forEach(function (f) {
        if (f[1] !== 0) return;   // style 0 = cut line only
        var pts;
        if (f[0] === 0) {
          pts = [{ x: f[2] + absOx, y: f[3] + absOy }, { x: f[4] + absOx, y: f[5] + absOy }];
        } else if (f[0] === 1) {
          var _acx2 = f[2] + absOx, _acy2 = f[3] + absOy, _ar2 = f[4], _asa2 = f[5], _aea2 = f[6];
          var _aad2 = _aea2 - _asa2; while (_aad2 < 0) _aad2 += 360; while (_aad2 >= 360) _aad2 -= 360;
          if (_aad2 === 0 && _asa2 !== _aea2) _aad2 = 360;
          var _asteps2 = Math.max(16, Math.ceil(Math.abs(_aad2) / 3));
          pts = [];
          for (var _as2 = 0; _as2 <= _asteps2; _as2++) {
            var _at2 = _as2 / _asteps2, _aang2 = (_asa2 + _aad2 * _at2) * Math.PI / 180;
            pts.push({ x: _acx2 + _ar2 * Math.cos(_aang2), y: _acy2 - _ar2 * Math.sin(_aang2) });
          }
        } else if (f[0] === 2) {
          pts = [];
          for (var pi3 = 2; pi3 < f.length; pi3 += 2) pts.push({ x: f[pi3] + absOx, y: f[pi3 + 1] + absOy });
        }
        if (pts && pts.length >= 2) rawCuts3d.push(pts);
      });
      cuts3d = rawCuts3d;
    } catch (e) { cuts3d = null; }
  }

  // ---- Extract TRUE panel polygons from the FE line network (Packmage-style) ----
  // Gives the real shape of every panel (trapezoids, etc.) without the rectangle
  // over-fill or the brittle ray-cast clipping that produced fragment artifacts.
  var planarPolys = {};
  try {
    if (_bd && _bd.fe && typeof extractPlanarFaces === 'function') {
      var _pf = extractPlanarFaces(_bd.fe, absOx, absOy);
      planarPolys = matchPlanarToFaces(_pf, faceData);
    }
  } catch (e) { planarPolys = {}; }
  Preview3D._planarPolys = planarPolys;
  // Paper-boundary inside test (even-odd ray cast against CUT polylines)
  function inside3d(cx, cy) {
    if (!cuts3d) return true;
    var cross = 0;
    for (var li = 0; li < cuts3d.length; li++) {
      var pl = cuts3d[li];
      for (var ii = 0; ii + 1 < pl.length; ii++) {
        var a = pl[ii], b = pl[ii + 1];
        var ya = a.y, yb = b.y;
        if ((ya > cy) !== (yb > cy)) {
          var xi = a.x + (b.x - a.x) * (cy - ya) / (yb - ya);
          if (xi > cx) cross++;
        }
      }
    }
    return (cross % 2) === 1;
  }
  // Compute the actual panel polygon by clipping the face rectangle to the
  // paper boundary. For trapezoidal panels, this produces a polygon that
  // follows the slanted cut edges instead of the rectangle's straight edges.
  function computePanelPolygon(x1, y1, x2, y2) {
    var N = 50;
    var poly = [];
    var edges = [
      [x1, y1, x2, y1],   // top: left → right
      [x2, y1, x2, y2],   // right: top → bottom
      [x2, y2, x1, y2],   // bottom: right → left
      [x1, y2, x1, y1]    // left: bottom → top
    ];
    for (var ei = 0; ei < 4; ei++) {
      var ex1 = edges[ei][0], ey1 = edges[ei][1], ex2 = edges[ei][2], ey2 = edges[ei][3];
      var prevIn = inside3d(ex1, ey1);
      for (var i = 1; i <= N; i++) {
        var t = i / N;
        var px = ex1 + (ex2 - ex1) * t, py = ey1 + (ey2 - ey1) * t;
        var curIn = inside3d(px, py);
        if (prevIn && curIn) {
          if (poly.length > 0) { poly[poly.length - 1][0] = px; poly[poly.length - 1][1] = py; }
          else { poly.push([px, py]); }
        } else if (!prevIn && curIn) {
          var tLo = (i - 1) / N, tHi = t;
          for (var iter = 0; iter < 15; iter++) {
            var mid = (tLo + tHi) / 2;
            if (inside3d(ex1 + (ex2 - ex1) * mid, ey1 + (ey2 - ey1) * mid)) tLo = mid; else tHi = mid;
          }
          poly.push([ex1 + (ex2 - ex1) * tLo, ey1 + (ey2 - ey1) * tLo]);
          poly.push([px, py]);
        } else if (prevIn && !curIn) {
          var tLo2 = (i - 1) / N, tHi2 = t;
          for (var iter2 = 0; iter2 < 15; iter2++) {
            var mid2 = (tLo2 + tHi2) / 2;
            if (inside3d(ex1 + (ex2 - ex1) * mid2, ey1 + (ey2 - ey1) * mid2)) tLo2 = mid2; else tHi2 = mid2;
          }
          // Update last point to the exit crossing (avoids extra redundant vertex)
          if (poly.length > 0) {
            poly[poly.length - 1][0] = ex1 + (ex2 - ex1) * tLo2;
            poly[poly.length - 1][1] = ey1 + (ey2 - ey1) * tLo2;
          }
        }
        prevIn = curIn;
      }
    }
    return poly;
  }

  // Build hinge candidates sorted by ABSOLUTE overlap length. Real fold hinges
  // (200 mm wall edges) always beat accidental cut contacts (8 mm corner touches)
  // because a genuine hinge shares the FULL edge length of at least one panel.
  var allPairs = [];
  for (var ai = 0; ai < faceKeys.length; ai++) {
    for (var bi = ai + 1; bi < faceKeys.length; bi++) {
      var ea = rectEdges(fr(faceKeys[ai])), eb = rectEdges(fr(faceKeys[bi]));
      var bestOv = null, bestLen = -1;
      for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
        var o = edgesOverlap(ea[i], eb[j]);
        if (!o || o.len <= 8) continue;
        if (o.len > bestLen) { bestLen = o.len; bestOv = o; }
      }
      if (bestOv && bestLen >= 8) {
        var cov = creases ? creaseCoverFrac(bestOv, creases) : 1;
        allPairs.push({ a: faceKeys[ai], b: faceKeys[bi], ov: bestOv, len: bestLen,
                         score: bestLen * (cov > 0.01 ? 1 : 0.5) });
      }
    }
  }
  allPairs.sort(function (x, y) { return y.len - x.len });   // longest first

  // Greedy tree build: always pick the longest remaining edge that connects an
  // already-visited face to an unvisited one. This guarantees real fold hinges
  // connect before cut contacts can steal a parent from the correct wall panel.
  var parentOf = {}, hingeOf = {}, vis = {}; vis[root] = true;
  var usedEdge = {};
  while (true) {
    var pick = null;
    for (var pi = 0; pi < allPairs.length; pi++) {
      var p = allPairs[pi];
      if (usedEdge[p.a + ',' + p.b]) continue;
      var canA = vis[p.a] && !vis[p.b];
      var canB = vis[p.b] && !vis[p.a];
      if (!canA && !canB) continue;
      pick = canA ? { p: p.a, k: p.b, ov: p.ov } : { p: p.b, k: p.a, ov: p.ov };
      break;   // first valid = longest (sorted above)
    }
    if (!pick) break;
    parentOf[pick.k] = pick.p;
    hingeOf[pick.k] = pick.ov;
    vis[pick.k] = true;
    usedEdge[pick.p + ',' + pick.k] = 1;
  }
  // Pass 2: rescue any orphaned face (no crease-aligned hinge, or only a short
  // partial overlap) by connecting it to the tree through its best geometric
  // edge. Guarantees every face present in de.face also renders in 3D.
  if (Object.keys(vis).length < faceKeys.length) {
    var rescue = [];
    for (var ai2 = 0; ai2 < faceKeys.length; ai2++) {
      for (var bi2 = ai2 + 1; bi2 < faceKeys.length; bi2++) {
        var ea2 = rectEdges(fr(faceKeys[ai2])), eb2 = rectEdges(fr(faceKeys[bi2]));
        var bOv = null, bSc = -1;
        for (var i2 = 0; i2 < 4; i2++) for (var j2 = 0; j2 < 4; j2++) {
          var o2 = edgesOverlap(ea2[i2], eb2[j2]);
          if (!o2 || o2.len <= 1) continue;
          var sc2 = Math.min(o2.len / Math.max(1, edgeLen(ea2[i2])),
                             o2.len / Math.max(1, edgeLen(eb2[j2])));
          if (sc2 > bSc) { bSc = sc2; bOv = o2; }
        }
        if (bOv && bSc >= 0.15) rescue.push({ a: faceKeys[ai2], b: faceKeys[bi2], ov: bOv, score: bSc });
      }
    }
    rescue.sort(function(x, y) { return y.score - x.score; });
    for (;;) {
      var rpick = null;
      for (var ri = 0; ri < rescue.length; ri++) {
        var rc2 = rescue[ri];
        if (vis[rc2.a] && !vis[rc2.b]) { rpick = { p: rc2.a, k: rc2.b, ov: rc2.ov }; break; }
        if (vis[rc2.b] && !vis[rc2.a]) { rpick = { p: rc2.b, k: rc2.a, ov: rc2.ov }; break; }
      }
      if (!rpick) break;
      parentOf[rpick.k] = rpick.p; hingeOf[rpick.k] = rpick.ov; vis[rpick.k] = true;
    }
    // Pass 2b: force-rescue any remaining orphan with area > 300mm² by connecting
    // it through its best geometric edge regardless of score. This catches tiny
    // flaps / glue tabs that are physically separated from the main body by >1mm
    // gaps (common after clipRect grid misalignment). Without this, they silently
    // disappear from the 3D view — the "missing panels" bug.
    var stillOrphan = faceKeys.filter(function(k) { return !vis[k]; });
    if (stillOrphan.length) {
      for (var fi = 0; fi < stillOrphan.length; fi++) {
        var fk = stillOrphan[fi];
        var fR = fr(fk);
        if (!fR || fR.w * fR.h < 300) continue;   // skip tiny slivers
        var bestFov = null, bestFsc = -1, bestFother = null;
        for (var oi = 0; oi < faceKeys.length; oi++) {
          var ok = faceKeys[oi]; if (ok === fk || !vis[ok]) continue;
          var fea = rectEdges(fR), feb = rectEdges(fr(ok));
          for (var ei = 0; ei < 4; ei++) for (var ej = 0; ej < 4; ej++) {
            var fov = edgesOverlap(fea[ei], feb[ej]);
            var relaxed = false;
            // Relaxed fallback: allow up to 3 mm gap (reconstruction quantization)
            if (!fov) {
              fov = (function(a,b){
                if (a.orient!==b.orient) return null;
                var TOL=4;
                if (a.orient==='h') {
                  if (Math.abs(a.y1-b.y1)>TOL) return null;
                  var lo=Math.max(Math.min(a.x1,a.x2),Math.min(b.x1,b.x2));
                  var hi=Math.min(Math.max(a.x1,a.x2),Math.max(b.x1,b.x2));
                  if (hi-lo<-3) return null;
                  var my=(a.y1+b.y1)/2;
                  return {x1:lo,y1:my,x2:hi,y2:my,orient:'h',cx:(lo+hi)/2,cy:my,dir:{x:hi>lo?1:-1,y:0},len:Math.max(0,hi-lo)};
                } else {
                  if (Math.abs(a.x1-b.x1)>TOL) return null;
                  var lo2=Math.max(Math.min(a.y1,a.y2),Math.min(b.y1,b.y2));
                  var hi2=Math.min(Math.max(a.y1,a.y2),Math.max(b.y1,b.y2));
                  if (hi2-lo2<-3) return null;
                  var mx=(a.x1+b.x1)/2;
                  return {x1:mx,y1:lo2,x2:mx,y2:hi2,orient:'v',cx:mx,cy:(lo2+hi2)/2,dir:{x:0,y:hi2>lo2?1:-1},len:Math.max(0,hi2-lo2)};
                }
              })(fea[ei], feb[ej]);
              relaxed = true;
            }
            if (!fov || (!relaxed && fov.len < 1)) continue;
            var fsc = Math.min(fov.len / Math.max(1, edgeLen(fea[ei])),
                               fov.len / Math.max(1, edgeLen(feb[ej])));
            if (fsc > bestFsc) { bestFsc = fsc; bestFov = fov; bestFother = ok; }
          }
        }
        if (bestFov && bestFother) {
          parentOf[fk] = bestFother; hingeOf[fk] = bestFov; vis[fk] = true;
        }
      }
    }
  }

  // ---- Static hinge detection ----
  // Panels split by interior CUTS (slots, windows, tab edges) have NO crease
  // along their shared edge. A crease defines where a panel folds; a cut within
  // a panel is just a feature. Without this check, a U-shaped slot in the front
  // wall splits one panel into two, the hinge tree treats the second piece as a
  // foldable child, and the front wall breaks in 3D.
  // Static hinges: foldMult = 0 (stay in parent's plane, no rotation).
  // vDepth does NOT increment across a static link, so downstream panels
  // (e.g. the glue flap behind a slot-split front wall) get the correct vDepth
  // and foldMult as if the split never happened.
  var staticHinge = {};
  if (creases) {
    Object.keys(parentOf).forEach(function(key) {
      if (key === root) return;
      var ov = hingeOf[key];
      if (!ov) return;
      // Only apply to LARGE panels — small flaps (tuck tabs, dust flaps) may
      // have arc creases that creaseCoverFrac doesn't detect (arc extraction
      // approximates as chord). Restrict to panels where both faces are > 2000 mm²
      // so only genuine slot-splits (like T004A's front wall) are affected.
      var curR = fr(key), parR = fr(parentOf[key]);
      if (!curR || !parR) return;
      if (curR.w * curR.h < 2000 || parR.w * parR.h < 2000) return;
      var cov = creaseCoverFrac(ov, creases);
      if (cov < 0.01) {
        staticHinge[key] = true;
        console.log('[3D-DEBUG] Static hinge (no crease):', key, 'parent:', parentOf[key],
          'cov:', cov.toFixed(3), 'area:', (curR.w * curR.h).toFixed(0));
      }
    });
  }

  // Build scene-graph groups in BFS order. net->world flips Y so the flat net reads upright.
  var faceGroup = {};
  Preview3D._hinges = [];
  var rc = fr(root);
  faceGroup[root] = new THREE.Group();
  faceGroup[root].position.set(rc.cx - bcx, -(rc.cy - bcy), 0);
  boxGroup.add(faceGroup[root]);

  var order = [root];
  (function bfsOrder() {
    var q = [root];
    while (q.length) {
      var c = q.shift();
      Object.keys(parentOf).forEach(function(k) { if (parentOf[k] === c) { order.push(k); q.push(k); } });
    }
  })();

  // ---- Assembly stage (工序) per hinge — drives the fold ORDER ----
  // BFS depth is the WRONG proxy for fold order. On a tube box (A038 …) the four
  // walls are chained sideways (M3|M0|M1|M5), so the top panel sits at depth 1 but
  // the 4th wall at depth 2 -> the lid would close before the tube even existed.
  // The real工序 follows the CREASE DIRECTION instead:
  //   - vertical creases reachable from the root through vertical creases only
  //     => the walls / glue flap: they wrap into a tube FIRST, all together.
  //   - a horizontal crease is a lid / end flap / tuck: stage = how many horizontal
  //     creases lead to it, so a panel always closes before the tuck it carries.
  // Both ends of the carton close in the same stage (like a folding machine). Telling
  // "bottom" from "top" by net position was tried and rejected: on tray-style boxes
  // the walls hang off all four sides of the root, so it split the WALLS across two
  // stages and let small flaps close before the walls were even up.
  var vChain = {}; vChain[root] = true;
  var vDepth = {}; vDepth[root] = 0;
  var rawStage = {};
  order.forEach(function(key) {
    if (key === root) return;
    var pk = parentOf[key], ov = hingeOf[key];
    vChain[key] = !!vChain[pk] && ov.orient === 'v';
    // Static hinges (no crease) don't increment vDepth — the child is physically
    // the same panel as the parent, so downstream panels see the correct depth.
    vDepth[key] = vChain[key] ? (vDepth[pk] + (staticHinge[key] ? 0 : 1)) : 0;
    if (vChain[key]) { rawStage[key] = 0; return; }   // wrap stage
    var hCount = 0, c = key;
    while (c !== root) { if (hingeOf[c].orient === 'h') hCount++; c = parentOf[c]; }
    rawStage[key] = Math.max(1, hCount);
  });
  // A child may never fold before its parent (physically impossible, looks broken).
  order.forEach(function(key) {
    var pk = parentOf[key];
    if (!pk || pk === root) return;
    if (rawStage[key] < rawStage[pk]) rawStage[key] = rawStage[pk];
  });
  // Compress the stage values actually present into consecutive slots 0..N-1,
  // so every box type gets exactly as many animation stages as it really needs.
  var usedStages = [];
  Object.keys(rawStage).forEach(function(k) {
    if (usedStages.indexOf(rawStage[k]) < 0) usedStages.push(rawStage[k]);
  });
  usedStages.sort(function(a, b) { return a - b; });
  var stageIdx = {};
  usedStages.forEach(function(v, i) { stageIdx[v] = i; });
  Preview3D._stageCount = Math.max(1, usedStages.length);

  order.forEach(function(key) {
    if (key === root) return;
    var pk = parentOf[key];
    var cur = fr(key), pr = fr(pk), ov = hingeOf[key];
    // hinge + child offsets expressed in the PARENT's local frame (Y flipped for world)
    var hLocal = new THREE.Vector3(ov.cx - pr.cx, -(ov.cy - pr.cy), 0);
    var cLocal = new THREE.Vector3(cur.cx - ov.cx, -(cur.cy - ov.cy), 0);
    var axis = new THREE.Vector3(ov.dir.x, -ov.dir.y, 0);
    if (axis.lengthSq() < 1e-9) axis.set(1, 0, 0);
    axis.normalize();
    var hingeG = new THREE.Group();
    hingeG.position.copy(hLocal);
    faceGroup[pk].add(hingeG);
    var fg = new THREE.Group();
    fg.position.copy(cLocal);
    hingeG.add(fg);
    faceGroup[key] = fg;
    // Fold direction — Packmage rule: ALL panels default to 90° INWARD (向里折).
    // From packmage.cn docs: "经过一键3D定义后，程序会默认每一个面都向里折叠了90度"
    // Positive angle = inward (toward box interior / -Z side of root).
    // We compute which sign makes the child's center rotate toward -Z:
    //   After 90° rotation: new_z = sign * (axis.x*cLocal.y - axis.y*cLocal.x)
    //   For inward fold: new_z should be negative → flip the geometric sign.
    var crossZ = axis.x * cLocal.y - axis.y * cLocal.x;
    var sign = (crossZ >= 0) ? -1 : 1;   // inward: rotate toward -Z
    // In a vertical chain (walls wrapping around the box), the first two panels
    // fold 90° to form the side wall and front wall. Panels at vDepth >= 3 are
    // inner liners / glue tabs that fold 180° BACK (behind their parent) to
    // create a double-wall construction. Without this, consecutive 90° folds
    // spiral into a tube and the front wall splits into perpendicular fragments.
    var foldMult = 1;
    if (staticHinge[key]) foldMult = 0;   // no crease → no fold, stay in parent's plane
    else if (ov.orient === 'v' && vDepth[key] >= 3 && (vDepth[key] % 2 === 1)) foldMult = 2;
    Preview3D._hinges.push({
      group: hingeG, axis: axis, sign: sign,
      foldMult: foldMult,
      stage: stageIdx[rawStage[key]] || 0,
      key: key, parent: pk, orient: ov.orient   // diagnostics
    });
    hingeG.setRotationFromAxisAngle(axis, 0);
  });

  // One mesh per face, parented to its hinge chain. Orphaned faces (not reached
  // by the fold tree) are still rendered at their net position so the user sees
  // every panel — they just won't fold animatedly.
  // Panels are rendered as semi-transparent so the user can see the box structure
  // (otherwise a fully-closed box hides every interior flap).
  Preview3D._faces = [];
  Object.keys(faceData).forEach(function(key) {
    var F = fr(key); if (!F) return;
    var isRoot = (key === root);
    var mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: isRoot ? 0.30 : 0.72,
      depthWrite: true
    });

    // ---- True polygon geometry (Packmage-style) ----
    // Use the actual panel polygon extracted from the FE line network. This renders
    // trapezoidal / non-rectangular panels (dust flaps, tuck flaps) correctly and
    // removes the fragment artifacts caused by the old ray-cast clipping.
    var geo = null, outlinePts = null;
    var polyPts = planarPolys[key];
    if (polyPts && polyPts.length >= 3) {
      var shape = new THREE.Shape();
      shape.moveTo(polyPts[0][0] - F.cx, -(polyPts[0][1] - F.cy));
      for (var pi = 1; pi < polyPts.length; pi++) {
        shape.lineTo(polyPts[pi][0] - F.cx, -(polyPts[pi][1] - F.cy));
      }
      shape.closePath();
      geo = new THREE.ShapeGeometry(shape);
      // Override UVs to map to the FACE RECTANGLE (not the shape's bbox) so
      // textures (die-cut SVG crop, user artwork) align consistently.
      var posAttr = geo.attributes.position;
      var uvAttr = geo.attributes.uv;
      for (var ui = 0; ui < posAttr.count; ui++) {
        var ux = posAttr.getX(ui), uy = posAttr.getY(ui);
        uvAttr.setXY(ui, (ux + F.w / 2) / F.w, (uy + F.h / 2) / F.h);
      }
      uvAttr.needsUpdate = true;
      outlinePts = polyPts;
    }
    if (!geo) geo = new THREE.PlaneGeometry(F.w, F.h);

    var mesh = new THREE.Mesh(geo, mat);
    if (faceGroup[key]) {
      faceGroup[key].add(mesh);
    } else {
      // Orphaned face: place at net position (no fold transform).
      // Skip tiny slivers (< 800 mm²) — they are usually reconstruction
      // artifacts and float distractingly when the rest of the box folds.
      if (F.w * F.h < 800) { /* skip orphan sliver */ }
      else {
        var orphanG = new THREE.Group();
        orphanG.position.set(F.cx - bcx, -(F.cy - bcy), 0);
        boxGroup.add(orphanG);
        orphanG.add(mesh);
        faceGroup[key] = orphanG;
      }
    }
    // Add an outline so each panel's edges are clearly visible
    var lineMat = new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.9 });
    if (outlinePts) {
      // Use the polygon points directly for a clean outline that follows the die-cut shape
      var lineVerts = [];
      for (var li = 0; li < outlinePts.length; li++) {
        lineVerts.push(new THREE.Vector3(outlinePts[li][0] - F.cx, -(outlinePts[li][1] - F.cy), 0));
      }
      var lineGeo2 = new THREE.BufferGeometry().setFromPoints(lineVerts);
      mesh.add(new THREE.LineLoop(lineGeo2, lineMat));
    } else {
      var edges = new THREE.EdgesGeometry(geo);
      mesh.add(new THREE.LineSegments(edges, lineMat));
    }
    assignTexture(mat, key, F, svgInfo);
    Preview3D._faces.push({ key: key });
  });
  console.log('[3D-DEBUG] Total meshes created:', Preview3D._faces.length,
    'faces:', Preview3D._faces.map(function(f){return f.key;}).join(','));

  // Apply current fold state (foldProgress = 0 -> flat net / 展开图)
  Preview3D._applyFold();

  // ---- View controls ----
  // Strong 3/4 isometric view (front + down + right) so the user can see BOTH
  // the front panel (F4) AND the side walls folded inward. A flat front-on view
  // hides every panel folded to -Z behind F4.
  // For tall narrow boxes (D >> L/W) tilt further down so the top opening is visible.
  var rotY = -0.55;
  var aspect = D / Math.max(L, W, 1);
  var rotX = aspect > 1.5 ? -0.85 : -0.55;
  var netW = maxX - minX, netH = maxY - minY;
  var camDist = Math.max(netW, netH, L, W, D) * 1.65;
  var zoom = 1.0;
  function updateView() {
    viewGroup.rotation.x = rotX;
    viewGroup.rotation.y = rotY;
    camera.position.set(0, 0, camDist / zoom);
    camera.lookAt(0, 0, 0);
  }
  updateView();

  // Expose view controls for the floating toolbar (reset view + zoom buttons)
  Preview3D._viewReset = function() {
    rotX = -0.55; rotY = -0.55; zoom = 1.0; updateView();
    var ryS = document.getElementById('rotateY'), rxS = document.getElementById('rotateX');
    if (ryS) ryS.value = (rotY * 180 / Math.PI).toFixed(0);
    if (rxS) rxS.value = (rotX * 180 / Math.PI).toFixed(0);
  };
  Preview3D._viewZoom = function(f) {
    zoom = Math.max(0.3, Math.min(5.0, zoom * f)); updateView();
  };

  var canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  var isDragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('mousedown', function(e) {
    isDragging = true; lastX = e.clientX; lastY = e.clientY; canvas.style.cursor = 'grabbing'; e.preventDefault();
  });
  var mm = function(e) {
    if (!isDragging) return;
    rotY += (e.clientX - lastX) * 0.008;
    rotX += (e.clientY - lastY) * 0.008;
    rotX = Math.max(-1.4, Math.min(1.4, rotX));
    lastX = e.clientX; lastY = e.clientY;
    var ryS = document.getElementById('rotateY'), rxS = document.getElementById('rotateX');
    if (ryS) ryS.value = (rotY * 180 / Math.PI).toFixed(0);
    if (rxS) rxS.value = (rotX * 180 / Math.PI).toFixed(0);
    updateView();
  };
  var mu = function() { isDragging = false; canvas.style.cursor = 'grab'; };
  window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu);
  container._mouseMoveHandler = mm; container._mouseUpHandler = mu;

  canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    zoom *= e.deltaY > 0 ? 0.89 : 1.12;   // 上滚放大、下滚缩小（标准 3D 视角）
    zoom = Math.max(0.3, Math.min(5.0, zoom));
    updateView();
  }, { passive: false });

  // Touch
  var tSX = 0, tSY = 0, tDist = 0;
  canvas.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) { tSX = e.touches[0].clientX; tSY = e.touches[0].clientY; isDragging = true; }
    else if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
      tDist = Math.sqrt(dx * dx + dy * dy);
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1 && isDragging) {
      rotY += (e.touches[0].clientX - tSX) * 0.008;
      rotX += (e.touches[0].clientY - tSY) * 0.008;
      rotX = Math.max(-1.4, Math.min(1.4, rotX));
      tSX = e.touches[0].clientX; tSY = e.touches[0].clientY; updateView();
    } else if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
      var nd = Math.sqrt(dx * dx + dy * dy);
      if (tDist > 0) { zoom *= nd / tDist; zoom = Math.max(0.3, Math.min(5.0, zoom)); updateView(); }
      tDist = nd;
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', function() { isDragging = false; tDist = 0; });

  var ryS = document.getElementById('rotateY'), rxS = document.getElementById('rotateX');
  if (ryS) { ryS.value = (rotY * 180 / Math.PI).toFixed(0); ryS.oninput = function() { rotY = parseFloat(this.value) * Math.PI / 180; updateView(); }; }
  if (rxS) { rxS.value = (rotX * 180 / Math.PI).toFixed(0); rxS.oninput = function() { rotX = parseFloat(this.value) * Math.PI / 180; updateView(); }; }

  // ---- Render loop ----
  function animate() {
    container._animId = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  // ---- Overlays ----
  var info = document.createElement('div');
  info.style.cssText = 'position:absolute;bottom:10px;left:10px;font-size:12px;color:#555;background:rgba(255,255,255,0.92);padding:6px 12px;border-radius:6px;border:1px solid #e0e0e0;pointer-events:none;z-index:10;';
  info.innerHTML = '<b>' + boxType.id + '</b> &middot; L=' + Math.round(L) + ' &times; W=' + Math.round(W) + ' &times; D=' + Math.round(D) +
    ' mm &middot; <span style="color:#888">拖拽旋转 &middot 滚轮缩放</span>';
  container.appendChild(info);

  var zoomInfo = document.createElement('div');
  zoomInfo.style.cssText = 'position:absolute;top:10px;right:10px;font-size:12px;color:#555;background:rgba(255,255,255,0.92);padding:4px 10px;border-radius:6px;border:1px solid #e0e0e0;pointer-events:none;z-index:10;';
  zoomInfo.textContent = 'Zoom: ' + Math.round(zoom * 100) + '%';
  var origUV = updateView;
  updateView = function() { origUV(); zoomInfo.textContent = 'Zoom: ' + Math.round(zoom * 100) + '%'; };
  updateView();
  container.appendChild(zoomInfo);

  var resizeH = function() {
    var nw = container.clientWidth || 800;
    var nh = container.clientHeight || 560;
    if (nh < 120) nh = 560;
    if (Math.abs(nw - containerW) > 10 || Math.abs(nh - containerH) > 10) {
      containerW = nw; containerH = nh;
      camera.aspect = containerW / containerH; camera.updateProjectionMatrix();
      renderer.setSize(containerW, containerH);
    }
  };
  window.addEventListener('resize', resizeH);
  container._resizeHandler = resizeH;
};

/* ===== Fallback: Simple CSS 3D box (no Three.js) ===== */
Preview3D._renderSimple = function(container, boxType, params) {
  var L = params.L || 100, W = params.W || 60, D = params.D || 80;
  var maxDim = Math.max(L, W, D), scale = 180 / maxDim;
  var sL = L * scale, sW = W * scale, sD = D * scale;
  container.innerHTML = '';
  var scene = document.createElement('div');
  scene.className = 'scene3d';
  scene.style.cssText = 'perspective:800px;width:100%;height:500px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f8f9fa 0%,#e9ecef 100%);border-radius:8px;cursor:grab;';
  var box = document.createElement('div');
  box.className = 'box3d'; box.id = 'box3d';
  box.style.cssText = 'position:relative;transform-style:preserve-3d;width:' + sL + 'px;height:' + sD + 'px;';
  var halfL = sL / 2, halfW = sW / 2, halfD = sD / 2;
  [
    { w: sL, h: sD, t: 'translateZ(' + halfW + 'px)' },
    { w: sL, h: sD, t: 'rotateY(180deg) translateZ(' + halfW + 'px)' },
    { w: sW, h: sD, t: 'rotateY(90deg) translateZ(' + halfL + 'px)' },
    { w: sW, h: sD, t: 'rotateY(-90deg) translateZ(' + halfL + 'px)' },
    { w: sL, h: sW, t: 'rotateX(-90deg) translateZ(' + halfD + 'px)' },
    { w: sL, h: sW, t: 'rotateX(90deg) translateZ(' + halfD + 'px)' }
  ].forEach(function(f) {
    var face = document.createElement('div');
    face.style.cssText = 'width:' + f.w + 'px;height:' + f.h + 'px;position:absolute;left:50%;top:50%;margin-left:' +
      (-f.w / 2) + 'px;margin-top:' + (-f.h / 2) + 'px;transform:' + f.t + ';backface-visibility:visible;background:rgba(255,248,240,0.85);border:0.5px solid #bbb;';
    box.appendChild(face);
  });
  var info = document.createElement('div');
  info.style.cssText = 'position:absolute;bottom:10px;left:10px;font-size:12px;color:#555;background:rgba(255,255,255,0.92);padding:6px 12px;border-radius:6px;border:1px solid #e0e0e0;';
  info.innerHTML = '<b>' + boxType.id + '</b> &middot; L=' + L + ' &times; W=' + W + ' &times; D=' + D + ' mm (简单模式)';
  scene.appendChild(box); container.appendChild(scene); container.appendChild(info);
  var rotY = -25, rotX = -15, z = 1;
  function upd() { box.style.transform = 'rotateX(' + rotX + 'deg) rotateY(' + rotY + 'deg) scale(' + z + ')'; }
  upd();
  var ryS = document.getElementById('rotateY'), rxS = document.getElementById('rotateX');
  if (ryS) { ryS.value = rotY; ryS.oninput = function() { rotY = parseInt(this.value); upd(); }; }
  if (rxS) { rxS.value = rotX; rxS.oninput = function() { rotX = parseInt(this.value); upd(); }; }
};

if (typeof window !== 'undefined') window.Preview3D = Preview3D;
