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
// Manual fold editor: { root: 'P3'|null, flips: ['P5', ...] } resolved to panel
// keys by app.js via resolveFaces, so the 2D selection and this tree agree.
Preview3D._overrides = null;

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
  // The carton shrinks a lot as it folds (a 464 mm net becomes a 120 mm box), so
  // a camera framed on the flat net leaves the finished box as a speck. Re-fit
  // every frame of the fold animation.
  if (Preview3D._updateCameraFit) Preview3D._updateCameraFit();
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
    // 0.98 leaves every hinge 1.8 degrees short so a closed carton never quite
    // seals. That sounds harmless but the shortfall compounds along a chain of
    // folds, so make it tunable and default to a true 90 degrees.
    var maxFold = (Preview3D._maxFold != null) ? Preview3D._maxFold : 1.0;
    var mult = (h.foldMult == null) ? 1 : h.foldMult;
    if (mult === 0) {
      // Static hinge: no crease → panel stays in parent's plane (no rotation)
      h.group.setRotationFromAxisAngle(h.axis, 0);
    } else {
      h.group.setRotationFromAxisAngle(h.axis, h.sign * Math.PI / 2 * t * maxFold * mult);
    }
  });
};

/* ===== Panel resolution (shared by the 2D overlay and the 3D build) =====
 *
 * Decide which panel decomposition a box uses, WITHOUT building any 3D.
 *
 * Shared on purpose. The manual fold editor lets the user click a panel by its
 * 2D outline and then folds that very panel in 3D, so both views must agree on
 * what a panel is. Computed independently they did not: roughly one box in
 * eight is better served by the rectangle decomposition (fewer islands - see
 * the raster/rect shootout below), and those would have been clicked as one
 * shape and folded as another. Invisible in the UI, wrong on screen.
 *
 * Returns { faceData, polys, isRaster, isReconstructed }:
 *   faceData  key -> bbox [x1,y1,x2,y2]
 *   polys     key -> outline [[x,y], ...]. EMPTY when the rectangle fallback
 *             won, in which case callers should draw the bbox rectangle.
 *   isRaster  true when the raster/contour decomposition was used
 */
Preview3D.resolveFaces = function(boxType) {
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
  Preview3D._rasterPolys = null;
  if (!faceData) {
    var _fe = (boxType.currentBoxData && boxType.currentBoxData.fe) ||
              (boxType.packmageData && boxType.packmageData.fe);
    var _ox = boxType.currentBoxData && boxType.currentBoxData.de ? boxType.currentBoxData.de.ox : 0;
    var _oy = boxType.currentBoxData && boxType.currentBoxData.de ? boxType.currentBoxData.de.oy : 0;
    if (!_ox && boxType.packmageData && boxType.packmageData.de) { _ox = boxType.packmageData.de.ox; _oy = boxType.packmageData.de.oy; }
    // Keep the reliable rectangle decomposition for the hinge tree (it knows
    // how panels connect), but map real raster/contour polygons onto those
    // rectangles for rendering. This gives correct shapes for trapezoids /
    // tuck flaps without breaking the fold hierarchy.
    var rectFaceData = reconstructFacesFromFE(_fe, _ox, _oy);
    // The raster extraction is the single source of truth for panels: its polygons
    // follow the real die-cut outline (tapers, tuck flaps, locks), and its bounding
    // boxes drive the hinge tree. Previously the tree came from a rectangle
    // decomposition and polygons were matched onto it by centroid distance — that
    // mapping silently mis-assigned merged panels and left big faces (T004A's main
    // body) with no polygon at all, falling back to a plain rectangle.
    var rasterFaceData = null;
    if (_fe && _fe.length && !Preview3D._forceRect) {
      try {
        var _panels = extractPanelsRaster(_fe, _ox, _oy);
        if (_panels && _panels.length >= 4) {
          rasterFaceData = {};
          var _polys = {};
          for (var _pi = 0; _pi < _panels.length; _pi++) {
            var bb = _panels[_pi].bbox;
            var _k = 'P' + _pi;                       // P0 = largest panel (root)
            rasterFaceData[_k] = [bb[0], bb[1], bb[2], bb[3]];
            _polys[_k] = _panels[_pi].poly;
          }
          Preview3D._rasterPolys = _polys;
          Preview3D._rasterCount = _panels.length;

          // Neither panel source wins everywhere: the raster owns the true
          // die-cut outlines but its graph breaks on dielines whose outline is
          // drawn in pieces (JP012 splits into 3 islands → 29% foldable), while
          // the rectangle decomposition always connects but flattens tapers
          // (JP012 → 100%). Simulate the fold tree before committing and keep the
          // rectangle decomposition whenever the raster cannot fold as one piece.
          var _keys = Object.keys(rasterFaceData);
          var _cr = _extractCreasePolys(_fe, Math.abs(_ox || 0), Math.abs(_oy || 0));
          var _pairs = _rasterAdjPairs(Preview3D._rasterAdj, _cr);
          if (_cr.length) {
            var _seenP = {};
            _pairs.forEach(function (p) { _seenP[(p.a < p.b ? p.a + '|' + p.b : p.b + '|' + p.a)] = 1; });
            creaseAdjacency(_keys, _polys, _cr).forEach(function (p) {
              var k = (p.a < p.b ? p.a + '|' + p.b : p.b + '|' + p.a);
              if (!_seenP[k]) { _seenP[k] = 1; _pairs.push(p); }
            });
          }
          // The real fold tree also runs two bbox-edge rescue passes, so mirror
          // them here — scoring on creases alone rejected panel sets that folded
          // perfectly well (E039A fell back despite reaching 89%).
          var _bp = _bboxPairs(_keys, rasterFaceData);
          // Root must match the real tree, which picks the largest BOUNDING BOX
          // (not the largest polygon) — they differ for tapered panels.
          var _root = _largestRectKey(_keys, rasterFaceData) || _keys[0];
          var _res = _cr.length ? _treeCoverage(_keys, _pairs.concat(_bp), _root)
                                : { covered: 1, islands: _keys.length };
          Preview3D._rasterCoverage = _res.covered + '/' + _keys.length + '/' + _res.islands;

          // Score the rectangle decomposition the same cheap way and keep whichever
          // folds as fewer separate pieces. Each island is a sub-assembly that
          // animates on its own, so a box that splits into 9 islands looks like it
          // fell apart — a case where the crude rectangle topology (one island,
          // slightly wrong flap outlines) is the better preview.
          var _rk = Object.keys(rectFaceData || {});
          var _rectRes = null;
          if (_rk.length >= 4) {
            var _rroot = _largestRectKey(_rk, rectFaceData);
            if (_rroot) _rectRes = _treeCoverage(_rk, _bboxPairs(_rk, rectFaceData), _rroot);
          }
          Preview3D._rectCoverage = _rectRes
            ? (_rectRes.covered + '/' + _rk.length + '/' + _rectRes.islands) : 'n/a';

          var _rasterBetter = true;
          if (_rectRes) {
            // Prefer fewer islands; break ties on fewer panels (less over-splitting).
            if (_rectRes.islands < _res.islands) _rasterBetter = false;
            else if (_rectRes.islands === _res.islands && _rk.length < _keys.length * 0.6) _rasterBetter = false;
          }
          if (!_rasterBetter) {
            rasterFaceData = null;
            Preview3D._rasterPolys = null;
            Preview3D._rasterFallbackReason = 'islands ' + _res.islands + ' vs rect ' + _rectRes.islands;
          }
        }
      } catch (e) { rasterFaceData = null; }
    }
    if (!rasterFaceData) {
      // Raster failed (or produced nothing usable) — fall back to the rectangle
      // decomposition so the preview still renders something sane.
      rasterFaceData = rectFaceData;
      Preview3D._rasterPolys = null;
      Preview3D._rasterCount = 0;
    }
    faceData = rasterFaceData;
    _isReconstructed = true;
    Preview3D._isRasterFaces = !!Preview3D._rasterPolys;
  }
  Preview3D._lastFaceData = faceData;

  return { faceData: faceData, polys: Preview3D._rasterPolys || {},
           isRaster: !!Preview3D._rasterPolys, isReconstructed: _isReconstructed };
};

/* ===== Visual merge groups (2D only, "只显示不合并") =====
 * Some raster nets split one continuous board into several panels where a
 * crease (fold line) passes through it — e.g. A042's left wall is divided by
 * horizontal creases into P6/P7/P1/P5 (top flap, upper piece, body, bottom tab).
 * The fold tree NEEDS those separate panels, so the panel DATA stays untouched,
 * but in the 2D dieline they read as "cut into pieces". This returns groups of
 * panel keys that are stacked in the same column and joined by a HORIZONTAL
 * crease (fold line) — visually one board. The 2D renderer fills each group as
 * a single board and hides the internal crease fill-boundaries.
 *
 * Returns { groups: [[key,...], ...], bridges: [{a,b,cx,cy,ux,uy,len}] }
 *   groups   - each is a list of panel keys that form one visual board
 *   bridges  - the crease pairs (for the renderer to stitch the small gaps)
 */
