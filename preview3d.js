/*
 * preview3d.js — 3D Paper Box Preview (Three.js WebGL)
 * Uses packmage Face data to render a proper folded 3D box with die-cut textures.
 * Approach mirrors packmage.com: Three.js WebGL + mouse rotation/zoom controls.
 * Falls back to simple CSS 3D if Three.js is unavailable.
 */

var Preview3D = {};

/* ===== Entry point ===== */
Preview3D.render = function(container, boxType, params) {
  // Clean up previous instance
  Preview3D._cleanup(container);

  // Get Face data
  var faceData = null;
  if (boxType.currentBoxData && boxType.currentBoxData.de && boxType.currentBoxData.de.face) {
    try {
      faceData = typeof boxType.currentBoxData.de.face === 'string'
        ? JSON.parse(boxType.currentBoxData.de.face)
        : boxType.currentBoxData.de.face;
    } catch(e) {}
  }
  if (!faceData && boxType.packmageData && boxType.packmageData.de && boxType.packmageData.de.face) {
    try {
      faceData = typeof boxType.packmageData.de.face === 'string'
        ? JSON.parse(boxType.packmageData.de.face)
        : boxType.packmageData.de.face;
    } catch(e) {}
  }

  if (faceData) {
    if (typeof THREE !== 'undefined') {
      Preview3D._renderThree(container, boxType, params, faceData);
    } else {
      Preview3D._renderSimple(container, boxType, params);
    }
  } else {
    Preview3D._fetchAndRender(container, boxType, params);
  }
};

Preview3D._cleanup = function(container) {
  if (container._animId) {
    cancelAnimationFrame(container._animId);
    container._animId = null;
  }
  if (container._threeRenderer) {
    container._threeRenderer.dispose();
    container._threeRenderer = null;
  }
  // Remove event listeners
  if (container._mouseMoveHandler) {
    window.removeEventListener('mousemove', container._mouseMoveHandler);
    window.removeEventListener('mouseup', container._mouseUpHandler);
    container._mouseMoveHandler = null;
    container._mouseUpHandler = null;
  }
  container.innerHTML = '';
};

/* ===== Fetch Face data from API ===== */
Preview3D._fetchAndRender = function(container, boxType, params) {
  container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:400px;color:#888;font-size:14px;">Loading 3D data...</div>';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/box', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    try {
      var resp = JSON.parse(xhr.responseText);
      if (resp.success && resp.box && resp.box.de && resp.box.de.face) {
        var faceData = typeof resp.box.de.face === 'string'
          ? JSON.parse(resp.box.de.face)
          : resp.box.de.face;
        if (boxType.currentBoxData) {
          boxType.currentBoxData.de.face = resp.box.de.face;
        }
        if (typeof THREE !== 'undefined') {
          Preview3D._renderThree(container, boxType, params, faceData);
        } else {
          Preview3D._renderSimple(container, boxType, params);
        }
      } else {
        Preview3D._renderSimple(container, boxType, params);
      }
    } catch(e) {
      Preview3D._renderSimple(container, boxType, params);
    }
  };
  xhr.send(JSON.stringify({ boxID: boxType.id, inPms: '' }));
};

/* ===== Generate SVG data URI from die-cut geometry ===== */
Preview3D._generateSVGDataURI = function(boxType) {
  var boxData = boxType.currentBoxData || boxType.packmageData;
  if (!boxData || !boxData.fe) return null;

  var fe = boxData.fe;

  if (typeof PackmageBoxTypes !== 'undefined' && PackmageBoxTypes.convertGeometry) {
    var data = PackmageBoxTypes.convertGeometry(fe, boxData.de.ox, boxData.de.oy);
    var bb = data.bbox;
    var w = bb.maxX - bb.minX;
    var h = bb.maxY - bb.minY;
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
      width: w + pad * 2,
      height: h + pad * 2,
      minX: bb.minX - pad,
      minY: bb.minY - pad
    };
  }
  return null;
};

