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
  // SEQUENCED fold — a real carton assembles layer by layer, not all at once:
  //   depth 1 (four walls) rise first, then depth 2 flaps close, then the lid
  //   (deeper flaps) last. We split [0,1] into one time-slot per BFS depth so
  //   shallow hinges finish before deep ones start; a small overlap keeps the
  //   motion continuous. Because faces are nested in the scene graph, a flap
  //   still rides its parent wall while waiting for its own slot (never floats).
  var maxD = Preview3D._maxDepth || 1;
  var slot = 1 / maxD;
  var overlap = slot * 0.35;          // deeper stage starts a bit early -> smooth
  Preview3D._hinges.forEach(function(h) {
    var d = h.depth || 1;
    var start = (d - 1) * slot - overlap; if (start < 0) start = 0;
    var end = d * slot;                // each depth finishes exactly at d*slot
    var dur = end - start; if (dur < 1e-6) dur = slot;
    var t = (g - start) / dur;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    t = t * t * (3 - 2 * t);           // smoothstep easing
    h.group.setRotationFromAxisAngle(h.axis, h.sign * Math.PI / 2 * t);
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

  if (faceData) {
    if (typeof THREE !== 'undefined') {
      Preview3D._buildThree(container, boxType, params, faceData);
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
      }
      if (fd && typeof THREE !== 'undefined') {
        Preview3D._buildThree(container, boxType, params, fd);
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
  if (a.orient === 'h') {
    if (Math.abs(a.y1 - b.y1) > 1) return null;
    var lo = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
    var hi = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
    if (hi - lo < 5) return null;
    return { x1: lo, y1: a.y1, x2: hi, y2: a.y1, orient: 'h', cx: (lo + hi) / 2, cy: a.y1,
             dir: { x: hi > lo ? 1 : -1, y: 0 }, len: hi - lo };
  } else {
    if (Math.abs(a.x1 - b.x1) > 1) return null;
    var lo2 = Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
    var hi2 = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
    if (hi2 - lo2 < 5) return null;
    return { x1: a.x1, y1: lo2, x2: a.x1, y2: hi2, orient: 'v', cx: a.x1, cy: (lo2 + hi2) / 2,
             dir: { x: 0, y: hi2 > lo2 ? 1 : -1 }, len: hi2 - lo2 };
  }
}

/* ===== Build the full Three.js scene ===== */
Preview3D._buildThree = function(container, boxType, params, faceData) {
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
  if (!M.M0) { Preview3D._renderSimple(container, boxType, params); return; }

  var L = M.M0.w, D = M.M0.h;
  var W = M.M1 ? M.M1.w : (M.M3 ? M.M3.w : 100);

  // ---- Three.js setup ----
  var containerW = container.clientWidth || 800;
  var containerH = 560;
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f0);
  var camera = new THREE.PerspectiveCamera(40, containerW / containerH, 1, 5000);
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(containerW, containerH);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  container._threeRenderer = renderer;

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

  // BFS parent tree + hinge edges (shared crease with length > 8) from largest face.
  var areaOf = {};
  Object.keys(faceData).forEach(function(k) { var r = fr(k); areaOf[k] = Math.abs((r.x2 - r.x1) * (r.y2 - r.y1)); });
  var root = Object.keys(faceData).slice().sort(function(a, b) { return areaOf[b] - areaOf[a]; })[0];
  var parentOf = {}, hingeOf = {}, vis = {}; vis[root] = true; var qq = [root];
  while (qq.length) {
    var cur = qq.shift();
    Object.keys(faceData).forEach(function(k) {
      if (vis[k] || !fr(k)) return;
      var fe = rectEdges(fr(cur)), fk = rectEdges(fr(k)), ov = null, bestLen = -1;
      for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
        var o = edgesOverlap(fe[i], fk[j]);
        if (o && o.len > bestLen) { bestLen = o.len; ov = o; }
      }
      if (ov && ov.len > 8) { parentOf[k] = cur; hingeOf[k] = ov; vis[k] = true; qq.push(k); }
    });
  }

  // Build scene-graph groups in BFS order. net->world flips Y so the flat net reads upright.
  var faceGroup = {};
  Preview3D._hinges = [];
  // BFS depth per face: root = 0, walls = 1, their flaps = 2, lid = 3 ...
  // Drives the SEQUENCED fold order in _applyFold (shallow folds first).
  var depthOf = {}; depthOf[root] = 0;
  var maxDepth = 1;
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

  order.forEach(function(key) {
    if (key === root) return;
    var pk = parentOf[key];
    var depth = (depthOf[pk] || 0) + 1; depthOf[key] = depth;
    if (depth > maxDepth) maxDepth = depth;
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
    // Probe sign: with ancestors fully folded, pick the hinge angle that lifts the
    // child highest (global +z) -> walls rise, lid closes outward, no inversion.
    Preview3D._hinges.forEach(function(h) { h.group.setRotationFromAxisAngle(h.axis, h.sign * Math.PI / 2); });
    scene.updateMatrixWorld(true);
    var wp = new THREE.Vector3();
    hingeG.setRotationFromAxisAngle(axis, Math.PI / 2); scene.updateMatrixWorld(true);
    var zP = fg.getWorldPosition(wp.clone()).z;
    hingeG.setRotationFromAxisAngle(axis, -Math.PI / 2); scene.updateMatrixWorld(true);
    var zM = fg.getWorldPosition(wp.clone()).z;
    var sign = zP >= zM ? 1 : -1;
    Preview3D._hinges.push({ group: hingeG, axis: axis, sign: sign, depth: depth });
    hingeG.setRotationFromAxisAngle(axis, 0);
  });
  Preview3D._maxDepth = maxDepth;   // number of fold stages (drives sequencing)

  // One mesh per face, parented to its hinge chain.
  Preview3D._faces = [];
  Object.keys(faceData).forEach(function(key) {
    var F = fr(key); if (!F || !faceGroup[key]) return;
    var geo = new THREE.PlaneGeometry(F.w, F.h);
    var mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    var mesh = new THREE.Mesh(geo, mat);
    faceGroup[key].add(mesh);
    assignTexture(mat, key, F, svgInfo);
    Preview3D._faces.push({ key: key });
  });

  // Apply current fold state (foldProgress = 0 -> flat net / 展开图)
  Preview3D._applyFold();

  // ---- View controls ----
  var rotY = -0.5, rotX = -0.35;
  var netW = maxX - minX, netH = maxY - minY;
  var camDist = Math.max(netW, netH, L, W, D) * 1.35;
  var zoom = 1.0;
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
    rotX = -0.35; rotY = -0.5; zoom = 1.0; updateView();
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
    zoom *= e.deltaY > 0 ? 1.12 : 0.89;
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
    if (Math.abs(nw - containerW) > 10) {
      containerW = nw; camera.aspect = containerW / containerH; camera.updateProjectionMatrix();
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