Preview3D.computeVisualGroups = function(boxType) {
  var out = { groups: [], bridges: [] };
  var fe = (boxType && boxType.currentBoxData && boxType.currentBoxData.fe) ||
           (boxType && boxType.packmageData && boxType.packmageData.fe);
  var de = (boxType && boxType.currentBoxData && boxType.currentBoxData.de) ||
           (boxType && boxType.packmageData && boxType.packmageData.de);
  if (!fe || !fe.length) return out;
  var ox = (de && de.ox) || 0, oy = (de && de.oy) || 0;

  // 1) Rasterise the net and get the crease-aware adjacency (same source the
  //    fold tree uses). This fills Preview3D._rasterAdj with direct-contact and
  //    bridge pairs plus their shared-edge geometry.
  var panels = extractPanelsRaster(fe, ox, oy);
  if (!panels || panels.length < 2) return out;
  var adj = Preview3D._rasterAdj || [];
  var creases = _extractCreasePolys(fe, Math.abs(ox), Math.abs(oy));
  var pairs = adj.length ? _rasterAdjPairs(adj, creases) : [];

  // 2) Keep only HORIZONTAL crease joins (fold line, cov>0.05) between panels
  //    that sit in the same column (overlapping x-range) — a vertical stack.
  //    Vertical creases join *different* columns (adjacent walls) and are NOT
  //    merged here.
  var keys = panels.map(function(p, i) { return 'P' + i; });
  var bbox = {};
  panels.forEach(function(p, i) { bbox['P' + i] = p.bbox; });
  var edges = [];
  pairs.forEach(function(p) {
    if (p.cov < 0.05) return;             // shared edge is not a fold line
    if (p.ov.orient !== 'h') return;      // only horizontal (same-column) joins
    var bx = bbox[p.a], by = bbox[p.b];
    if (!bx || !by) return;
    // Same column: x-ranges must overlap by a good fraction of the shorter one.
    var ovX = Math.min(bx[2], by[2]) - Math.max(bx[0], by[0]);
    var minW = Math.min(bx[2] - bx[0], by[2] - by[0]);
    if (minW <= 0 || ovX < minW * 0.6) return;
    edges.push({ a: p.a, b: p.b, len: p.len,
                 cx: p.ov.cx, cy: p.ov.cy, ux: p.ov.dir.x, uy: p.ov.dir.y });
  });
  if (!edges.length) return out;

  // 3) Union-find into visual boards.
  var parent = {};
  keys.forEach(function(k) { parent[k] = k; });
  function find(k) { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; }
  function uni(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  edges.forEach(function(e) { uni(e.a, e.b); });
  var groups = {};
  keys.forEach(function(k) {
    var r = find(k);
    if (!groups[r]) groups[r] = [];
    groups[r].push(k);
  });
  Object.keys(groups).forEach(function(r) {
    if (groups[r].length >= 2) out.groups.push(groups[r]);
  });

  // A042's left wall is split into five thin strips by horizontal creases that
  // are really just fold lines on one continuous board. But NOT every vertical
  // stack is such a case: a normal carton's wall stack is "lid + body + base"
  // (3 boards that should stay separate). To merge only genuine "one board
  // carved into many thin strips", require BOTH:
  //   1) >= 4 boards in the column (a real lid/body/base stack is almost always 3),
  //   2) all boards share essentially the same width (delta < 15%) — a lid/body/
  //      base with flaps of different widths must not be fused.
  // Then keep only the LEFTMOST such board so other columns stay untouched.
  var WMIN = 0.15;
  var keep = out.groups.filter(function(gr) {
    if (gr.length < 4) return false;
    var wmin = Infinity, wmax = -Infinity, wsum = 0, cnt = 0;
    gr.forEach(function(k) {
      var bk = bbox[k]; if (!bk) return;
      var w = bk[2] - bk[0];
      if (w < wmin) wmin = w; if (w > wmax) wmax = w; wsum += w; cnt++;
    });
    if (cnt < 4 || wmax <= 0) return false;
    return (wmax - wmin) / wmax < WMIN;
  });
  if (keep.length > 1) {
    var x0 = Infinity, pick = -1;
    keep.forEach(function(gr, gi) {
      var gx0 = Infinity;
      gr.forEach(function(k) {
        var bk = bbox[k]; if (bk && bk[0] < gx0) gx0 = bk[0];
      });
      if (gx0 < x0) { x0 = gx0; pick = gi; }
    });
    if (pick >= 0) keep = [keep[pick]];
  }
  out.groups = keep;
  out.bridges = edges;
  return out;
};

/* ===== Entry point ===== */
Preview3D.render = function(container, boxType, params) {
  Preview3D._cleanup(container);
  Preview3D.foldProgress = 0;   // every new box starts from the flat net

  // Panel source is resolved by Preview3D.resolveFaces so the 2D overlay and
  // the 3D build always agree on what a panel is - see resolveFaces above.
  var _resolved = Preview3D.resolveFaces(boxType);
  var faceData = _resolved.faceData;
  var _isReconstructed = _resolved.isReconstructed;

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
    Preview3D._artFaces = Preview3D._artFaces || {};
    Preview3D._artFaces[key] = true;
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
      // Only surface the artwork in 彩样 mode; 白样/骨架线 keep the plain board
      // so the display-mode switcher owns the final map state.
      if (Preview3D._displayMode === 'color') {
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
      }
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
      if (Preview3D._displayMode === 'color') {
        mat.map = tex2;
        mat.needsUpdate = true;
      }
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
  // Raster panels are simplified with eps = res*2, so on a large net (res ~ 4mm)
  // their edges can sit ~8mm off the true boundary. Scale with the resolution so
  // coarse nets still find their neighbours instead of matching nothing at all.
  var TOL = Math.max(3, (Preview3D._rasterRes || 0) * 2.5);
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

function pointInPoly(px, py, poly) {
  var inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Walk outward from a point on a crease until some panel owns it. The raster
// burns a wall along every line, so the first millimetre beside a crease belongs
// to no panel, and tapered/lock shapes can leave several mm of real gap.
function _probeSide(px, py, nx, ny, faceKeys, polyOf, maxProbe) {
  for (var d = 0.5; d <= maxProbe; d += 0.5) {
    var qx = px + nx * d, qy = py + ny * d;
    for (var i = 0; i < faceKeys.length; i++) {
      var poly = polyOf[faceKeys[i]];
      if (poly && poly.length >= 3 && pointInPoly(qx, qy, poly)) return faceKeys[i];
    }
  }
  return null;
}

// Cheap simulation of the greedy fold tree: how many panels can be reached from
// `root` through the given candidate pairs? Used to decide whether the raster
// panel set is foldable at all before committing to it — building the real tree
// needs a full Three.js scene, which is far too expensive to do twice.
function _treeCoverage(keys, pairs, root) {
  var vis = {}; var n = 0;
  var used = {};
  var sorted = pairs.slice();
  var roots = [];
  // Mirror the forest growth used by the real fold tree: when no pair can reach
  // an unvisited panel, seed a new island from the largest panel left over.
  for (var outer = 0; outer < keys.length; outer++) {
    if (outer === 0) { vis[root] = true; n++; }
    for (var guard = 0; guard < keys.length + 2; guard++) {
      var pick = null;
      for (var i = 0; i < sorted.length; i++) {
        var p = sorted[i], kk = p.a + ',' + p.b;
        if (used[kk]) continue;
        if (vis[p.a] && !vis[p.b]) { pick = p.b; used[kk] = 1; break; }
        if (vis[p.b] && !vis[p.a]) { pick = p.a; used[kk] = 1; break; }
      }
      if (pick == null) break;
      vis[pick] = true; n++;
    }
    var nextRoot = null;
    for (var k = 0; k < keys.length; k++) if (!vis[keys[k]]) { nextRoot = keys[k]; break; }
    if (nextRoot == null) break;
    vis[nextRoot] = true; n++;
    roots.push(nextRoot);
  }
  // `roots` only holds the EXTRA islands seeded after the first one, so the
  // initial root has to be added back — reporting 0 for a fully connected net
  // made the rectangle decomposition look strictly better and stole boxes that
  // folded perfectly well on the raster panel set.
  return { covered: n, islands: (n > 0 ? 1 : 0) + roots.length };
}

// Bounding-box neighbours for a rectangle face set — mirrors the pair source the
// real fold tree falls back to when no crease data is available.
function _bboxPairs(keys, rectOf) {
  var out = [];
  for (var a = 0; a < keys.length; a++) {
    for (var b = a + 1; b < keys.length; b++) {
      var ra = rectOf[keys[a]], rb = rectOf[keys[b]];
      if (!ra || !rb) continue;
      var ea = rectEdges({ x1: ra[0], y1: ra[1], x2: ra[2], y2: ra[3] });
      var eb = rectEdges({ x1: rb[0], y1: rb[1], x2: rb[2], y2: rb[3] });
      var bo = null, bl = -1;
      for (var m = 0; m < 4; m++) for (var n2 = 0; n2 < 4; n2++) {
        var o = edgesOverlap(ea[m], eb[n2]);
        if (o && o.len > bl) { bl = o.len; bo = o; }
      }
      if (bo && bl >= 1) out.push({ a: keys[a], b: keys[b], ov: bo, len: bl, score: bl });
    }
  }
  return out;
}

// Sort keys by bounding-box area, largest first — the real tree roots on the
// largest box, and the simulation has to root identically to predict it.
function _largestRectKey(keys, rectOf) {
  var best = null, bestA = -1;
  for (var i = 0; i < keys.length; i++) {
    var r = rectOf[keys[i]];
    if (!r) continue;
    var a = Math.abs(r[2] - r[0]) * Math.abs(r[3] - r[1]);
    if (a > bestA) { bestA = a; best = keys[i]; }
  }
  return best;
}

// Crease geometry straight out of the die-line (needed before the scene exists so
// the panel-set choice can be validated without building it first).
function _extractCreasePolys(fe, absOx, absOy) {
  var out = [];
  if (!fe || !fe.length) return out;
  for (var i = 0; i < fe.length; i++) {
    var f = fe[i];
    if (f[1] === 0) continue;             // style 0 = cut, not a fold
    var pts = [];
    if (f[0] === 0) {
      pts = [{ x: f[2] + absOx, y: f[3] + absOy }, { x: f[4] + absOx, y: f[5] + absOy }];
    } else if (f[0] === 1) {
      var cx = f[2] + absOx, cy = f[3] + absOy, r = f[4], sa = f[5], ea = f[6];
      var ad = ea - sa; while (ad < 0) ad += 360; while (ad >= 360) ad -= 360;
      if (ad === 0 && sa !== ea) ad = 360;
      var steps = Math.max(16, Math.ceil(Math.abs(ad) / 3));
      for (var s = 0; s <= steps; s++) {
        var t = s / steps, ang = (sa + ad * t) * Math.PI / 180;
        pts.push({ x: cx + r * Math.cos(ang), y: cy - r * Math.sin(ang) });
      }
    } else if (f[0] === 2) {
      for (var j = 2; j + 1 < f.length; j += 2) pts.push({ x: f[j] + absOx, y: f[j + 1] + absOy });
    }
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

// Turn the raster's pixel-level adjacency into fold-tree candidates. Completeness
// comes from the raster (every shared boundary is found), while the CREASE is used
// only to rank: a boundary with a crease along it is a real fold and is picked
// first, a pure cut contact still connects the panels but is taken last.
// Uniform grid over crease segments so "is a crease near this point?" stays O(1)
// instead of scanning every segment for every contact sample.
function _creaseGrid(creases, cell) {
  var grid = {}, segs = [];
  for (var li = 0; li < creases.length; li++) {
    var pl = creases[li];
    for (var s = 0; s + 1 < pl.length; s++) {
      var x1 = pl[s].x, y1 = pl[s].y, x2 = pl[s + 1].x, y2 = pl[s + 1].y;
      var si = segs.length;
      segs.push([x1, y1, x2, y2]);
      var c0x = Math.floor(Math.min(x1, x2) / cell), c1x = Math.floor(Math.max(x1, x2) / cell);
      var c0y = Math.floor(Math.min(y1, y2) / cell), c1y = Math.floor(Math.max(y1, y2) / cell);
      for (var gx = c0x - 1; gx <= c1x + 1; gx++) {
        for (var gy = c0y - 1; gy <= c1y + 1; gy++) {
          var k = gx + ',' + gy;
          (grid[k] || (grid[k] = [])).push(si);
        }
      }
    }
  }
  return {
    segs: segs, cell: cell,
    near: function (px, py, tol) {
      var gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      var list = grid[gx + ',' + gy];
      if (!list) return false;
      for (var i = 0; i < list.length; i++) {
        if (_ptSegDist(px, py, segs[list[i]]) <= tol) return true;
      }
      return false;
    }
  };
}

// Folded size of a whole hierarchy, computed by chaining hinge matrices instead
// of building meshes. Cheap enough to run once per candidate root, which is what
// makes choosing the base panel by result (rather than by guesswork) affordable.
function _foldedSizeAnalytic(faceData, parentOf, hingeOf, rootKey) {
  var M = {}, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  M[rootKey] = new THREE.Matrix4();
  var order = [rootKey], q = [rootKey];
  while (q.length) {
    var c = q.shift();
    Object.keys(parentOf).forEach(function (k) { if (parentOf[k] === c) { order.push(k); q.push(k); } });
  }
  order.forEach(function (k) {
    var r = faceData[k];
    if (!r) return;
    var x1 = Math.min(r[0], r[2]), x2 = Math.max(r[0], r[2]);
    var y1 = Math.min(r[1], r[3]), y2 = Math.max(r[1], r[3]);
    var w = x2 - x1, h = y2 - y1;
    var cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (k !== rootKey) {
      var pk = parentOf[k], ov = hingeOf[k];
      if (!ov) return;
      var pr = faceData[pk];
      if (!pr) return;
      var px1 = Math.min(pr[0], pr[2]), px2 = Math.max(pr[0], pr[2]);
      var py1 = Math.min(pr[1], pr[3]), py2 = Math.max(pr[1], pr[3]);
      var pcx = (px1 + px2) / 2, pcy = (py1 + py2) / 2;
      var hL = new THREE.Matrix4().makeTranslation(ov.cx - pcx, -(ov.cy - pcy), 0);
      var cL = new THREE.Matrix4().makeTranslation(cx - ov.cx, -(cy - ov.cy), 0);
      var axis = new THREE.Vector3(ov.dir.x, -ov.dir.y, 0);
      if (axis.lengthSq() < 1e-9) axis.set(1, 0, 0);
      axis.normalize();
      var v = new THREE.Vector3(cx - ov.cx, -(cy - ov.cy), 0);
      var crossZ = axis.x * v.y - axis.y * v.x;
      var sign = (crossZ >= 0) ? -1 : 1;
      var R = new THREE.Matrix4().makeRotationAxis(axis, sign * Math.PI / 2);
      M[k] = new THREE.Matrix4().copy(M[pk]).multiply(hL).multiply(R).multiply(cL);
    }
    var mm = M[k];
    if (!mm) return;
    [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].forEach(function (c2) {
      var v3 = new THREE.Vector3(c2[0], -c2[1], 0).applyMatrix4(mm);
      var a = [v3.x, v3.y, v3.z];
      for (var t = 0; t < 3; t++) { if (a[t] < lo[t]) lo[t] = a[t]; if (a[t] > hi[t]) hi[t] = a[t]; }
    });
  });
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

// Design dimensions out of de.op ("L=200,W=300,D=50,..."), largest first.
function _designDims(de) {
  if (!de || !de.op) return null;
  var m = {};
  String(de.op).split(",").forEach(function (kv) {
    var p = kv.split("=");
    if (p.length !== 2) return;
    var k = p[0].trim().toUpperCase(), v = parseFloat(p[1]);
    if (!isNaN(v) && v > 0) m[k] = v;
  });
  if (!(m.L && m.W && m.D)) return null;
  return [m.L, m.W, m.D].sort(function (a, b) { return b - a; });
}

function _rasterAdjPairs(adj, creases, tol) {
  var out = [];
  if (!adj || !adj.length) return out;
  var cg = (creases && creases.length) ? _creaseGrid(creases, 12) : null;
  // Tolerance scales with the raster step: the contact samples sit half a pixel
  // off the true boundary, and coarser nets need proportionally more slack.
  var TOL = tol || 2.5;
  for (var i = 0; i < adj.length; i++) {
    var e = adj[i];
    if (!e.len || e.len < 2) continue;
    var half = e.len / 2;
    var ov = { x1: e.cx - e.ux * half, y1: e.cy - e.uy * half,
               x2: e.cx + e.ux * half, y2: e.cy + e.uy * half,
               orient: Math.abs(e.ux) > Math.abs(e.uy) ? 'h' : 'v',
               cx: e.cx, cy: e.cy, dir: { x: e.ux, y: e.uy }, len: e.len };
    // How much of this shared boundary runs along a crease. Measured by walking
    // the boundary's own contact samples and asking whether a crease lies within
    // TOL — robust to curved and staircased edges, unlike the old line fit.
    var cov = 0;
    if (cg && e.pts && e.pts.length) {
      var hit = 0;
      for (var q = 0; q < e.pts.length; q++) {
        if (cg.near(e.pts[q][0], e.pts[q][1], TOL)) hit++;
      }
      cov = hit / e.pts.length;
    } else if (creases && creases.length) {
      cov = creaseCoverFrac(ov, creases);
    }
    out.push({ a: 'P' + e.a, b: 'P' + e.b, ov: ov, len: e.len, cov: cov, bridge: !!e.bridge,
               score: e.len * (cov > 0.05 ? 3 : 1) * (e.bridge ? 0.08 : 1) });
  }
  return out;
}

// A fold hinge exists exactly where a CREASE line separates two panels. Creases
// are ground truth shipped in the die-line, so walking them yields adjacency that
// is immune to raster wall gaps, contour simplification error and coarse
// resolution — the three things that broke the bbox-edge approach.
// Returns [{a, b, ov:{cx,cy,dir,orient,len}, len, score}] sorted longest first.
function creaseAdjacency(faceKeys, polyOf, creases, opts) {
  opts = opts || {};
  var out = [];
  if (!creases || !creases.length || !faceKeys || faceKeys.length < 2) return out;
  var STEP = opts.step || 2.0;       // sampling pitch along a crease (mm)
  var PROBE = opts.probe || 12;      // how far to walk sideways for the owning panel
  var OFF0 = 0.6;                    // start just outside the burned wall
  var MINLEN = opts.minLen || 4;     // ignore accidental 2 mm touches
  var map = {};
  for (var li = 0; li < creases.length; li++) {
    var pl = creases[li];
    if (!pl || pl.length < 2) continue;
    for (var s = 0; s + 1 < pl.length; s++) {
      var p1 = pl[s], p2 = pl[s + 1];
      var dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy);
      if (L < MINLEN) continue;
      var ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      var n = Math.max(1, Math.min(64, Math.round(L / STEP)));
      // Dominant pair across this straight crease piece: tally the samples.
      var tally = {}, bestK = null, bestC = 0;
      for (var q = 0; q < n; q++) {
        var t = (q + 0.5) / n;
        var mx = p1.x + dx * t, my = p1.y + dy * t;
        var A = _probeSide(mx + nx * OFF0, my + ny * OFF0, nx, ny, faceKeys, polyOf, PROBE);
        if (A == null) continue;
        var B = _probeSide(mx - nx * OFF0, my - ny * OFF0, -nx, -ny, faceKeys, polyOf, PROBE);
        if (B == null || B === A) continue;
        var kk = (A < B) ? (A + '|' + B) : (B + '|' + A);
        tally[kk] = (tally[kk] || 0) + 1;
        if (tally[kk] > bestC) { bestC = tally[kk]; bestK = kk; }
      }
      if (!bestK || bestC < 1) continue;
      var parts = bestK.split('|');
      var m = map[bestK];
      if (!m) { m = map[bestK] = { a: parts[0], b: parts[1], len: 0, bestL: -1, cx: 0, cy: 0, ux: 0, uy: 0 }; }
      m.len += L * (bestC / n);
      // The fold axis comes from the LONGEST straight piece, not an average —
      // averaging an arc crease would tilt the axis and skew the whole subtree.
      if (L > m.bestL) { m.bestL = L; m.cx = (p1.x + p2.x) / 2; m.cy = (p1.y + p2.y) / 2; m.ux = ux; m.uy = uy; }
    }
  }
  Object.keys(map).forEach(function (kk) {
    var m = map[kk];
    if (m.len < MINLEN || m.bestL < MINLEN) return;
    var ux = m.ux, uy = m.uy, half = m.len / 2;
    out.push({
      a: m.a, b: m.b, len: m.len, score: m.len,
      ov: { x1: m.cx - ux * half, y1: m.cy - uy * half, x2: m.cx + ux * half, y2: m.cy + uy * half,
            orient: Math.abs(ux) > Math.abs(uy) ? 'h' : 'v',
            cx: m.cx, cy: m.cy, dir: { x: ux, y: uy }, len: m.len }
    });
  });
  out.sort(function (x, y) { return y.len - x.len; });
  return out;
}

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


/* ===== Raster + contour panel extraction (TRUE panel shapes) =====
   reconstructFacesFromFE forces every panel into axis-aligned rectangles, which
   destroys trapezoids / tuck flaps / locking tabs (T004A rendered as wrong slabs).
   This routine rasterises the die-cut instead: every line — cut AND crease — acts
   as a WALL, connected paper regions are labelled, and each region outline is
   traced with Moore-neighbour contour following. Result = the real panel polygon,
   so the 3D mesh matches the 2D dieline.

   Returns [{bbox:[x1,y1,x2,y2], poly:[[x,y],...], area}] sorted by area desc,
   or null when nothing usable is found. */
// A cut that does not close on itself is a knife slit, not an edge: it is there
// to free a neighbouring panel so it can fold, and it must NOT flip the
// inside/outside parity. N001 has two 20 mm slits either side of its end wall;
// counting them carved a phantom 21 mm "waste" band straight through the panel
// and cut the 50 mm end wall into a 29 mm stub plus a detached strip.
// Anything with a loose end is progressively pruned; closed loops (real outlines
// and proper two-sided slots) survive because every vertex there has degree 2.
function _pruneSlitCuts(segs, tol, maxDrop, maxSlitLen, bbox) {
  if (!segs || segs.length < 3) return segs;
  var snap = tol || 1.0;
  var maxSlit = maxSlitLen || Infinity;
  // A slit ends in the MIDDLE of the sheet; a broken outline ends at the edge of
  // the blank. Requiring the loose end to sit well inside the bounding box keeps
  // exported-in-pieces outlines intact while still removing genuine slits.
  var inner = 0;
  if (bbox) {
    inner = Math.max(2, Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.03);
  }
  function isInterior(x, y) {
    if (!bbox) return true;
    return (x - bbox[0] > inner) && (bbox[2] - x > inner) &&
           (y - bbox[1] > inner) && (bbox[3] - y > inner);
  }
  function key(x, y) { return Math.round(x / snap) + ',' + Math.round(y / snap); }
  var live = segs.slice();
  var totalLen = 0;
  segs.forEach(function (s) { totalLen += Math.hypot(s[2] - s[0], s[3] - s[1]); });
  var guard = 0;
  for (;;) {
    if (guard++ > 40) break;
    var deg = {};
    live.forEach(function (s) {
      var k1 = key(s[0], s[1]), k2 = key(s[2], s[3]);
      deg[k1] = (deg[k1] || 0) + 1;
      deg[k2] = (deg[k2] || 0) + 1;
    });
    var next = [];
    live.forEach(function (s) {
      var k1 = key(s[0], s[1]), k2 = key(s[2], s[3]);
      if ((deg[k1] || 0) < 2 || (deg[k2] || 0) < 2) {
        // Length cap AND an interior loose end. Trimming on length alone merged
        // panels that must stay apart (A009 1% -> 80%, B009 15% -> 55%).
        var sl = Math.hypot(s[2] - s[0], s[3] - s[1]);
        if (sl <= maxSlit) {
          var looseInterior = ((deg[k1] || 0) < 2 && isInterior(s[0], s[1])) ||
                              ((deg[k2] || 0) < 2 && isInterior(s[2], s[3]));
          if (looseInterior) return;
        }
      }
      next.push(s);
    });
    if (next.length === live.length) break;
    // Safety: if pruning is eating far more than a slit ever would, the outline
    // itself is open (export gap) and we must not destroy it.
    var kept = 0;
    next.forEach(function (s) { kept += Math.hypot(s[2] - s[0], s[3] - s[1]); });
    if (totalLen > 0 && kept < totalLen * (1 - (maxDrop == null ? 0.5 : maxDrop))) break;
    live = next;
    if (!live.length) break;
  }
  return live.length ? live : segs;
}

function extractPanelsRaster(fe, ox, oy, opts) {
  opts = opts || {};
  if (!fe || !fe.length) return null;
  var absOx = Math.abs(ox || 0), absOy = Math.abs(oy || 0);

  // ---- 1. Flatten fe into straight segments (arcs discretised) ----
  // fe element = [type, style, ...]; style 0 = cut (thru-cut), style != 0 = crease.
  // Only CUT lines bound the sheet of paper. Creases live strictly inside the
  // sheet, so they must be excluded from the inside/outside parity test —
  // otherwise every crease flips the parity and the net turns into a
  // checkerboard, dropping alternating panels (T004A lost its two main body
  // panels exactly this way).
  var segs = [];
  var cutSegs = [];
  for (var i = 0; i < fe.length; i++) {
    var e = fe[i], type = e[0], pts = null;
    var isCut = (e[1] === 0);
    if (type === 0) {
      pts = [[e[2] + absOx, e[3] + absOy], [e[4] + absOx, e[5] + absOy]];
    } else if (type === 1) {
      var cx = e[2] + absOx, cy = e[3] + absOy, r = e[4], sa = e[5], ea = e[6];
      var ad = ea - sa; while (ad < 0) ad += 360; while (ad >= 360) ad -= 360;
      if (ad === 0 && sa !== ea) ad = 360;
      var steps = Math.max(16, Math.ceil(Math.abs(ad) / 3));
      pts = [];
      for (var s = 0; s <= steps; s++) {
        var t = s / steps, ang = (sa + ad * t) * Math.PI / 180;
        pts.push([cx + r * Math.cos(ang), cy - r * Math.sin(ang)]);
      }
    } else if (type === 2) {
      pts = [];
      for (var j = 2; j + 1 < e.length; j += 2) pts.push([e[j] + absOx, e[j + 1] + absOy]);
    }
    if (pts && pts.length >= 2) {
      for (var k = 0; k + 1 < pts.length; k++) {
        var a = pts[k], b = pts[k + 1];
        if (Math.abs(a[0] - b[0]) > 1e-9 || Math.abs(a[1] - b[1]) > 1e-9) {
          segs.push([a[0], a[1], b[0], b[1]]);
          if (isCut) cutSegs.push([a[0], a[1], b[0], b[1]]);
        }
      }
    }
  }
  if (!segs.length) return null;
  // Guard: a handful of box types tag their whole outline as non-cut. If there
  // are (almost) no cut segments the parity test would see an empty sheet, so
  // treat every line as a boundary in that degenerate case.
  if (cutSegs.length < 3) cutSegs = segs;

  // ---- 2. Bounds + adaptive resolution ----
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i];
    if (sg[0] < minX) minX = sg[0]; if (sg[2] < minX) minX = sg[2];
    if (sg[0] > maxX) maxX = sg[0]; if (sg[2] > maxX) maxX = sg[2];
    if (sg[1] < minY) minY = sg[1]; if (sg[3] < minY) minY = sg[3];
    if (sg[1] > maxY) maxY = sg[1]; if (sg[3] > maxY) maxY = sg[3];
  }
  var bw = maxX - minX, bh = maxY - minY;
  if (!(bw > 0) || !(bh > 0)) return null;
  var res = 1.0;
  var MAXPX = opts.maxPixels || 260000;
  while ((bw / res) * (bh / res) > MAXPX) res *= 1.4;
  var W = Math.ceil(bw / res) + 3, H = Math.ceil(bh / res) + 3;
  var OX = minX - 1.5 * res, OY = minY - 1.5 * res;
  // A wall must be wide enough to cover at least one sample point, otherwise a
  // thin crease slips between two samples and the panels it separates merge into
  // one blob (this silently collapsed T004A from 12 panels down to 7).
  var LINE_WIDTH = Math.max(opts.lineWidth || 0.4, res * 0.55);

  // Slits are real geometry (they let a panel fold) but fake boundaries, so they
  // are excluded from the parity test while still being burned as walls below.
  if (Preview3D._pruneSlits !== false) {
    var _diag2 = Math.hypot(bw, bh);
    cutSegs = _pruneSlitCuts(cutSegs, Math.max(1.0, res), 0.5, _diag2 * 0.05,
                             [minX, minY, maxX, maxY]);
  }

  // ---- 3. Per-row segment buckets (fast inside test + line-wall test) ----
  var rowCross = new Array(H), rowNear = new Array(H);
  for (var iy = 0; iy < H; iy++) {
    var y = OY + iy * res, lc = [], ln = [];
    // Boundary (parity) test: CUT lines only.
    for (var s = 0; s < cutSegs.length; s++) {
      var g = cutSegs[s], y1 = g[1], y2 = g[3];
      if ((y1 > y) !== (y2 > y)) lc.push(g);
    }
    // Wall test: every line (cut AND crease) separates two panels.
    for (var s2 = 0; s2 < segs.length; s2++) {
      var g2 = segs[s2];
      var lo = Math.min(g2[1], g2[3]) - LINE_WIDTH, hi = Math.max(g2[1], g2[3]) + LINE_WIDTH;
      if (y >= lo && y <= hi) ln.push(g2);
    }
    rowCross[iy] = lc; rowNear[iy] = ln;
  }

  // ---- 4. Rasterise: paper-interior pixels not sitting on a line ----
  var grid = new Uint8Array(W * H);
  for (var iy = 0; iy < H; iy++) {
    var y = OY + iy * res, lc = rowCross[iy], ln = rowNear[iy];
    for (var ix = 0; ix < W; ix++) {
      var x = OX + ix * res, cross = 0;
      for (var s = 0; s < lc.length; s++) {
        var g = lc[s];
        var xi = g[0] + (g[2] - g[0]) * (y - g[1]) / (g[3] - g[1]);
        if (xi > x) cross++;
      }
      if ((cross % 2) !== 1) continue;
      var onLine = false;
      for (var s = 0; s < ln.length; s++) {
        if (_ptSegDist(x, y, ln[s]) < LINE_WIDTH) { onLine = true; break; }
      }
      if (!onLine) grid[iy * W + ix] = 1;
    }
  }

  // ---- 5. Connected components (4-neighbour BFS) ----
  var labels = new Int32Array(W * H);
  for (var i = 0; i < labels.length; i++) labels[i] = -1;
  var comps = [], stack = [];
  for (var iy = 0; iy < H; iy++) {
    for (var ix = 0; ix < W; ix++) {
      var idx = iy * W + ix;
      if (!grid[idx] || labels[idx] >= 0) continue;
      var lab = comps.length, comp = [];
      stack.length = 0; stack.push(idx); labels[idx] = lab;
      while (stack.length) {
        var cur = stack.pop(); comp.push(cur);
        var cy = Math.floor(cur / W), cx = cur - cy * W, n;
        if (cx > 0)     { n = cur - 1; if (grid[n] && labels[n] < 0) { labels[n] = lab; stack.push(n); } }
        if (cx < W - 1) { n = cur + 1; if (grid[n] && labels[n] < 0) { labels[n] = lab; stack.push(n); } }
        if (cy > 0)     { n = cur - W; if (grid[n] && labels[n] < 0) { labels[n] = lab; stack.push(n); } }
        if (cy < H - 1) { n = cur + W; if (grid[n] && labels[n] < 0) { labels[n] = lab; stack.push(n); } }
      }
      comps.push(comp);
    }
  }

  // ---- 5b. Merge slivers into their biggest neighbour ----
  // Every drawn line becomes a wall, so a decorative score, a rounded corner
  // discretised into chords, or a slot that ends 1 px short shaves off thin
  // strips of board. Those strips are not panels — they inflated Q011 to 89
  // "panels" and left the fold tree with nothing sensible to connect. Anything
  // far smaller than the largest region is absorbed by whichever neighbour it
  // shares the most border with.
  var _compsRaw = comps.length, _minPx = 0, _merged = 0;
  if (comps.length > 1) {
    var maxComp = 0;
    for (var ci2 = 0; ci2 < comps.length; ci2++) if (comps[ci2].length > maxComp) maxComp = comps[ci2].length;
    var minPx = Math.max(10, Math.floor(maxComp * 0.004));
    _minPx = minPx;
    // Pixel count alone misses the worst offenders: a 1-2 px wide ribbon running
    // diagonally across a panel holds plenty of pixels yet traces to a degenerate
    // sliver. Judge by how much of its own bounding box a region fills instead —
    // a real panel is solid (fill ~1.0), a ribbon is not (fill < 0.25).
    var isSliver = function (comp) {
      if (!comp || comp.length < 12) return true;
      if (comp.length < minPx) return true;
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (var z = 0; z < comp.length; z++) {
        var cy = Math.floor(comp[z] / W), cx = comp[z] - cy * W;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      }
      var bw2 = x1 - x0 + 1, bh2 = y1 - y0 + 1;
      if (bw2 <= 2 || bh2 <= 2) return true;                 // a ribbon, not a panel
      return (comp.length / (bw2 * bh2)) < 0.25;
    };
    var mergeTo = {};
    var changed = true, guard2 = 0;
    while (changed && guard2++ < 8) {
      changed = false;
      for (var ci3 = 0; ci3 < comps.length; ci3++) {
        if (!comps[ci3] || comps[ci3].length === 0) continue;
        if (!isSliver(comps[ci3])) continue;
        var tallyNb = {}, bestNb = -1, bestCnt = 0;
        // Regions never touch: the raster burns a LINE_WIDTH wall between them,
        // so a plain 4-neighbour look-up only ever finds wall (-1). Step outward
        // far enough to cross that wall, weighting closer hits higher.
        var REACH = Math.max(2, Math.ceil(LINE_WIDTH / res) + 2);
        var DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var q3 = 0; q3 < comps[ci3].length; q3++) {
          var cur3 = comps[ci3][q3], cy3 = Math.floor(cur3 / W), cx3 = cur3 - cy3 * W;
          for (var ni = 0; ni < 4; ni++) {
            for (var d3 = 1; d3 <= REACH; d3++) {
              var tx = cx3 + DIR4[ni][0] * d3, ty = cy3 + DIR4[ni][1] * d3;
              if (tx < 0 || ty < 0 || tx >= W || ty >= H) break;
              var v = labels[ty * W + tx];
              if (v < 0 || v === ci3) continue;
              var root3 = v;
              while (mergeTo[root3] != null) root3 = mergeTo[root3];
              if (root3 === ci3) continue;
              var w = 1 / d3;
              tallyNb[root3] = (tallyNb[root3] || 0) + w;
              if (tallyNb[root3] > bestCnt) { bestCnt = tallyNb[root3]; bestNb = root3; }
              break;
            }
          }
        }
        if (bestNb >= 0) { mergeTo[ci3] = bestNb; changed = true; }
      }
    }
    _merged = Object.keys(mergeTo).length;
    if (Object.keys(mergeTo).length) {
      var resolve = function (l) { var r = l, g9 = 0; while (mergeTo[r] != null && g9++ < 64) r = mergeTo[r]; return r; };
      var newComps = [];
      for (var ci4 = 0; ci4 < comps.length; ci4++) {
        var tgt = resolve(ci4);
        newComps[tgt] = (newComps[tgt] || []).concat(comps[ci4]);
      }
      comps = [];
      for (var ci5 = 0; ci5 < newComps.length; ci5++) if (newComps[ci5]) comps.push(newComps[ci5]);
      // Relabel the grid so the contour tracer sees the merged regions.
      labels = new Int32Array(W * H);
      for (var li6 = 0; li6 < labels.length; li6++) labels[li6] = -1;
      for (var ci6 = 0; ci6 < comps.length; ci6++) {
        for (var qi = 0; qi < comps[ci6].length; qi++) labels[comps[ci6][qi]] = ci6;
      }
    }
  }

  // ---- 5c. Pixel-level panel adjacency ----
  // Probing perpendicular from crease lines missed far too much: on JP033 78% of
  // samples walked 12 mm without ever landing in a panel, which orphaned the two
  // LARGEST panels and left the net as 15 disconnected islands. The raster itself
  // already knows who touches whom — walk out of every region pixel, across the
  // line wall, and note the first region on the far side. Whether a shared
  // boundary is a FOLD is decided afterwards by looking for a crease along it.
  var adjacency = [];
  {
    var WALL_REACH = Math.max(2, Math.ceil(LINE_WIDTH / res) + 2);
    // Second, wider tier: some die-lines leave real gaps of several mm between
    // panels (JP033's blank comes apart into 9 pieces at wall reach alone). These
    // "bridge" edges keep the shapes untouched but let the fold tree span the
    // gap; they are scored far below touching edges so they are only used when
    // nothing better can reach a panel.
    var REACH2 = Math.max(WALL_REACH + 1, Math.ceil(LINE_WIDTH / res) + 8);
    var D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    var acc = {};
    for (var ay = 0; ay < H; ay++) {
      for (var ax = 0; ax < W; ax++) {
        var la = labels[ay * W + ax];
        if (la < 0) continue;
        for (var d4 = 0; d4 < 4; d4++) {
          for (var r2 = 1; r2 <= REACH2; r2++) {
            var tx2 = ax + D4[d4][0] * r2, ty2 = ay + D4[d4][1] * r2;
            if (tx2 < 0 || ty2 < 0 || tx2 >= W || ty2 >= H) break;
            var lb = labels[ty2 * W + tx2];
            if (lb < 0 || lb === la) continue;
            var kk = (la < lb) ? (la + '|' + lb) : (lb + '|' + la);
            var e = acc[kk];
            if (!e) e = acc[kk] = { a: Math.min(la, lb), b: Math.max(la, lb),
                                    n: 0, near: 0, pts: [], far: 0,
                                    fpts: [] };
            e.n++;
            var cxp = (ax + tx2) / 2, cyp = (ay + ty2) / 2;
            if (r2 <= WALL_REACH) {
              e.near++;
              if (e.pts.length < 600) e.pts.push([cxp, cyp]);
            } else {
              // Only reachable across a gap. These must NOT feed the geometry:
              // mixing them in dragged the fitted boundary several mm off the real
              // one (D038: contacts sat at y=20 while the hinge line landed at
              // y=25), which read as "no crease here" and the walls never folded.
              e.far++;
              if (e.fpts.length < 200) e.fpts.push([cxp, cyp]);
            }
            break;
          }
        }
      }
    }
    Object.keys(acc).forEach(function (kk) {
      var e = acc[kk];
      if (e.n < 3) return;
      // Geometry comes from the touching contacts. A pair reachable only across a
      // gap still gets an edge (that is the whole point of the bridge tier) but
      // falls back to the gap-spanning contacts for an approximate hinge line.
      var gpts = (e.pts.length >= 3) ? e.pts : e.fpts;
      var isBridge = e.pts.length < 3;
      var near = gpts.length;
      if (near < 3) return;
      var cxm = 0, cym = 0;
      for (var q0 = 0; q0 < near; q0++) { cxm += gpts[q0][0]; cym += gpts[q0][1]; }
      cxm /= near; cym /= near;
      // Principal axis of the contact pixels = the direction of the shared edge.
      var sxx = 0, syy = 0, sxy = 0;
      for (var q2 = 0; q2 < near; q2++) {
        var ddx = gpts[q2][0] - cxm, ddy = gpts[q2][1] - cym;
        sxx += ddx * ddx; syy += ddy * ddy; sxy += ddx * ddy;
      }
      var ux2 = 1, uy2 = 0;
      if (sxx !== 0 || syy !== 0 || sxy !== 0) {
        var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        ux2 = Math.cos(theta); uy2 = Math.sin(theta);
      }
      var lo3 = 1e9, hi3 = -1e9;
      for (var q3 = 0; q3 < near; q3++) {
        var t3 = (gpts[q3][0] - cxm) * ux2 + (gpts[q3][1] - cym) * uy2;
        if (t3 < lo3) lo3 = t3;
        if (t3 > hi3) hi3 = t3;
      }
      // Contact points in mm, evenly subsampled. They let the caller ask
      // "does a crease run along this boundary?" by direct proximity instead of
      // by fitting a line and testing collinearity — that fit broke down on
      // curved / staircased boundaries and reported cov = 0 for real folds.
      var ptsMM = [], stride = Math.max(1, Math.floor(near / 120));
      for (var q4 = 0; q4 < near; q4 += stride) {
        ptsMM.push([OX + gpts[q4][0] * res, OY + gpts[q4][1] * res]);
      }
      adjacency.push({
        a: e.a, b: e.b, weight: e.n, bridge: isBridge, pts: ptsMM,
        cx: OX + cxm * res, cy: OY + cym * res,
        ux: ux2, uy: uy2, len: (hi3 - lo3) * res
      });
    });
  }

  // ---- 6. Trace every region outline (Moore-neighbour tracking) ----
  var DIRS = [[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1]];
  var panels = [];
  for (var ci = 0; ci < comps.length; ci++) {
    var comp = comps[ci];
    if (comp.length < 12) continue;
    var inSet = {};
    for (var i = 0; i < comp.length; i++) inSet[comp[i]] = 1;
    var startIdx = -1, bestY = 1e9, bestX = 1e9;
    for (var i = 0; i < comp.length; i++) {
      var yy = Math.floor(comp[i] / W), xx = comp[i] - yy * W;
      if (yy < bestY || (yy === bestY && xx < bestX)) { bestY = yy; bestX = xx; startIdx = comp[i]; }
    }
    if (startIdx < 0) continue;
    var sy = Math.floor(startIdx / W), sx = startIdx - sy * W;
    var prevX = sx - 1, prevY = sy, curX = sx, curY = sy;
    var contour = [], guard = 0;
    while (guard++ < 200000) {
      contour.push([OX + curX * res, OY + curY * res]);
      var dx = prevX - curX, dy = prevY - curY, di = 0;
      for (var d = 0; d < 8; d++) { if (DIRS[d][0] === dx && DIRS[d][1] === dy) { di = d; break; } }
      var found = false, nx = 0, ny = 0;
      for (var k = 1; k <= 8; k++) {
        var nd = (di + k) % 8;
        var tx = curX + DIRS[nd][0], ty = curY + DIRS[nd][1];
        if (tx >= 0 && ty >= 0 && tx < W && ty < H && inSet[ty * W + tx]) { nx = tx; ny = ty; found = true; break; }
      }
      if (!found) break;
      if (nx === sx && ny === sy) break;
      prevX = curX; prevY = curY; curX = nx; curY = ny;
    }
    if (contour.length < 6) continue;
    // Stronger simplification: the raw raster contour is staircase-like, so a
    // larger epsilon merges the steps into clean straight panel edges needed for
    // reliable hinge matching.
    var poly = _simplifyPoly(contour, res * 2.0);
    if (!poly || poly.length < 4) continue;
    var area = Math.abs(polyArea(poly));
    if (area < 30) continue;
    panels.push({ bbox: _polyBBox(poly), poly: poly, area: area, comp: ci });
  }
  if (!panels.length) return null;
  panels.sort(function (a, b) { return b.area - a.area; });
  // Re-key the adjacency from region numbers to the area-sorted panel indices
  // (the caller keys panels P0..Pn in this order).
  var compToIdx = {};
  for (var cpi = 0; cpi < panels.length; cpi++) compToIdx[panels[cpi].comp] = cpi;
  var adjOut = [];
  for (var adi = 0; adi < adjacency.length; adi++) {
    var ad = adjacency[adi];
    var ia = compToIdx[ad.a], ib = compToIdx[ad.b];
    if (ia == null || ib == null) continue;   // a region that never traced to a panel
    adjOut.push({ a: ia, b: ib, weight: ad.weight, bridge: ad.bridge, pts: ad.pts,
                  cx: ad.cx, cy: ad.cy, ux: ad.ux, uy: ad.uy, len: ad.len });
  }
  Preview3D._rasterAdj = adjOut;
  var gridTrue = 0;
  for (var gi = 0; gi < grid.length; gi++) if (grid[gi]) gridTrue++;
  Preview3D._rasterDebug = { W: W, H: H, res: res, comps: comps.length,
                             panels: panels.length, lineWidth: LINE_WIDTH,
                             gridTrue: gridTrue, segs: segs.length,
                             grid: grid, labels: labels, cutSegs: cutSegs.length,
                             compsRaw: _compsRaw, minPx: _minPx, merged: _merged };
  Preview3D._rasterRes = res;
  return panels;
}

function _ptSegDist(px, py, g) {
  var x1 = g[0], y1 = g[1], x2 = g[2], y2 = g[3];
  var dx = x2 - x1, dy = y2 - y1, den = dx * dx + dy * dy;
  if (den < 1e-12) return Math.hypot(px - x1, py - y1);
  var t = ((px - x1) * dx + (py - y1) * dy) / den;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function _polyBBox(poly) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < poly.length; i++) {
    var p = poly[i];
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  // Expand slightly so adjacent panel bboxes overlap/touch at the original
  // die-line, which lets rectEdges-based hinge detection find shared edges.
  var PAD = 0.6;
  return [minX - PAD, minY - PAD, maxX + PAD, maxY + PAD];
}

function _perpDist(a, b, p) {
  var dx = b[0] - a[0], dy = b[1] - a[1], den = Math.hypot(dx, dy);
  if (den < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / den;
}

function _simplifyPoly(pts, eps) {
  if (pts.length <= 4) return pts;
  var keep = new Array(pts.length), i;
  for (i = 0; i < pts.length; i++) keep[i] = false;
  keep[0] = true; keep[pts.length - 1] = true;
  var stack = [[0, pts.length - 1]], guard = 0;
  while (stack.length && guard++ < 100000) {
    var rg = stack.pop(), i0 = rg[0], i1 = rg[1];
    if (i1 <= i0 + 1) continue;
    var maxD = 0, idx = -1;
    for (i = i0 + 1; i < i1; i++) {
      var d = _perpDist(pts[i0], pts[i1], pts[i]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep[idx] = true; stack.push([i0, idx]); stack.push([idx, i1]); }
  }
  var out = [];
  for (i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// ExtrudeGeometry hands out raw world-space UVs (WorldUVGenerator), which both
// stretches the board texture and leaves the corrugated edge un-tiled. Remap per
// material group: printed faces to the panel rectangle (so artwork lines up), cut
// edges along their perimeter (so the flutes read as flutes).
function _remapSlabUVs(geo, F, T) {
  var pos = geo.attributes && geo.attributes.position;
  if (!pos) return;
  var uv = geo.attributes.uv;
  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  var fw = Math.max(F.w, 0.001), fh = Math.max(F.h, 0.001), tt = Math.max(T, 0.001);
  function remap(start, count, isWall) {
    for (var i = start; i < start + count; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (isWall) uv.setXY(i, z * 2.0 / tt, (Math.abs(x) + Math.abs(y)) / 6);
      else uv.setXY(i, (x + fw / 2) / fw, (y + fh / 2) / fh);
    }
  }
  var groups = geo.groups;
  if (groups && groups.length) {
    for (var g = 0; g < groups.length; g++) remap(groups[g].start, groups[g].count, groups[g].materialIndex === 1);
  } else {
    remap(0, pos.count, false);
  }
  uv.needsUpdate = true;
}

/* ===== Procedural board materials ===== */
// Cardboard does not read as a flat white surface: it has fibre speckle on the
// printed face, a warmer tone inside and a striped corrugated core at every cut
// edge. Generating these on a canvas keeps the preview self-contained (no asset
// files to ship) and is what finally gets rid of the "transparent plastic sheet"
// look — together with real slab thickness and shadows.
var _texCache = {};
function _boardTexture() {
  if (_texCache.board) return _texCache.board;
  var S = 256;
  var cv = document.createElement('canvas'); cv.width = cv.height = S;
  var ctx = cv.getContext('2d');
  ctx.fillStyle = '#f4f0e6'; ctx.fillRect(0, 0, S, S);
  var img = ctx.getImageData(0, 0, S, S), d = img.data;
  for (var i = 0; i < d.length; i += 4) {
    var n = (Math.random() - 0.5) * 16;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.06;
  for (var f = 0; f < 260; f++) {
    ctx.strokeStyle = Math.random() > 0.5 ? '#a89b83' : '#ffffff';
    ctx.lineWidth = Math.random() * 1.1 + 0.3;
    var y = Math.random() * S, x0 = Math.random() * S, len = Math.random() * 80 + 20;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + len, y + (Math.random() - 0.5) * 2.5); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  var tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  _texCache.board = tex;
  return tex;
}
function _edgeTexture() {
  if (_texCache.edge) return _texCache.edge;
  var w = 64, h = 64;
  var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  var ctx = cv.getContext('2d');
  ctx.fillStyle = '#cfa872'; ctx.fillRect(0, 0, w, h);
  for (var x = 0; x < w; x += 6) {                 // corrugation flutes
    ctx.fillStyle = 'rgba(120,86,48,0.30)'; ctx.fillRect(x, 0, 2, h);
    ctx.fillStyle = 'rgba(240,220,186,0.28)'; ctx.fillRect(x + 3, 0, 2, h);
  }
  var img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (var i = 0; i < d.length; i += 4) { var n = (Math.random() - 0.5) * 18; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  ctx.putImageData(img, 0, 0);
  var tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  _texCache.edge = tex;
  return tex;
}
function _backdropTexture() {
  if (_texCache.bg) return _texCache.bg;
  var w = 8, h = 256;
  var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  var ctx = cv.getContext('2d');
  var g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f7f6f3');
  g.addColorStop(0.55, '#e6e7ea');
  g.addColorStop(1, '#cfd2d6');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  var tex = new THREE.CanvasTexture(cv);
  if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  _texCache.bg = tex;
  return tex;
}

/* ===== Build the full Three.js scene ===== */
Preview3D._buildThree = function(container, boxType, params, faceData, isReconstructed) {
  // Cache for quick texture updates
  Preview3D._cache = { boxType: boxType, faceData: faceData, params: params, container: container };

  // Release the PREVIOUS render's resources before building a new one. render3D()
  // is called on every parameter change / box switch while the 3D view is open,
  // and each call used to leak the old WebGLRenderer + requestAnimationFrame loop
  // + window-level mousemove/mouseup/resize listeners. _cleanup disposes the
  // renderer, cancels the RAF and detaches those listeners; _viewReset/_viewZoom
  // are re-assigned below, so clearing them here is safe.
  if (container._threeRenderer || container._animId || container._mouseMoveHandler || container._resizeHandler) {
    Preview3D._cleanup(container);
  }

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
  // Crease geometry first: the fold hierarchy is chosen from it, so it has to be
  // available before the root panel is picked.
  var creases = _extractCreasePolys(
    (boxType.currentBoxData || boxType.packmageData || {}).fe,
    Math.abs(((boxType.currentBoxData || boxType.packmageData || {}).de || {}).ox || 0),
    Math.abs(((boxType.currentBoxData || boxType.packmageData || {}).de || {}).oy || 0));

  var areaOf = {};
  var faceKeys = Object.keys(faceData).filter(function(k) { return !!fr(k); });
  faceKeys.forEach(function(k) { var r = fr(k); areaOf[k] = r.w * r.h; });
  if (!faceKeys.length) { Preview3D._renderSimple(container, boxType, params); return; }
  var root = faceKeys.slice().sort(function(a, b) { return areaOf[b] - areaOf[a]; })[0];
  // Manual fold editor: a user-pinned base panel ("设为固定面") wins over every
  // heuristic below — including the crease-connectivity and _pickRootByFit
  // searches — because the user clicked a panel on the 2D net on purpose.
  var _ovRootKey = null;
  var _ovFlip = {};
  var _ovHinges = [];    // S3: user-pinned hinges  [{parent, child, ov}]
  var _ovNofolds = {};   // S3: banned pairs        {'a|b': true}
  var _ovAngles = {};    // S4: per-panel foldMult  {key: 0|2}
  if (Preview3D._overrides) {
    if (Preview3D._overrides.root && faceKeys.indexOf(Preview3D._overrides.root) >= 0) {
      _ovRootKey = Preview3D._overrides.root;
      root = _ovRootKey;
    }
    (Preview3D._overrides.flips || []).forEach(function(k) {
      if (faceKeys.indexOf(k) >= 0) _ovFlip[k] = true;
    });
    (Preview3D._overrides.hinges || []).forEach(function(h) {
      if (h && h.parent && h.child && h.ov && h.ov.orient &&
          faceKeys.indexOf(h.parent) >= 0 && faceKeys.indexOf(h.child) >= 0) {
        _ovHinges.push(h);
      }
    });
    (Preview3D._overrides.nofolds || []).forEach(function(kk) { _ovNofolds[kk] = true; });
    var _oa = Preview3D._overrides.angles || {};
    Object.keys(_oa).forEach(function(k) {
      if (faceKeys.indexOf(k) >= 0 && typeof _oa[k] === 'number') _ovAngles[k] = _oa[k];
    });
  }
  // Root on the largest panel. Ranking by crease connectivity (selectable with
  // Preview3D._rootBy = 'crease') looked better in principle but picks narrow
  // fold strips squeezed between two long creases: N001 based its whole carton
  // on an 18 mm rim strip, and HC104BD measured 41% off instead of 18%.
  if (!_ovRootKey && Preview3D._isRasterFaces && Preview3D._rootBy === 'crease') {
    var _cand = _rasterAdjPairs(Preview3D._rasterAdj, creases);
    var _deg = {};
    _cand.forEach(function (p) {
      if (!(p.cov > 0.25)) return;
      _deg[p.a] = (_deg[p.a] || 0) + p.len;
      _deg[p.b] = (_deg[p.b] || 0) + p.len;
    });
    var _bestRoot = null, _bestDeg = -1;
    for (var _ri2 = 0; _ri2 < faceKeys.length; _ri2++) {
      var _k2 = faceKeys[_ri2], _dv = _deg[_k2] || 0;
      if (_dv > _bestDeg || (_dv === _bestDeg && _bestRoot && areaOf[_k2] > areaOf[_bestRoot])) {
        _bestDeg = _dv; _bestRoot = _k2;
      }
    }
    if (_bestRoot && _bestDeg > 0) root = _bestRoot;
  }
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
  // A soft vertical gradient reads as a studio backdrop and stops the carton from
  // floating in flat grey — a big part of the old "cheap plastic" impression.
  scene.background = _backdropTexture();
  var camera = new THREE.PerspectiveCamera(40, containerW / containerH, 1, 5000);
  var renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(containerW, containerH);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);
  container._threeRenderer = renderer;
  // Expose for debugging/screenshot
  window._p3dScene = scene;
  window._p3dCamera = camera;
  window._p3dRenderer = renderer;

  // ---- Lighting ----
  // Three-point studio rig: a shadow-casting key light gives the carton weight
  // (contact shadow on the floor), a cool fill keeps the shaded faces readable,
  // and a rim light separates the silhouette from the backdrop.
  var _span = Math.max(L, D, W, 100);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8f7d, 0.55));
  var key = new THREE.DirectionalLight(0xfff6e8, 0.85);
  key.position.set(_span * 0.9, _span * 1.5, _span * 1.2);
  key.castShadow = true;
  key.shadow.mapSize.width = 1024;
  key.shadow.mapSize.height = 1024;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = _span * 8;
  var _sh = _span * 1.6;
  key.shadow.camera.left = -_sh; key.shadow.camera.right = _sh;
  key.shadow.camera.top = _sh; key.shadow.camera.bottom = -_sh;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = _span * 0.004;
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xdfe8ff, 0.32);
  fill.position.set(-_span * 1.2, -_span * 0.5, _span * 0.8);
  scene.add(fill);
  var rim = new THREE.DirectionalLight(0xffffff, 0.28);
  rim.position.set(-_span * 0.4, _span * 0.8, -_span * 1.4);
  scene.add(rim);

  // Ground: catches the contact shadow so the carton sits on something instead of
  // hovering in space. It lives in the scene (not the view group) so it stays
  // level while the user orbits.
  var _ground = new THREE.Mesh(
    new THREE.PlaneGeometry(_span * 12, _span * 12),
    new THREE.ShadowMaterial({ opacity: 0.22 })
  );
  _ground.receiveShadow = true;
  _ground.position.set(0, -_span * 0.85, -_span * 0.2);
  _ground.rotation.x = -Math.PI / 2;
  scene.add(_ground);
  Preview3D._ground = _ground;

  var viewGroup = new THREE.Group();   // holds view (rotateX/Y) only
  scene.add(viewGroup);
  window._p3dViewGroup = viewGroup;    // exposed for debugging / external control
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
  if (Preview3D._rasterPolys) {
    // Raster + contour extraction produced true panel outlines — use them.
    planarPolys = Preview3D._rasterPolys;
  } else {
    try {
      if (_bd && _bd.fe && typeof extractPlanarFaces === 'function' && !isReconstructed) {
        var _pf = extractPlanarFaces(_bd.fe, absOx, absOy);
        planarPolys = matchPlanarToFaces(_pf, faceData);
      }
    } catch (e) { planarPolys = {}; }
  }
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

  // Helpers for hinge detection based on actual panel polygons (not bboxes)
  function polyEdgesFrom(poly) {
    var edges = [];
    if (!poly || poly.length < 3) return edges;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      var orient = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      var dir = { x: dx / len, y: dy / len };
      edges.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1],
                   cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2,
                   len: len, orient: orient, dir: dir });
    }
    return edges;
  }
  function edgesMatch(ea, eb, tol) {
    // Parallel test (directions may be opposite)
    var dot = ea.dir.x * eb.dir.x + ea.dir.y * eb.dir.y;
    if (Math.abs(Math.abs(dot) - 1) > 0.35) return null;
    // Perpendicular distance between the two lines
    var dx = eb.cx - ea.cx, dy = eb.cy - ea.cy;
    var perp = Math.abs(-ea.dir.y * dx + ea.dir.x * dy);
    if (perp > tol) return null;
    // Projection overlap of eb onto ea
    var along = ea.dir.x * dx + ea.dir.y * dy;
    var halfA = ea.len / 2, halfB = eb.len / 2;
    var lo = Math.max(-halfA, along - halfB);
    var hi = Math.min(halfA, along + halfB);
    if (hi - lo < 5) return null;
    var cAlong = (lo + hi) / 2;
    var cx = ea.cx + cAlong * ea.dir.x;
    var cy = ea.cy + cAlong * ea.dir.y;
    var half = (hi - lo) / 2;
    var ux = ea.dir.x * half, uy = ea.dir.y * half;
    var orient = Math.abs(ea.dir.x) > Math.abs(ea.dir.y) ? 'h' : 'v';
    return { x1: cx - ux, y1: cy - uy, x2: cx + ux, y2: cy + uy,
             cx: cx, cy: cy, len: hi - lo, orient: orient,
             dir: { x: ea.dir.x, y: ea.dir.y } };
  }

  /* ---- Crease-driven adjacency (see creaseAdjacency below) ---- */
  function _ptInPoly(px, py, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // Build hinge candidates sorted by ABSOLUTE overlap length. Real fold hinges
  // (200 mm wall edges) always beat accidental cut contacts (8 mm corner touches)
  // because a genuine hinge shares the FULL edge length of at least one panel.
  var allPairs = [];
  // Raster panels: derive adjacency from the CREASE lines themselves. Bounding
  // boxes are unreliable neighbours here — the raster burns a ~1 px wall along
  // every line and lock/tuck shapes leave 10 mm+ gaps, which splits one piece of
  // board into disconnected islands (JP012 → 3 islands / 4 hinges); and at coarse
  // resolutions the contour simplification shifts edges further than the 3 mm bbox
  // tolerance so nothing matches at all (Q011 → 89 panels / 0 hinges).
  if (Preview3D._isRasterFaces) {
    allPairs = _rasterAdjPairs(Preview3D._rasterAdj, creases);
    // Crease probing still contributes pairs the raster cannot see (a crease
    // running through a region the raster merged), so union the two sources.
    if (creases && creases.length) {
      var seenP = {};
      allPairs.forEach(function (p) {
        seenP[(p.a < p.b ? p.a + '|' + p.b : p.b + '|' + p.a)] = 1;
      });
      creaseAdjacency(faceKeys, planarPolys, creases).forEach(function (p) {
        var k = (p.a < p.b ? p.a + '|' + p.b : p.b + '|' + p.a);
        if (!seenP[k]) { seenP[k] = 1; p.cov = 1; p.score = p.len * 3; allPairs.push(p); }
      });
    }
  }
  // A bridge edge may span a gap, but it still has to be physically plausible:
  // the shared boundary must lie near BOTH panels. Without this a panel gets
  // hinged onto a neighbour clear across the net and swings in from nowhere
  // (HC106C grew a hinge 2.8x its own panel size).
  function pairPlausible(p) {
    var ra = fr(p.a), rb = fr(p.b);
    if (!ra || !rb) return false;
    var padA = Math.max(ra.w, ra.h) * 0.6, padB = Math.max(rb.w, rb.h) * 0.6;
    var pad = Math.max(padA, padB);
    var ov = p.ov;
    var inA = ov.cx >= ra.x1 - pad && ov.cx <= ra.x2 + pad &&
              ov.cy >= ra.y1 - pad && ov.cy <= ra.y2 + pad;
    var inB = ov.cx >= rb.x1 - pad && ov.cx <= rb.x2 + pad &&
              ov.cy >= rb.y1 - pad && ov.cy <= rb.y2 + pad;
    return inA && inB;
  }
  if (Preview3D._isRasterFaces) {
    allPairs = allPairs.filter(function (p) { return !p.bridge || pairPlausible(p); });
    // A hinge needs a real shared edge. Two panels that meet only at a corner
    // produce a zero-length "hinge" whose axis is meaningless, and the panel
    // then swings out by its own full size: N001's two 199x29 rim strips hung off
    // a wall by a corner and stuck 200 mm out of a 300x200x50 tray. Better to
    // leave such a panel as its own piece, lying flat where the die-line put it.
    var _minHinge = (Preview3D._minHingeLen != null) ? Preview3D._minHingeLen : 4;
    if (Preview3D._minHingeLen !== 0) {
      allPairs = allPairs.filter(function (p) { return p.len >= _minHinge; });
    }
  }
  Preview3D._pairSource = allPairs.length ? 'raster' : 'bbox';
  if (!allPairs.length) {
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
  }
  Preview3D._debugAllPairs = allPairs.slice(0, 8).map(function(p){ return {a:p.a, b:p.b, len: Math.round(p.len)}; });
  Preview3D._debugEdgeCounts = {};
  faceKeys.forEach(function(k){ Preview3D._debugEdgeCounts[k] = polyEdgesFrom(planarPolys[k]||[]).length; });
  // Manual fold editor (S3): pairs the user banned ("禁止折叠") are dropped
  // BEFORE scoring, so neither the Dijkstra tree nor the island grower (both
  // walk allPairs) can ever attach through them. The rescue passes below build
  // their own overlaps instead of using allPairs, so they re-check the ban
  // separately.
  if (Object.keys(_ovNofolds).length) {
    allPairs = allPairs.filter(function (p) {
      var kk = p.a < p.b ? p.a + '|' + p.b : p.b + '|' + p.a;
      return !_ovNofolds[kk];
    });
  }
  // Crease-backed boundaries win OUTRIGHT, not merely by a weight factor. With a
  // multiplier a long crease-free contact outranked a short real fold (196 mm x 1
  // beat 50 mm x 3), so the tree grew along "panels that happen to touch" instead
  // of "panels that are hinged" — every downstream panel then folded about the
  // wrong axis and the carton stayed splayed open (median size error 141%).
  // 0.25 is not an arbitrary cut: measured coverages cluster cleanly into
  // ">= 0.37" (a crease runs the length of the boundary) and "<= 0.09" (no crease
  // at all), with nothing in between. Using 0.05 swept the noise in as real folds.
  function _isFold(p) { return p.cov != null && p.cov > 0.25; }
  allPairs.forEach(function (p) {
    p.score = p.len * (_isFold(p) ? 3 : 1) * (p.bridge ? 0.08 : 1);
  });
  allPairs.sort(function (x, y) {
    var cx = _isFold(x) ? 1 : 0;
    var cy = _isFold(y) ? 1 : 0;
    if (cx !== cy) return cy - cx;               // real folds first, always
    return (y.score || y.len) - (x.score || x.len);
  });

  // Shortest-path tree from the base (Dijkstra, cost = 1 / crease length).
  //
  // A maximum-spanning tree (what this used to be) maximises the TOTAL weight but
  // says nothing about how far a panel sits from the base, so a wall would happily
  // hang off a narrow flap that merely shared a long edge with it. Q013's two side
  // walls (292x394) attached through a 396x75 flap instead of straight onto the
  // 396x396 back panel — the hinge it was handed measured 394 mm, which is the
  // back panel's edge, not the flap's. They then folded about the wrong axis and
  // the carton came out 483x424x401 instead of 400x400x300.
  //
  // Minimising the summed 1/length along the path makes every panel reach the base
  // through the strongest available chain of real folds.
  function edgeCost(p) {
    var c = 1 / Math.max(p.len, 1);
    if (!_isFold(p)) c *= 100;      // touching but uncreased: strongly discouraged
    if (p.bridge) c *= 100;         // reachable only across a gap: last resort
    return c;
  }
  var parentOf = {}, hingeOf = {}, hingeCov = {}, vis = {}, usedEdge = {}, dist = {};
  function growTree(rootKey) {
    parentOf = {}; hingeOf = {}; hingeCov = {}; vis = {}; usedEdge = {}; dist = {};
    vis[rootKey] = true;
    faceKeys.forEach(function (k) { dist[k] = Infinity; });
    dist[rootKey] = 0;
    while (true) {
      var pick = null, pickCost = Infinity;
      for (var pi = 0; pi < allPairs.length; pi++) {
        var p = allPairs[pi];
        if (usedEdge[p.a + ',' + p.b]) continue;
        var canA = vis[p.a] && !vis[p.b];
        var canB = vis[p.b] && !vis[p.a];
        if (!canA && !canB) continue;
        var cost = dist[canA ? p.a : p.b] + edgeCost(p);
        if (cost < pickCost) {
          pickCost = cost;
          pick = canA ? { p: p.a, k: p.b, ov: p.ov, cov: p.cov } : { p: p.b, k: p.a, ov: p.ov, cov: p.cov };
        }
      }
      if (!pick) break;
      parentOf[pick.k] = pick.p;
      hingeOf[pick.k] = pick.ov;
      hingeCov[pick.k] = pick.cov;
      dist[pick.k] = pickCost;
      vis[pick.k] = true;
      usedEdge[pick.p + ',' + pick.k] = 1;
    }
    return Object.keys(vis).length;
  }
  growTree(root);

  // Pick the base panel by RESULT. The heuristics above guess; the design
  // dimensions in de.op tell us the truth, so try the plausible candidates and
  // keep whichever folds closest to L x W x D. N001, JP012 and HC104BD were each
  // 40-50% off purely because the wrong panel was held still.
  // Off by default. Choosing the base by best fit to L/W/D helped N001 (51%->35%)
  // and HC104BD (41%->18%) but hurt C023 (72%->89%): this analytic score covers
  // only the Dijkstra tree, while the renderer folds in the rescue passes
  // afterwards, so the two disagree just often enough to be a net wash. Left in
  // behind a flag because the idea is sound once the scoring matches the render.
  var _wantDims = !_ovRootKey && !_ovHinges.length && Preview3D._pickRootByFit
    ? _designDims((boxType.currentBoxData || boxType.packmageData || {}).de) : null;
  if (_wantDims && faceKeys.length > 2) {
    var cands = faceKeys.slice().sort(function (a, b) { return areaOf[b] - areaOf[a]; });
    if (cands.length > 10) cands = cands.slice(0, 10);
    // The heuristic root must always be in the running, otherwise the search can
    // only ever replace it — never confirm it (C023 regressed 72% -> 89%).
    if (cands.indexOf(root) < 0) cands.unshift(root);
    var savedRoot = root;
    // Pass 1: how many panels can any root reach? A root that scores beautifully
    // while dropping half the blank is not better, it is just smaller.
    var maxReach = 0;
    var evalRoot = function (cand) {
      var reach = growTree(cand);
      var sz = _foldedSizeAnalytic(faceData, parentOf, hingeOf, cand).sort(function (a, b) { return b - a; });
      var sc = 0;
      for (var ai = 0; ai < 3; ai++) {
        var e3 = (sz[ai] - _wantDims[ai]) / _wantDims[0];
        if (e3 > sc) sc = e3;
      }
      return { reach: reach, sc: sc };
    };
    var reachOf = {};
    for (var _ci = 0; _ci < cands.length; _ci++) {
      var r0 = evalRoot(cands[_ci]);
      reachOf[cands[_ci]] = r0.reach;
      if (r0.reach > maxReach) maxReach = r0.reach;
    }
    // Hard filter: a root that cannot hold the blank together is not a candidate
    // at all. Scoring them and then penalising afterwards let several slip
    // through and made C023 worse.
    cands = cands.filter(function (c) { return reachOf[c] >= maxReach * 0.9; });
    // Pass 2: best fit among roots that keep essentially everything connected.
    var bestRoot = null, bestCombined = Infinity, bestScore = Infinity;
    for (var _cj = 0; _cj < cands.length; _cj++) {
      var rr = evalRoot(cands[_cj]);
      var shortfall = (maxReach - rr.reach) / Math.max(maxReach, 1);
      var combined = rr.sc + 1.5 * Math.max(0, shortfall - 0.05);
      if (combined < bestCombined) {
        bestCombined = combined; bestRoot = cands[_cj]; bestScore = rr.sc;
      }
    }
    // Only override the heuristic root when the alternative is clearly better AND
    // keeps the blank essentially whole. The analytic score covers the Dijkstra
    // tree alone, while the renderer also folds in the rescue passes afterwards,
    // so a marginal "win" here can easily turn into a worse result on screen
    // (C023 regressed 72% -> 89% chasing a 3-point analytic gain).
    var baseEval = evalRoot(savedRoot);
    var baseCombined = baseEval.sc + 1.5 * Math.max(0, (maxReach - baseEval.reach) / Math.max(maxReach, 1) - 0.05);
    if (!(bestRoot && bestCombined < baseCombined - 0.05)) root = savedRoot;
    if (bestRoot !== root) root = bestRoot;
    growTree(root);
    Preview3D._rootScore = Math.round(bestScore * 1000) / 1000;
    Preview3D._rootChanged = (root !== savedRoot);
  }
  var forestRoots = [root];
  var isForestRoot = {}; isForestRoot[root] = true;
  // NOTE: extra island roots are seeded only AFTER the two rescue passes below.
  // Seeding them here used to mark every panel visited, which skipped the rescue
  // passes entirely and stranded connectable panels (T004A's 28x18 mm lock tab
  // became its own island even though it sits 2 mm from the body wall).
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
        var _banKk = rc2.a < rc2.b ? rc2.a + '|' + rc2.b : rc2.b + '|' + rc2.a;
        if (_ovNofolds[_banKk]) continue;   // manual fold editor: banned pair
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
        // Same rule as the main tree: a hinge must have a real shared edge. The
        // rescue pass is exactly where corner-touch pairs used to sneak in, since
        // it builds its own overlaps instead of going through allPairs.
        var _minH = (Preview3D._minHingeLen != null) ? Preview3D._minHingeLen : 4;
        var _banKk2 = bestFother ? (fk < bestFother ? fk + '|' + bestFother : bestFother + '|' + fk) : null;
        if (bestFov && bestFother && !_ovNofolds[_banKk2] && (Preview3D._minHingeLen === 0 || bestFov.len >= _minH)) {
          parentOf[fk] = bestFother; hingeOf[fk] = bestFov; vis[fk] = true;
          hingeCov[fk] = 0;
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
      if (isForestRoot[key]) return;
      var ov = hingeOf[key];
      if (!ov) return;
      // Only apply to LARGE panels — small flaps (tuck tabs, dust flaps) may
      // have arc creases that creaseCoverFrac doesn't detect (arc extraction
      // approximates as chord). Restrict to panels where both faces are > 2000 mm²
      // so only genuine slot-splits (like T004A's front wall) are affected.
      var curR = fr(key), parR = fr(parentOf[key]);
      if (!curR || !parR) return;
      if (curR.w * curR.h < 2000 || parR.w * parR.h < 2000) return;
      // Prefer the coverage measured directly off the raster contact samples; the
      // line-fit estimate is only a fallback.
      var cov = (hingeCov[key] != null) ? hingeCov[key] : creaseCoverFrac(ov, creases);
      // Measured: exempting panels from folding only ever did harm. A missed
      // crease used to leave a whole wall lying flat (median size error 23% -> 11%
      // once the exemption was relaxed, and C023 72% -> 63% when dropped
      // entirely). Nothing in the sample needed a panel held rigid, so this is
      // off. Raise Preview3D._staticCov if a slot-split panel ever needs it.
      var _thr = (Preview3D._staticCov != null) ? Preview3D._staticCov : -1;
      if (cov < _thr) {
        staticHinge[key] = true;
        console.log('[3D-DEBUG] Static hinge (no crease):', key, 'parent:', parentOf[key],
          'cov:', cov.toFixed(3), 'area:', (curR.w * curR.h).toFixed(0));
      }
    });
  }

  // Build a FOREST, not a single tree — but only now, after both rescue passes
  // have had their chance. Some die-lines are exported with the outline split
  // into pieces, so the panel graph really is several islands (JP012 → 3); giving
  // each island its own root lets every part fold instead of lying flat.
  for (var outer = 0; outer < faceKeys.length; outer++) {
    var nextRoot = null, nextA = -1;
    for (var fii = 0; fii < faceKeys.length; fii++) {
      var fk2 = faceKeys[fii];
      if (vis[fk2]) continue;
      var fr2 = fr(fk2);
      if (!fr2) continue;
      var a2 = fr2.w * fr2.h;
      if (a2 > nextA) { nextA = a2; nextRoot = fk2; }
    }
    if (nextRoot == null) break;
    vis[nextRoot] = true;
    forestRoots.push(nextRoot);
    // Grow this island with whatever edges are still unused.
    for (;;) {
      var pick2 = null;
      for (var pi2 = 0; pi2 < allPairs.length; pi2++) {
        var p2 = allPairs[pi2];
        if (usedEdge[p2.a + ',' + p2.b]) continue;
        var canA2 = vis[p2.a] && !vis[p2.b];
        var canB2 = vis[p2.b] && !vis[p2.a];
        if (!canA2 && !canB2) continue;
        pick2 = canA2 ? { p: p2.a, k: p2.b, ov: p2.ov, cov: p2.cov } : { p: p2.b, k: p2.a, ov: p2.ov, cov: p2.cov };
        break;
      }
      if (!pick2) break;
      parentOf[pick2.k] = pick2.p;
      hingeOf[pick2.k] = pick2.ov;
      hingeCov[pick2.k] = pick2.cov;
      vis[pick2.k] = true;
      usedEdge[pick2.p + ',' + pick2.k] = 1;
    }
  }
  forestRoots.forEach(function (rk) { isForestRoot[rk] = true; });
  // Manual fold editor (S3): user-pinned hinges, applied AFTER the whole tree
  // (Dijkstra + rescues + island seeding) so every panel's final place in the
  // forest is known. A forced hinge re-parents its child; if the child was an
  // island root, the whole island is absorbed into the parent's tree.
  // Cycle-checked: following the parent chain from the new parent must never
  // reach the child, or the tree folds inside itself.
  function _ovWouldCycle(child, parent) {
    var c = parent, guard = 0;
    while (c != null && guard++ < 1000) {
      if (c === child) return true;
      c = parentOf[c];
    }
    return false;
  }
  _ovHinges.forEach(function (h) {
    if (h.child === root) return;                 // the main base stays put
    if (parentOf[h.child] === h.parent) return;   // already what the user asked for
    if (_ovWouldCycle(h.child, h.parent)) return; // a forced hinge must not close a loop
    if (isForestRoot[h.child]) {                  // absorb the child's island
      var fi3 = forestRoots.indexOf(h.child);
      if (fi3 >= 0) forestRoots.splice(fi3, 1);
      delete isForestRoot[h.child];
    }
    parentOf[h.child] = h.parent;
    hingeOf[h.child] = h.ov;
    hingeCov[h.child] = 1;
    delete staticHinge[h.child];                  // user's explicit hinge outranks the no-crease freeze
  });
  Preview3D._forestRoots = forestRoots;

  // Build scene-graph groups in BFS order. net->world flips Y so the flat net reads upright.
  var faceGroup = {};
  Preview3D._hinges = [];
  forestRoots.forEach(function (rk) {
    var rc2 = fr(rk);
    if (!rc2) return;
    faceGroup[rk] = new THREE.Group();
    faceGroup[rk].position.set(rc2.cx - bcx, -(rc2.cy - bcy), 0);
    boxGroup.add(faceGroup[rk]);
  });

  var order = [];
  (function bfsOrder() {
    var q = forestRoots.slice();
    order = order.concat(forestRoots);
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
  var vChain = {}, vDepth = {};
  forestRoots.forEach(function (rk) { vChain[rk] = true; vDepth[rk] = 0; });
  var rawStage = {};
  order.forEach(function(key) {
    if (isForestRoot[key]) return;
    var pk = parentOf[key], ov = hingeOf[key];
    if (!ov) return;
    vChain[key] = !!vChain[pk] && ov.orient === 'v';
    // Static hinges (no crease) don't increment vDepth — the child is physically
    // the same panel as the parent, so downstream panels see the correct depth.
    vDepth[key] = vChain[key] ? (vDepth[pk] + (staticHinge[key] ? 0 : 1)) : 0;
    if (vChain[key]) { rawStage[key] = 0; return; }   // wrap stage
    var hCount = 0, c = key;
    while (c && !isForestRoot[c]) {
      if (hingeOf[c] && hingeOf[c].orient === 'h') hCount++;
      c = parentOf[c];
    }
    rawStage[key] = Math.max(1, hCount);
  });
  // A child may never fold before its parent (physically impossible, looks broken).
  order.forEach(function(key) {
    var pk = parentOf[key];
    if (!pk || isForestRoot[pk]) return;
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
    if (isForestRoot[key]) return;
    var pk = parentOf[key];
    var cur = fr(key), pr = fr(pk), ov = hingeOf[key];
    if (!cur || !pr || !ov) return;
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
    // Manual fold editor: the user flipped this panel's fold direction.
    if (_ovFlip[key]) sign = -sign;
    // In a vertical chain (walls wrapping around the box), the first two panels
    // fold 90° to form the side wall and front wall. Panels at vDepth >= 3 are
    // inner liners / glue tabs that fold 180° BACK (behind their parent) to
    // create a double-wall construction. Without this, consecutive 90° folds
    // spiral into a tube and the front wall splits into perpendicular fragments.
    var foldMult = 1;
    if (staticHinge[key]) foldMult = 0;   // no crease → no fold, stay in parent's plane
    // The old "fold 180 deg at vDepth >= 3" rule assumed every vertical chain is
    // a series of walls; on deeper chains it sent panels straight through the
    // carton. Opt-in only (measured worse by default).
    else if (Preview3D._useMult2 && ov.orient === 'v' && vDepth[key] >= 3 && (vDepth[key] % 2 === 1)) foldMult = 2;
    // Safety valve: a genuine crease runs along the panel's own edge, so the
    // child's centre can never sit farther from the fold line than roughly half
    // its size. Anything beyond that is a mis-connection (a bridge or rescue pass
    // joining panels that are not really hinged). Keep the link — it is what
    // stops the box falling into islands — but do not rotate it: a wild swing
    // reads far worse than a panel that just rides along flat.
    var _diag = Math.hypot(cur.w, cur.h);
    // Opt-in only. This looked like a safe guard against mis-connected panels,
    // but it silently froze a lot of GOOD hinges too: median size error 11% -> 6%
    // and 12/22 -> 14/22 boxes within tolerance once it was switched off. The
    // geometric cases it was written for are rarer than the damage it did.
    if (Preview3D._useValve && _diag > 0 && Math.hypot(cLocal.x, cLocal.y) > _diag * 1.2) foldMult = 0;
    // Manual fold editor (S4): the user's explicit angle wins over every
    // heuristic above — including the static-hinge freeze and the safety valve.
    // foldMult multiplies the 90° base: 2 => 180°, 0 => stay flat.
    if (_ovAngles[key] != null) foldMult = _ovAngles[key];
    Preview3D._hinges.push({
      group: hingeG, axis: axis, sign: sign,
      foldMult: foldMult,
      stage: stageIdx[rawStage[key]] || 0,
      key: key, parent: pk, orient: ov.orient,   // diagnostics
      cov: hingeCov[key], len: ov.len
    });
    hingeG.setRotationFromAxisAngle(axis, 0);
  });

  // One mesh per face, parented to its hinge chain. Orphaned faces (not reached
  // by the fold tree) are still rendered at their net position so the user sees
  // every panel — they just won't fold animatedly.
  // Panels are rendered as semi-transparent so the user can see the box structure
  // (otherwise a fully-closed box hides every interior flap).
  Preview3D._faces = [];
  // Board thickness. Real folding cartons run 0.4–1 mm, so a razor-thin plane is
  // what made the preview look like cut-out plastic. Scale it with the net so it
  // stays visible on a 2000 mm shipping case without looking like foam on a
  // 60 mm perfume box.
  var netSpan = Math.max(maxX - minX, maxY - minY, 1);
  var BOARD_T = Math.max(0.5, Math.min(2.0, netSpan * 0.0035));
  Preview3D._boardThickness = BOARD_T;
  var _boardMap = _boardTexture();
  var _edgeMap = _edgeTexture();

  Object.keys(faceData).forEach(function(key) {
    var F = fr(key); if (!F) return;
    var isRoot = !!isForestRoot[key];
    // Opaque board. The old 0.30/0.72 translucency was meant to reveal interior
    // flaps but read as frosted plastic; the fold animation stops at 98% so the
    // carton never seals completely and the structure still shows.
    var opacity = (Preview3D.panelOpacity != null) ? Preview3D.panelOpacity : 1.0;
    var faceMat = new THREE.MeshStandardMaterial({
      color: 0xf2ede2,
      map: _boardMap,
      roughness: 0.82,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity: opacity,
      depthWrite: true
    });
    // Cut edges expose the corrugated core — a distinctly darker, warmer band
    // around every panel, which is the single strongest "this is cardboard" cue.
    var edgeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: _edgeMap,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity: opacity,
      depthWrite: true
    });
    var mat = faceMat;
    var matArr = [faceMat, edgeMat];

    // ---- True polygon geometry (Packmage-style) ----
    // Use the actual panel polygon extracted from the FE line network. This renders
    // trapezoidal / non-rectangular panels (dust flaps, tuck flaps) correctly and
    // removes the fragment artifacts caused by the old ray-cast clipping.
    var geo = null, outlinePts = null;
    var polyPts = planarPolys[key];
    // Fallback: clip the face rectangle to the actual die-cut boundary. This is
    // especially important for reconstructed boxes (T-series) where the planar
    // extraction can be fragmented or missing.
    if ((!polyPts || polyPts.length < 3) && typeof computePanelPolygon === 'function') {
      polyPts = computePanelPolygon(F.x1, F.y1, F.x2, F.y2);
    }
    if (polyPts && polyPts.length >= 3) {
      var shape = new THREE.Shape();
      shape.moveTo(polyPts[0][0] - F.cx, -(polyPts[0][1] - F.cy));
      for (var pi = 1; pi < polyPts.length; pi++) {
        shape.lineTo(polyPts[pi][0] - F.cx, -(polyPts[pi][1] - F.cy));
      }
      shape.closePath();
      // Extrude into a slab instead of a zero-thickness sheet: `groups[0]` is the
      // two printed faces, `groups[1]` the cut edge around the panel.
      geo = new THREE.ExtrudeGeometry(shape, { depth: BOARD_T, bevelEnabled: false, curveSegments: 1 });
      geo.translate(0, 0, -BOARD_T / 2);
      _remapSlabUVs(geo, F, BOARD_T);
      outlinePts = polyPts;
    }
    if (!geo) {
      geo = new THREE.BoxGeometry(F.w, F.h, BOARD_T);
      matArr = faceMat;
      _remapSlabUVs(geo, F, BOARD_T);
    }

    var mesh = new THREE.Mesh(geo, matArr);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Tag every panel mesh so the pick handler can identify the clicked panel.
    // Raycaster returns the Mesh; we walk up to the keyed group via .userData.
    mesh.userData = { kind: 'panel', key: key };
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
    // Outline: a crisp die-cut contour on BOTH faces of the slab. WebGL caps line
    // width at 1 px, so the extruded edge carries the visual weight and these
    // lines only sharpen the silhouette.
    var lineMat = new THREE.LineBasicMaterial({ color: 0x4a4038, transparent: true, opacity: 0.55 });
    if (outlinePts) {
      var front = [], back = [];
      for (var li = 0; li < outlinePts.length; li++) {
        var px = outlinePts[li][0] - F.cx, py = -(outlinePts[li][1] - F.cy);
        front.push(new THREE.Vector3(px, py, BOARD_T / 2 + 0.02));
        back.push(new THREE.Vector3(px, py, -BOARD_T / 2 - 0.02));
      }
      mesh.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(front), lineMat));
      mesh.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(back), lineMat));
    } else {
      var edges = new THREE.EdgesGeometry(geo);
      mesh.add(new THREE.LineSegments(edges, lineMat));
    }
    assignTexture(mat, key, F, svgInfo);
    // Stash the two materials so the display-mode / paper-colour switcher can
    // recolor every face live without rebuilding the scene.
    Preview3D._faces.push({ key: key, mesh: mesh, faceMat: faceMat, edgeMat: edgeMat });
  });
  console.log('[3D-DEBUG] Total meshes created:', Preview3D._faces.length,
    'faces:', Preview3D._faces.map(function(f){return f.key;}).join(','));

  // Apply current fold state (foldProgress = 0 -> flat net / 展开图)
  Preview3D._applyFold();

  // ---- View controls ----
  // Camera orbits the carton on a sphere (packmage-style). rotY = azimuth around
  // Y, rotX = elevation from the horizon. No arbitrary cap on elevation, so the
  // user can look straight down (top) or straight up (bottom) — the old code
  // clamped rotX to ±1.4 rad which made the 顶部/底部 presets impossible.
  // Starting 3/4 isometric: front + right + slightly down, the classic readable
  // preview that shows the front panel AND the folded-in side walls.
  var rotY = 0.61;                 // azimuth, radians  (~35°, showing front+right)
  var rotX = 0.35;                 // elevation, radians (~20° above horizon)
  var HOME_ROTX = 0.35, HOME_ROTY = 0.61;   // reset view = initial view
  var netW = maxX - minX, netH = maxY - minY;
  var zoom = 1.0;
  // How far the camera sits from the origin at zoom=1 (recomputed on each frame
  // by camDistFor below, which interpolates between the flat and folded fits).
  var _sphere = new THREE.Spherical();

  // Camera framing: measure how far back the camera has to sit to frame the
  // carton at both ends of the animation, then interpolate. Framing only on the
  // flat net (the old behaviour) left the folded box at ~8% of the viewport.
  // The camera now orbits on a sphere and can face any direction (front/top/…),
  // so the safe framing distance is the model's bounding-sphere radius — a
  // front-on view of a tall box needs more room than the flat net's width.
  var fitFlat = Math.max(netW, netH) * 1.2, fitFolded = fitFlat;
  (function measureFit() {
    var vFov = camera.fov * Math.PI / 180;
    var tan = Math.tan(vFov / 2);
    [0, 1].forEach(function (g) {
      Preview3D.foldProgress = g;
      Preview3D._applyFold();
      var bb = new THREE.Box3().setFromObject(boxGroup);
      if (!isFinite(bb.min.x)) return;
      var s = bb.getSize(new THREE.Vector3());
      var c = bb.getCenter(new THREE.Vector3());
      // Bounding-sphere radius from the model centre, safe for ANY camera angle.
      var rad = s.length() / 2 + c.length();
      var d = (rad / tan) * 1.15;
      if (g === 0) { fitFlat = d; Preview3D._fit0 = [Math.round(s.x), Math.round(s.y), Math.round(s.z)]; }
      else { fitFolded = d; Preview3D._fit1 = [Math.round(s.x), Math.round(s.y), Math.round(s.z)]; }
    });
    Preview3D.foldProgress = 0;
    Preview3D._applyFold();
  })();

  function camDistFor() {
    var t = Preview3D.foldProgress || 0;
    return (fitFlat + (fitFolded - fitFlat) * t);
  }
  function updateView() {
    // viewGroup still carries the FOLD state (net <-> box) in boxGroup; it is
    // never rotated here. The camera orbits the whole boxGroup on a sphere.
    // THREE.Spherical phi=0 is the +Y pole (top); we drive rotX as an ELEVATION
    // (0 = horizon, +90° = top), so convert: phi = PI/2 - rotX.
    var r = camDistFor() / zoom;
    _sphere.set(r, Math.PI / 2 - rotX, rotY);
    camera.position.setFromSpherical(_sphere);
    // Look at the box's current centre (not the net origin) so the front/top/
    // side presets frame the carton wherever the fold has moved it to.
    var target = _foldCenter();
    camera.lookAt(target);
    _lookTarget.copy(target);
  }
  Preview3D._updateCameraFit = updateView;
  var _lookTarget = new THREE.Vector3();
  var _bb = new THREE.Box3();
  function _foldCenter() {
    _bb.setFromObject(boxGroup);
    if (!isFinite(_bb.min.x)) return new THREE.Vector3(0, 0, 0);
    return _bb.getCenter(new THREE.Vector3());
  }
  Preview3D._viewCenter = function() { return _foldCenter().toArray(); };
  // packmage-style view presets: a named camera pose on the orbit sphere.
  // rotX/rotY are ELEVATION (radians, + = look up) / AZIMUTH (radians).
  // "展开"/"顶部" look straight down; "底部" straight up.
  Preview3D._viewPresets = {
    unfold:   { ry: 0,           rx: Math.PI / 2 - 0.18 }, // 展开 - near-top down on the net
    front:    { ry: 0,           rx: 0 },                   // 正面 - look along -Z
    left:     { ry: -Math.PI / 2, rx: 0 },                  // 左面
    back:     { ry: Math.PI,     rx: 0 },                   // 背面
    right:    { ry: Math.PI / 2, rx: 0 },                   // 右面
    top:      { ry: 0,           rx: Math.PI / 2 - 0.05 },  // 顶部 - straight down
    bottom:   { ry: 0,           rx: -Math.PI / 2 + 0.05 }, // 底部 - straight up
    iso:      { ry: HOME_ROTY,   rx: HOME_ROTX }            // 默认3/4视角
  };
  Preview3D._currentPreset = 'iso';
  Preview3D.setViewPreset = function(name) {
    var p = Preview3D._viewPresets[name];
    if (!p) return;
    rotY = p.ry; rotX = p.rx;
    Preview3D._currentPreset = name;
    updateView();
    var ryS = document.getElementById('rotateY'), rxS = document.getElementById('rotateX');
    if (ryS) ryS.value = Math.round(rotY * 180 / Math.PI);
    if (rxS) rxS.value = Math.round(rotX * 180 / Math.PI);
    Preview3D._presetChanged && Preview3D._presetChanged(name);
  };
  updateView();

  // Drop the shadow floor just under the carton's lowest point, measured in BOTH
  // the flat and the folded state so the contact shadow never detaches while the
  // fold slider animates. A fixed height left the box hovering in mid-air.
  (function placeGround() {
    if (!Preview3D._ground) return;
    var lowest = Infinity;
    [0, 1].forEach(function (g) {
      Preview3D.foldProgress = g;
      Preview3D._applyFold();
      var bb = new THREE.Box3().setFromObject(viewGroup);
      if (isFinite(bb.min.y) && bb.min.y < lowest) lowest = bb.min.y;
    });
    Preview3D.foldProgress = 0;
    Preview3D._applyFold();
    if (!isFinite(lowest)) return;
    var pad = Math.max(2, (maxY - minY) * 0.02);
    Preview3D._ground.position.y = lowest - pad;
    // Keep the shadow frustum tight around the carton, otherwise the 1024² map
    // is spread over an empty plane and the shadow dissolves into banding.
    var kb = key.shadow.camera;
    var half = Math.max(L, D, W, maxY - minY) * 1.1;
    kb.left = -half; kb.right = half; kb.top = half; kb.bottom = -half;
    kb.far = half * 10;
    kb.updateProjectionMatrix();
  })();

  // Expose view controls for the floating toolbar (reset view + zoom buttons)
  Preview3D._viewReset = function() {
    Preview3D.setViewPreset('iso');
  };
  Preview3D._viewZoom = function(f) {
    zoom = Math.max(0.3, Math.min(5.0, zoom * f)); updateView();
  };

  var canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  var isDragging = false, lastX = 0, lastY = 0;
  // Drag distance (sum of pixel deltas since mousedown) — used to tell a real
  // click from a drag. A user who only moves the mouse a couple of pixels
  // between mousedown and mouseup is selecting, not orbiting the view.
  var _dragDist = 0;
  // Inertia: velocity (rad/frame) carried after release, decayed each frame in
  // animate(). A flick on the box keeps it spinning instead of stopping dead.
  var velY = 0, velX = 0, lastT = 0;
  var mouseDownBtn = 0;
  var downX = 0, downY = 0;
  // Raycaster used to turn a short click into a panel selection. Built once
  // per render; raycasting is cheap so we don't bother pooling hits.
  var _raycaster = new THREE.Raycaster();
  var _ndc = new THREE.Vector2();
  function pickAt(cx, cy) {
    var rect = canvas.getBoundingClientRect();
    _ndc.x = ((cx - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((cy - rect.top) / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_ndc, camera);
    // boxGroup contains every face mesh (via the fold tree groups). Raycast
    // recursively so children of hinge groups are still hit.
    var hits = _raycaster.intersectObject(boxGroup, true);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i].object;
      if (h && h.userData && h.userData.kind === 'panel') return h.userData.key;
    }
    return null;
  }
  canvas.addEventListener('mousedown', function(e) {
    // Left button rotates; middle/right pan would conflict with nothing here, so
    // accept only the primary button for a clean rotate gesture.
    mouseDownBtn = e.button;
    if (e.button !== 0) return;
    isDragging = true; velY = 0; velX = 0; _dragDist = 0;
    lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
    downX = e.clientX; downY = e.clientY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  var mm = function(e) {
    if (!isDragging) return;
    _dragDist += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    var now = performance.now();
    var dt = Math.max(1, now - lastT);
    var dx = (e.clientX - lastX) * 0.008;
    var dy = (e.clientY - lastY) * 0.008;
    rotY += dx;
    rotX += dy;
    rotX = Math.max(-1.55, Math.min(1.55, rotX));
    Preview3D._currentPreset = null;   // manual drag leaves any view preset
    // Velocity for inertia: rad per 16.7 ms frame, EMA-smoothed over the move.
    velY = velY * 0.6 + (dx / (dt / 16.7)) * 0.4;
    velX = velX * 0.6 + (dy / (dt / 16.7)) * 0.4;
    lastX = e.clientX; lastY = e.clientY; lastT = now;
    var ryS = document.getElementById('rotateY'), rxS = document.getElementById('rotateX');
    if (ryS) ryS.value = (rotY * 180 / Math.PI).toFixed(0);
    if (rxS) rxS.value = (rotX * 180 / Math.PI).toFixed(0);
    updateView();
  };
  var mu = function(e) {
    var wasDragging = isDragging;
    isDragging = false; canvas.style.cursor = 'grab';
    if (!wasDragging) return;
    // A real click: button 0, barely moved between down and up. Anything past
    // 5 px of cumulative motion was a drag, so we leave the rotation alone and
    // don't fire a selection.
    if (mouseDownBtn !== 0) return;
    if (_dragDist > 5) return;
    var key = pickAt(downX, downY);
    if (key && typeof Preview3D.onPanelClick === 'function') {
      Preview3D.onPanelClick(key);
    }
  };
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
      rotX = Math.max(-1.55, Math.min(1.55, rotX));
      Preview3D._currentPreset = null;
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
    // Inertia decay: while the mouse is up, bleed off the residual spin velocity
    // so a flick glides to a stop instead of snapping. Damped so it reads smooth.
    if (!isDragging && (Math.abs(velX) > 1e-5 || Math.abs(velY) > 1e-5)) {
      rotY += velY;
      rotX += velX;
      rotX = Math.max(-1.55, Math.min(1.55, rotX));
      Preview3D._currentPreset = null;
      velY *= 0.94; velX *= 0.94;
      var ryS = document.getElementById('rotateY'), rxS = document.getElementById('rotateX');
      if (ryS) ryS.value = (rotY * 180 / Math.PI).toFixed(0);
      if (rxS) rxS.value = (rotX * 180 / Math.PI).toFixed(0);
      updateView();
    }
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

  // ---- Selection highlight + hover cursor ----
  // The picker (mousedown/up) tells the app which panel was clicked; the app
  // calls Preview3D.setSelected(key) to colour the chosen panel. Hover just
  // changes the cursor so the user knows the surface is clickable.
  var _highlightKey = null;
  Preview3D.setSelected = function(key) {
    _highlightKey = key || null;
    Preview3D._faces.forEach(function(f) {
      if (!f || !f.mesh) return;
      var mats = Array.isArray(f.mesh.material) ? f.mesh.material : [f.mesh.material];
      mats.forEach(function(m) {
        if (!m || !m.emissive) return;
        if (f.key === _highlightKey) {
          m.emissive.setHex(0x2a7fff);
          m.emissiveIntensity = 0.55;
        } else {
          m.emissive.setHex(0x000000);
          m.emissiveIntensity = 0;
        }
      });
    });
  };
  canvas.addEventListener('mousemove', function(e) {
    // Skip the cursor swap while the user is rotating the view — the hand
    // already shows the box is grabbable, and a pointer icon would flicker.
    if (isDragging) return;
    var k = pickAt(e.clientX, e.clientY);
    canvas.style.cursor = k ? 'pointer' : 'grab';
  });
  canvas.addEventListener('mouseleave', function() { canvas.style.cursor = 'grab'; });

  /* ===== Display mode / paper colour / grain (packmage-style 白样/彩样/骨架线) =====
   * Live switches — recolor every face material without rebuilding the scene.
   * mode: 'color' (彩样, textures on) | 'white' (白样, plain board) | 'wire' (骨架线).
   * Re-applies current paper colour + grain on every call, so toggling any of
   * the three knobs re-syncs all faces.
   */
  Preview3D._displayMode = Preview3D._displayMode || 'color';
  Preview3D._paperColor = Preview3D._paperColor || 0xf2ede2;   // default warm board
  Preview3D._paperGrain = Preview3D._paperGrain !== false;     // default: grain on
  function _applyPaper() {
    var mode = Preview3D._displayMode;
    var useGrain = Preview3D._paperGrain && mode !== 'white' && mode !== 'wire';
    var col = new THREE.Color(Preview3D._paperColor);
    var art = Preview3D._artFaces || {};
    Preview3D._faces.forEach(function(f) {
      if (!f.faceMat) return;
      // 白样 / 骨架线 drop the texture (clean board or pure wire); 彩样 keeps it.
      // A face carrying user artwork keeps its art canvas on in 彩样 mode.
      var keepArt = (mode === 'color') && !!art[f.key];
      f.faceMat.map = (keepArt) ? f.faceMat.map
                   : ((mode === 'color' && useGrain) ? _boardMap : null);
      f.faceMat.color.set(col);
      f.faceMat.roughness = (mode === 'wire') ? 1 : 0.82;
      f.faceMat.wireframe = (mode === 'wire');
      f.faceMat.needsUpdate = true;
      // Edge slab: keep the corrugated cut edge in 彩样, plain tint in 白样/骨架线.
      if (f.edgeMat) {
        f.edgeMat.map = (mode === 'color' && useGrain) ? _edgeMap : null;
        var ecol = new THREE.Color(0xcfa872).lerp(col, mode === 'color' ? 0 : 0.5);
        f.edgeMat.color.set(ecol);
        f.edgeMat.wireframe = (mode === 'wire');
        f.edgeMat.needsUpdate = true;
      }
    });
  }
  Preview3D.setDisplayMode = function(mode) {
    if (['color', 'white', 'wire'].indexOf(mode) < 0) return;
    Preview3D._displayMode = mode;
    _applyPaper();
  };
  Preview3D.setPaperColor = function(hex) {
    Preview3D._paperColor = hex;
    _applyPaper();
  };
  Preview3D.setPaperGrain = function(on) {
    Preview3D._paperGrain = !!on;
    _applyPaper();
  };

  /* ===== Light / background (packmage Light adjust + 背景色) ===== */
  Preview3D.setBackgroundColor = function(hex) {
    if (hex === 'default') { scene.background = _backdropTexture(); }
    else { scene.background = new THREE.Color(hex); }
  };
  Preview3D._lightIntensity = Preview3D._lightIntensity || 1.0;
  Preview3D.setLightIntensity = function(v) {
    Preview3D._lightIntensity = Math.max(0.2, Math.min(3.0, v));
    key.intensity = 0.85 * Preview3D._lightIntensity;
    fill.intensity = 0.32 * Preview3D._lightIntensity;
    rim.intensity = 0.28 * Preview3D._lightIntensity;
  };
  // Apply persisted display state (if any) on each (re)build.
  _applyPaper();
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