/* ===== Three.js WebGL renderer ===== */
Preview3D._renderThree = function(container, boxType, params, faceData) {
  var boxData = boxType.currentBoxData || boxType.packmageData;
  var svgInfo = Preview3D._generateSVGDataURI(boxType);

  // Parse face rectangles
  function fr(name) {
    var r = faceData[name];
    if (!r) return null;
    return { x1: r[0], y1: r[1], x2: r[2], y2: r[3], w: r[2]-r[0], h: r[3]-r[1] };
  }

  var M0 = fr('M0'), M1 = fr('M1'), M2 = fr('M2'), M3 = fr('M3'), M4 = fr('M4'), M5 = fr('M5');
  if (!M0) { Preview3D._renderSimple(container, boxType, params); return; }

  var L = M0.w;  // Length (X axis)
  var D = M0.h;  // Depth/Height (Y axis, up in Three.js)
  var W = M1 ? M1.w : (M3 ? M3.w : 100);  // Width (Z axis)

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

  // ---- Lighting ----
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  var dl1 = new THREE.DirectionalLight(0xffffff, 0.35);
  dl1.position.set(L, D, W);
  scene.add(dl1);
  var dl2 = new THREE.DirectionalLight(0xffffff, 0.15);
  dl2.position.set(-L, -D/2, -W);
  scene.add(dl2);

  // ---- Box group (all faces are children) ----
  var boxGroup = new THREE.Group();
  scene.add(boxGroup);

  // Store materials for texture update
  var faceMaterials = [];

  /* Helper: create a main face mesh
   * Three.js coords: X=right, Y=up, Z=toward viewer
   * Box: width=L (X), height=D (Y), depth=W (Z)
   */
  function createFace(name, rect, w, h, pos, rot) {
    var geo = new THREE.PlaneGeometry(w, h);
    var mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.set(rot[0], rot[1], rot[2]);
    boxGroup.add(mesh);
    faceMaterials.push({ name: name, mat: mat, rect: rect });
    return mesh;
  }

  /* Helper: create a flap (folded 90 degrees from parent face edge)
   * Uses a pivot group at the parent's edge, with the flap mesh offset outward.
   * The pivot's rotation folds the flap inward.
   */
  function createFlap(name, rect, parentPos, parentRot, parentW, parentH, edge) {
    var fw = rect.w, fh = rect.h;
    var geo = new THREE.PlaneGeometry(fw, fh);
    var mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9
    });
    var mesh = new THREE.Mesh(geo, mat);

    var pivot = new THREE.Group();

    if (edge === 'top') {
      pivot.position.set(0, parentH / 2, 0);
      mesh.position.y = fh / 2;
      pivot.rotation.x = -Math.PI / 2;  // fold downward (inward)
    } else if (edge === 'bottom') {
      pivot.position.set(0, -parentH / 2, 0);
      mesh.position.y = -fh / 2;
      pivot.rotation.x = Math.PI / 2;   // fold upward (inward)
    } else if (edge === 'right') {
      pivot.position.set(parentW / 2, 0, 0);
      mesh.position.x = fw / 2;
      pivot.rotation.y = -Math.PI / 2;  // fold leftward (inward)
    } else if (edge === 'left') {
      pivot.position.set(-parentW / 2, 0, 0);
      mesh.position.x = -fw / 2;
      pivot.rotation.y = Math.PI / 2;   // fold rightward (inward)
    }

    pivot.add(mesh);

    // Wrap in parent group to apply parent face's position & rotation
    var parentGroup = new THREE.Group();
    parentGroup.position.set(parentPos[0], parentPos[1], parentPos[2]);
    parentGroup.rotation.set(parentRot[0], parentRot[1], parentRot[2]);
    parentGroup.add(pivot);
    boxGroup.add(parentGroup);

    faceMaterials.push({ name: name, mat: mat, rect: rect });
    return mesh;
  }

  // ---- Create 6 main faces ----
  // Front (M0): faces +Z
  createFace('M0', M0, L, D, [0, 0, W/2], [0, 0, 0]);
  // Back (M5): faces -Z, rotated 180 around Y
  if (M5) createFace('M5', M5, L, D, [0, 0, -W/2], [0, Math.PI, 0]);
  // Right (M3): faces +X, rotated 90 around Y
  if (M3) createFace('M3', M3, W, D, [L/2, 0, 0], [0, Math.PI/2, 0]);
  // Left (M1): faces -X, rotated -90 around Y
  if (M1) createFace('M1', M1, W, D, [-L/2, 0, 0], [0, -Math.PI/2, 0]);
  // Top (M2): faces +Y, rotated -90 around X
  if (M2) createFace('M2', M2, L, W, [0, D/2, 0], [-Math.PI/2, 0, 0]);
  // Bottom (M4): faces -Y, rotated 90 around X
  if (M4) createFace('M4', M4, L, W, [0, -D/2, 0], [Math.PI/2, 0, 0]);

  // ---- Create flaps ----
  // Back face flaps (M5 has 180-degree Y rotation, so flat-left becomes local-right)
  var m6 = fr('M6');
  if (m6 && M5) createFlap('M6', m6, [0, 0, -W/2], [0, Math.PI, 0], L, D, 'top');
  var m7 = fr('M7');
  if (m7 && M5) createFlap('M7', m7, [0, 0, -W/2], [0, Math.PI, 0], L, D, 'bottom');
  // S5 glue tab: to the left of M5 in flat pattern -> right in local space after 180 rotation
  var s5 = fr('S5');
  if (s5 && M5) {
    // Check if S5 is to the left or right of M5 in the flat pattern
    var s5IsLeft = Math.abs(s5.x2 - M5.x1) < 5;
    var s5Edge = s5IsLeft ? 'right' : 'left';  // flip because of 180-degree rotation
    createFlap('S5', s5, [0, 0, -W/2], [0, Math.PI, 0], L, D, s5Edge);
  }

  // Left face flaps (M1)
  var s1t = fr('S1T');
  if (s1t && M1) createFlap('S1T', s1t, [-L/2, 0, 0], [0, -Math.PI/2, 0], W, D, 'top');
  var s1b = fr('S1B');
  if (s1b && M1) createFlap('S1B', s1b, [-L/2, 0, 0], [0, -Math.PI/2, 0], W, D, 'bottom');

  // Right face flaps (M3)
  var s3t = fr('S3T');
  if (s3t && M3) createFlap('S3T', s3t, [L/2, 0, 0], [0, Math.PI/2, 0], W, D, 'top');
  var s3b = fr('S3B');
  if (s3b && M3) createFlap('S3B', s3b, [L/2, 0, 0], [0, Math.PI/2, 0], W, D, 'bottom');

  // ---- Load SVG texture and apply to each face ----
  if (svgInfo) {
    var svgImg = new Image();
    svgImg.onload = function() {
      faceMaterials.forEach(function(fm) {
        var rect = fm.rect;
        var ts = 2; // texture resolution multiplier
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(rect.w * ts));
        canvas.height = Math.max(1, Math.round(rect.h * ts));
        var ctx = canvas.getContext('2d');

        // Fill background
        ctx.fillStyle = '#fff8f0';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw the face's portion of the SVG
        var sx = rect.x1 - svgInfo.minX;
        var sy = rect.y1 - svgInfo.minY;
        try {
          ctx.drawImage(svgImg,
            sx, sy, rect.w, rect.h,
            0, 0, canvas.width, canvas.height
          );
        } catch(e) {}

        var texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        fm.mat.map = texture;
        fm.mat.needsUpdate = true;
      });
    };
    svgImg.src = svgInfo.uri;
  }

  // ---- Add edge lines for visual definition ----
  var edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(L, D, W));
  var edgeMat = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.3 });
  var edges = new THREE.LineSegments(edgeGeo, edgeMat);
  boxGroup.add(edges);

  // ---- Mouse controls: drag to rotate, wheel to zoom ----
  var rotY = -0.4, rotX = -0.25;
  var camDist = Math.max(L, W, D) * 2.5;
  var zoom = 1.0;

  function updateView() {
    boxGroup.rotation.x = rotX;
    boxGroup.rotation.y = rotY;
    camera.position.set(0, 0, camDist / zoom);
    camera.lookAt(0, 0, 0);
  }
  updateView();

  // Mouse drag rotation
  var isDragging = false;
  var lastX = 0, lastY = 0;
  var canvas = renderer.domElement;
  canvas.style.cursor = 'grab';

  canvas.addEventListener('mousedown', function(e) {
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });

  var mouseMoveHandler = function(e) {
    if (!isDragging) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    rotY += dx * 0.008;
    rotX += dy * 0.008;
    rotX = Math.max(-1.4, Math.min(1.4, rotX));
    lastX = e.clientX;
    lastY = e.clientY;
    // Sync sliders
    var rySlider = document.getElementById('rotateY');
    var rxSlider = document.getElementById('rotateX');
    if (rySlider) rySlider.value = (rotY * 180 / Math.PI).toFixed(0);
    if (rxSlider) rxSlider.value = (rotX * 180 / Math.PI).toFixed(0);
    updateView();
  };
  container._mouseMoveHandler = mouseMoveHandler;

  var mouseUpHandler = function() {
    isDragging = false;
    canvas.style.cursor = 'grab';
  };
  container._mouseUpHandler = mouseUpHandler;

  window.addEventListener('mousemove', mouseMoveHandler);
  window.addEventListener('mouseup', mouseUpHandler);

  // Mouse wheel zoom
  canvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? 1.12 : 0.89;
    zoom *= delta;
    zoom = Math.max(0.3, Math.min(5.0, zoom));
    updateView();
  }, { passive: false });

  // Touch support (basic)
  var touchStartX = 0, touchStartY = 0, touchDist = 0;
  canvas.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      isDragging = true;
    } else if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDist = Math.sqrt(dx*dx + dy*dy);
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1 && isDragging) {
      var dx = e.touches[0].clientX - touchStartX;
      var dy = e.touches[0].clientY - touchStartY;
      rotY += dx * 0.008;
      rotX += dy * 0.008;
      rotX = Math.max(-1.4, Math.min(1.4, rotX));
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      updateView();
    } else if (e.touches.length === 2) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var newDist = Math.sqrt(dx*dx + dy*dy);
      if (touchDist > 0) {
        zoom *= newDist / touchDist;
        zoom = Math.max(0.3, Math.min(5.0, zoom));
        updateView();
      }
      touchDist = newDist;
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', function() {
    isDragging = false;
    touchDist = 0;
  });

  // Wire up sliders
  var rySlider = document.getElementById('rotateY');
  var rxSlider = document.getElementById('rotateX');
  if (rySlider) {
    rySlider.value = (rotY * 180 / Math.PI).toFixed(0);
    rySlider.oninput = function() {
      rotY = parseFloat(this.value) * Math.PI / 180;
      updateView();
    };
  }
  if (rxSlider) {
    rxSlider.value = (rotX * 180 / Math.PI).toFixed(0);
    rxSlider.oninput = function() {
      rotX = parseFloat(this.value) * Math.PI / 180;
      updateView();
    };
  }

  // ---- Render loop ----
  function animate() {
    container._animId = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  // ---- Info overlay ----
  var info = document.createElement('div');
  info.style.cssText = 'position:absolute;bottom:10px;left:10px;font-size:12px;color:#555;' +
    'background:rgba(255,255,255,0.92);padding:6px 12px;border-radius:6px;' +
    'border:1px solid #e0e0e0;pointer-events:none;z-index:10;';
  info.innerHTML = '<b>' + boxType.id + '</b> &middot; L=' + Math.round(L) +
    ' &times; W=' + Math.round(W) + ' &times; D=' + Math.round(D) + ' mm' +
    ' &middot; <span style="color:#888">Drag to rotate &middot; Wheel to zoom</span>';
  container.appendChild(info);

  // Zoom indicator
  var zoomInfo = document.createElement('div');
  zoomInfo.style.cssText = 'position:absolute;top:10px;right:10px;font-size:12px;color:#555;' +
    'background:rgba(255,255,255,0.92);padding:4px 10px;border-radius:6px;' +
    'border:1px solid #e0e0e0;pointer-events:none;z-index:10;';
  zoomInfo.id = 'zoomIndicator';
  zoomInfo.textContent = 'Zoom: ' + Math.round(zoom * 100) + '%';

  // Update zoom indicator on zoom
  var origUpdateView = updateView;
  updateView = function() {
    origUpdateView();
    zoomInfo.textContent = 'Zoom: ' + Math.round(zoom * 100) + '%';
  };
  updateView();
  container.appendChild(zoomInfo);

  // Handle container resize
  var resizeHandler = function() {
    var newW = container.clientWidth || 800;
    if (Math.abs(newW - containerW) > 10) {
      containerW = newW;
      camera.aspect = containerW / containerH;
      camera.updateProjectionMatrix();
      renderer.setSize(containerW, containerH);
    }
  };
  window.addEventListener('resize', resizeHandler);
  container._resizeHandler = resizeHandler;
};

/* ===== Fallback: Simple CSS 3D box (no Three.js) ===== */
Preview3D._renderSimple = function(container, boxType, params) {
  var L = params.L || 100;
  var W = params.W || 60;
  var D = params.D || 80;

  var maxDim = Math.max(L, W, D);
  var scale = 180 / maxDim;
  var sL = L * scale, sW = W * scale, sD = D * scale;

  container.innerHTML = '';

  var scene = document.createElement('div');
  scene.className = 'scene3d';
  scene.style.perspective = '800px';
  scene.style.width = '100%';
  scene.style.height = '500px';
  scene.style.display = 'flex';
  scene.style.alignItems = 'center';
  scene.style.justifyContent = 'center';
  scene.style.background = 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)';
  scene.style.borderRadius = '8px';
  scene.style.cursor = 'grab';

  var box = document.createElement('div');
  box.className = 'box3d';
  box.id = 'box3d';
  box.style.position = 'relative';
  box.style.transformStyle = 'preserve-3d';
  box.style.width = sL + 'px';
  box.style.height = sD + 'px';

  var halfL = sL / 2, halfW = sW / 2, halfD = sD / 2;
  var faces = [
    { name: 'Front', w: sL, h: sD, transform: 'translateZ(' + halfW + 'px)' },
    { name: 'Back', w: sL, h: sD, transform: 'rotateY(180deg) translateZ(' + halfW + 'px)' },
    { name: 'Right', w: sW, h: sD, transform: 'rotateY(90deg) translateZ(' + halfL + 'px)' },
    { name: 'Left', w: sW, h: sD, transform: 'rotateY(-90deg) translateZ(' + halfL + 'px)' },
    { name: 'Top', w: sL, h: sW, transform: 'rotateX(-90deg) translateZ(' + halfD + 'px)' },
    { name: 'Bottom', w: sL, h: sW, transform: 'rotateX(90deg) translateZ(' + halfD + 'px)' },
  ];

  faces.forEach(function(f) {
    var face = document.createElement('div');
    face.className = 'face3d';
    face.style.width = f.w + 'px';
    face.style.height = f.h + 'px';
    face.style.position = 'absolute';
    face.style.left = '50%';
    face.style.top = '50%';
    face.style.marginLeft = (-f.w / 2) + 'px';
    face.style.marginTop = (-f.h / 2) + 'px';
    face.style.transform = f.transform;
    face.style.backfaceVisibility = 'visible';
    face.style.background = 'rgba(255,248,240,0.85)';
    face.style.border = '0.5px solid #bbb';
    box.appendChild(face);
  });

  var info = document.createElement('div');
  info.style.cssText = 'position:absolute;bottom:10px;left:10px;font-size:12px;color:#555;' +
    'background:rgba(255,255,255,0.92);padding:6px 12px;border-radius:6px;border:1px solid #e0e0e0;';
  info.innerHTML = '<b>' + boxType.id + '</b> &middot; L=' + L + ' &times; W=' + W + ' &times; D=' + D + ' mm (simple mode)';

  scene.appendChild(box);
  container.appendChild(scene);
  container.appendChild(info);

  var rotY = -25, rotX = -15, zoom = 1;
  function updateRotation() {
    box.style.transform = 'rotateX(' + rotX + 'deg) rotateY(' + rotY + 'deg) scale(' + zoom + ')';
  }
  updateRotation();

  var rySlider = document.getElementById('rotateY');
  var rxSlider = document.getElementById('rotateX');
  if (rySlider) {
    rySlider.value = rotY;
    rySlider.oninput = function() { rotY = parseInt(this.value); updateRotation(); };
  }
  if (rxSlider) {
    rxSlider.value = rotX;
    rxSlider.oninput = function() { rotX = parseInt(this.value); updateRotation(); };
  }

  var isDragging = false, lastX = 0, lastY = 0;
  scene.addEventListener('mousedown', function(e) {
    isDragging = true; lastX = e.clientX; lastY = e.clientY;
    scene.style.cursor = 'grabbing'; e.preventDefault();
  });
  window.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    rotY += (e.clientX - lastX) * 0.5;
    rotX -= (e.clientY - lastY) * 0.5;
    rotX = Math.max(-80, Math.min(80, rotX));
    lastX = e.clientX; lastY = e.clientY;
    if (rySlider) rySlider.value = rotY;
    if (rxSlider) rxSlider.value = rotX;
    updateRotation();
  });
  window.addEventListener('mouseup', function() {
    isDragging = false; scene.style.cursor = 'grab';
  });
  scene.addEventListener('wheel', function(e) {
    e.preventDefault();
    zoom *= e.deltaY > 0 ? 0.9 : 1.1;
    zoom = Math.max(0.3, Math.min(3, zoom));
    updateRotation();
  }, { passive: false });
};

if (typeof window !== 'undefined') window.Preview3D = Preview3D;
