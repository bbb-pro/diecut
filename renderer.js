/*
 * renderer.js — SVG Ф╦╡Ф÷⌠Е╪∙Ф⌠▌
 * Х│▄Х╢ё: Ф╦╡Ф÷⌠Хё│Е┬┤Г╨©(Е╝·Г╨©)Ц─│Е▌▀Г≈∙Г╨©(Х≥ Г╨©)Ц─│Е╟╨Е╞╦Ф═┤ФЁ╗Ц─│Г╫▒Ф═╪Ц─│И²╒Ф═┤Г╜╬
 * Д╨╓Д╨▓: Ф▀√Ф▀╫Е╧ЁГ╖╩Ц─│Ф╩ Х╫╝Г╪╘Ф■╬Ц─│Е▐▄Е┤╩Е╓█Д╫█
 */

var SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  var el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    // Skip undefined / NaN attributes to avoid SVG "Expected length" errors
    if (v === undefined || (typeof v === 'number' && isNaN(v))) continue;
    el.setAttribute(k, v);
  }
  return el;
}

function Renderer(svgEl) {
  this.svg = svgEl;
  this.zoom = 1;       // px per mm
  this.panX = 0;
  this.panY = 0;
  this.data = null;
  this.options = { showDims: true, showGrid: true, showLabels: false };
  this.containerW = 0;
  this.containerH = 0;
}

Renderer.prototype.setOptions = function(opts) {
  for (var k in opts) this.options[k] = opts[k];
};

Renderer.prototype.resize = function() {
  var rect = this.svg.getBoundingClientRect();
  this.containerW = rect.width;
  this.containerH = rect.height;
  this.svg.setAttribute('viewBox', '0 0 ' + this.containerW + ' ' + this.containerH);
};

/* ===== Render main ===== */
Renderer.prototype.render = function(data) {
  this.data = data;
  // Clear
  while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

  // Defs
  var defs = svgEl('defs');
  // arrow marker for dimensions
  var marker = svgEl('marker', {
    id: 'dimArrow', viewBox: '0 0 10 10', refX: 5, refY: 5,
    markerWidth: 4, markerHeight: 4, orient: 'auto'
  });
  marker.appendChild(svgEl('path', { d: 'M0,2 L5,5 L0,8 Z', fill: '#999' }));
  defs.appendChild(marker);
  this.svg.appendChild(defs);

  // Background
  var bg = svgEl('rect', {
    x: 0, y: 0, width: this.containerW, height: this.containerH,
    fill: '#fafafa'
  });
  this.svg.appendChild(bg);

  // Content group (gets pan/zoom transform)
  this.contentGroup = svgEl('g');
  this.svg.appendChild(this.contentGroup);

  // Grid
  if (this.options.showGrid) this._drawGrid(data.bbox);

  // Panel overlay for the manual fold editor: filled regions the user can click
  // to pick the panel they want to re-hang. Drawn UNDER the cut/crease lines so
  // it never hides the dieline.
  if (data.panels && this.options.showPanels) this._drawPanels(data.panels, data.visualGroups);

  // Offset drawing to center
  var pad = 20;
  var drawW = data.bbox.maxX - data.bbox.minX;
  var drawH = data.bbox.maxY - data.bbox.minY;
  // Apply transform: translate + scale
  this._updateTransform();

  // Cut lines (solid red)
  var cutGroup = svgEl('g', { 'class': 'cut-group' });
  data.cuts.forEach(function(line) {
    var pts = line.map(function(p) { return p[0] + ',' + p[1]; }).join(' ');
    cutGroup.appendChild(svgEl('polyline', {
      points: pts, 'class': 'cut-line'
    }));
  });
  this.contentGroup.appendChild(cutGroup);

  // Crease lines (dashed blue)
  var creaseGroup = svgEl('g', { 'class': 'crease-group' });
  data.creases.forEach(function(line, ci) {
    var pts = line.map(function(p) { return p[0] + ',' + p[1]; }).join(' ');
    var pl = svgEl('polyline', {
      points: pts, 'class': 'crease-line'
    });
    pl.setAttribute('data-idx', ci);   // fold editor: clickable crease (hinge picking)
    creaseGroup.appendChild(pl);
  });
  this.contentGroup.appendChild(creaseGroup);

  // Dimensions
  if (this.options.showDims) {
    var dimGroup = svgEl('g', { 'class': 'dim-group' });
    data.dimensions.forEach(function(d) {
      Renderer._drawDimension(dimGroup, d);
    });
    this.contentGroup.appendChild(dimGroup);
  }

  // Labels
  if (this.options.showLabels) {
    var labelGroup = svgEl('g', { 'class': 'label-group' });
    data.labels.forEach(function(l) {
      var t = svgEl('text', {
        x: l.x, y: l.y, 'class': 'panel-label',
        transform: l.rotation ? 'rotate(' + l.rotation + ' ' + l.x + ' ' + l.y + ')' : ''
      });
      t.textContent = l.text;
      labelGroup.appendChild(t);
    });
    this.contentGroup.appendChild(labelGroup);
  }
};

/* ===== Grid ===== */
Renderer.prototype._drawGrid = function(bbox) {
  var gridGroup = svgEl('g', { 'class': 'grid-group' });
  var step = 10; // mm
  var minX = Math.floor(bbox.minX / step) * step - step;
  var maxX = Math.ceil(bbox.maxX / step) * step + step;
  var minY = Math.floor(bbox.minY / step) * step - step;
  var maxY = Math.ceil(bbox.maxY / step) * step + step;

  for (var x = minX; x <= maxX; x += step) {
    var major = (x % 50 === 0);
    gridGroup.appendChild(svgEl('line', {
      x1: x, y1: minY, x2: x, y2: maxY,
      'class': major ? 'grid-line-major' : 'grid-line'
    }));
  }
  for (var y = minY; y <= maxY; y += step) {
    var major = (y % 50 === 0);
    gridGroup.appendChild(svgEl('line', {
      x1: minX, y1: y, x2: maxX, y2: y,
      'class': major ? 'grid-line-major' : 'grid-line'
    }));
  }
  this.contentGroup.appendChild(gridGroup);
};

/* ===== Panel overlay (manual fold editor) =====
 * Filled panel regions the user can click to pick a panel. Panels come from
 * Preview3D.resolveFaces so these are exactly the shapes the 3D view folds —
 * if the two disagreed the user would click one panel and fold another.
 * SVG polygons carry their own hit testing, so no manual point-in-polygon. */
Renderer.prototype._drawPanels = function(panels, visualGroups) {
  var panelGroup = svgEl('g', { 'class': 'panel-group' });
  this.panelGroup = panelGroup;

  // Visual merge ("只显示不合并"): panels that share a horizontal crease in the
  // same column are one continuous board. We draw them WITHOUT their own stroke
  // so the split reads as a single board, and stitch the small crease gap with a
  // same-colour bridge rectangle so the fill looks continuous. The fold tree and
  // each panel's clickable region stay untouched.
  var mergedKeys = {};
  var bridges = [];
  if (visualGroups && visualGroups.groups) {
    visualGroups.groups.forEach(function(gr) {
      gr.forEach(function(k) { mergedKeys[k] = true; });
    });
  }
  if (visualGroups && visualGroups.bridges) bridges = visualGroups.bridges;

  // Map panel key -> its element, so bridges can be drawn after panels (on top).
  var byKey = {};
  panels.forEach(function(p) {
    var el;
    if (p.poly && p.poly.length >= 3) {
      el = svgEl('polygon', {
        points: p.poly.map(function(pt) { return pt[0] + ',' + pt[1]; }).join(' '),
        'class': 'panel-shape'
      });
    } else {
      // Rectangle fallback: the panel source has no outline, only a bbox.
      var b = p.bbox;
      el = svgEl('rect', {
        x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1],
        'class': 'panel-shape'
      });
    }
    el.setAttribute('data-key', p.key);
    if (mergedKeys[p.key]) el.classList.add('panel-merged');   // no internal stroke
    panelGroup.appendChild(el);
    byKey[p.key] = el;
  });

  // Stitch the horizontal crease gaps between merged panels so the fill reads as
  // one continuous board (the raster left a sub-millimetre wall there).
  var GAP = 6; // bridge half-width (mm) — comfortably covers the crease wall
  bridges.forEach(function(br) {
    if (!mergedKeys[br.a] || !mergedKeys[br.b]) return;   // only within a board
    var ux = br.ux, uy = br.uy;
    var nx = -uy, ny = ux;                  // perpendicular
    var h = br.len / 2;
    var p1 = [br.cx - ux * h + nx * GAP, br.cy - uy * h + ny * GAP];
    var p2 = [br.cx + ux * h + nx * GAP, br.cy + uy * h + ny * GAP];
    var p3 = [br.cx + ux * h - nx * GAP, br.cy + uy * h - ny * GAP];
    var p4 = [br.cx - ux * h - nx * GAP, br.cy - uy * h - ny * GAP];
    var bEl = svgEl('polygon', {
      points: p1.concat(p2, p3, p4).map(function(v) { return v.toFixed(2); }).join(' '),
      'class': 'panel-shape panel-merged'
    });
    bEl.setAttribute('data-bridge', br.a + '-' + br.b);
    panelGroup.appendChild(bEl);
  });

  this.contentGroup.appendChild(panelGroup);
};

/* Highlight the panel with the given key (manual fold editor selection). */
Renderer.prototype.setPanelHighlight = function(key) {
  if (!this.panelGroup) return;
  var kids = this.panelGroup.childNodes;
  for (var i = 0; i < kids.length; i++) {
    var on = (kids[i].getAttribute('data-key') === key);
    kids[i].classList.toggle('panel-selected', on);
  }
};

/* Mark overridden panels on the 2D net (fold editor): user-pinned root = green,
 * direction-flipped = amber. Purely visual, driven from app.js on each render. */
Renderer.prototype.setPanelMarks = function(rootKey, flipKeys) {
  if (!this.panelGroup) return;
  var kids = this.panelGroup.childNodes;
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i].getAttribute('data-key');
    kids[i].classList.toggle('panel-root', k === rootKey);
    kids[i].classList.toggle('panel-flip', !!flipKeys && flipKeys.indexOf(k) >= 0);
  }
};

/* Highlight the crease line with the given index (fold editor crease picking). */
Renderer.prototype.setCreaseHighlight = function(idx) {
  var kids = this.svg.querySelectorAll('.crease-line');
  for (var i = 0; i < kids.length; i++) {
    kids[i].classList.toggle('crease-selected',
      idx != null && String(idx) === kids[i].getAttribute('data-idx'));
  }
};

/* ===== Dimension drawing ===== */
Renderer._drawDimension = function(parent, d) {
  var arrowSize = 2;
  if (d.type === 'h') {
    var y = d.y1 + d.offset;
    // Extension lines
    parent.appendChild(svgEl('line', { x1: d.x1, y1: d.y1, x2: d.x1, y2: y + 1, 'class': 'dim-line' }));
    parent.appendChild(svgEl('line', { x1: d.x2, y1: d.y1, x2: d.x2, y2: y + 1, 'class': 'dim-line' }));
    // Dimension line
    parent.appendChild(svgEl('line', { x1: d.x1, y1: y, x2: d.x2, y2: y, 'class': 'dim-line' }));
    // Arrows
    parent.appendChild(svgEl('path', { d: 'M' + d.x1 + ',' + y + ' L' + (d.x1 + arrowSize) + ',' + (y - arrowSize * 0.5) + ' L' + (d.x1 + arrowSize) + ',' + (y + arrowSize * 0.5) + ' Z', fill: '#999', stroke: 'none' }));
    parent.appendChild(svgEl('path', { d: 'M' + d.x2 + ',' + y + ' L' + (d.x2 - arrowSize) + ',' + (y - arrowSize * 0.5) + ' L' + (d.x2 - arrowSize) + ',' + (y + arrowSize * 0.5) + ' Z', fill: '#999', stroke: 'none' }));
    // Text
    var tx = (d.x1 + d.x2) / 2;
    var t = svgEl('text', { x: tx, y: y - 1, 'class': 'dim-text' });
    t.textContent = d.label;
    parent.appendChild(t);
  } else {
    var x = d.x1 + d.offset;
    parent.appendChild(svgEl('line', { x1: d.x1, y1: d.y1, x2: x + 1, y2: d.y1, 'class': 'dim-line' }));
    parent.appendChild(svgEl('line', { x1: d.x2, y1: d.y2, x2: x + 1, y2: d.y2, 'class': 'dim-line' }));
    parent.appendChild(svgEl('line', { x1: x, y1: d.y1, x2: x, y2: d.y2, 'class': 'dim-line' }));
    parent.appendChild(svgEl('path', { d: 'M' + x + ',' + d.y1 + ' L' + (x - arrowSize * 0.5) + ',' + (d.y1 + arrowSize) + ' L' + (x + arrowSize * 0.5) + ',' + (d.y1 + arrowSize) + ' Z', fill: '#999', stroke: 'none' }));
    parent.appendChild(svgEl('path', { d: 'M' + x + ',' + d.y2 + ' L' + (x - arrowSize * 0.5) + ',' + (d.y2 - arrowSize) + ' L' + (x + arrowSize * 0.5) + ',' + (d.y2 - arrowSize) + ' Z', fill: '#999', stroke: 'none' }));
    var ty = (d.y1 + d.y2) / 2;
    var t2 = svgEl('text', { x: x + 2, y: ty, 'class': 'dim-text', transform: 'rotate(90 ' + (x + 2) + ' ' + ty + ')' });
    t2.textContent = d.label;
    parent.appendChild(t2);
  }
};

/* ===== Transform ===== */
Renderer.prototype._updateTransform = function() {
  if (!this.data) return;
  var bbox = this.data.bbox;
  var drawW = bbox.maxX - bbox.minX;
  var drawH = bbox.maxY - bbox.minY;
  if (drawW === 0 || drawH === 0) return;
  // Center the drawing in the content group
  this.contentGroup.setAttribute('transform',
    'translate(' + this.panX + ',' + this.panY + ') scale(' + this.zoom + ')'
  );
};

/* ===== Fit to view ===== */
Renderer.prototype.fit = function() {
  if (!this.data) return;
  var bbox = this.data.bbox;
  var drawW = bbox.maxX - bbox.minX;
  var drawH = bbox.maxY - bbox.minY;
  if (drawW === 0 || drawH === 0) return;
  var padX = 40, padY = 40;
  var scaleX = (this.containerW - padX * 2) / drawW;
  var scaleY = (this.containerH - padY * 2) / drawH;
  this.zoom = Math.min(scaleX, scaleY);
  // Center
  this.panX = (this.containerW - drawW * this.zoom) / 2 - bbox.minX * this.zoom;
  this.panY = (this.containerH - drawH * this.zoom) / 2 - bbox.minY * this.zoom;
  this._updateTransform();
  this._updateZoomDisplay();
};

/* ===== Zoom methods ===== */
Renderer.prototype.setZoom = function(z) {
  var cx = this.containerW / 2;
  var cy = this.containerH / 2;
  // Keep center point fixed
  var mx = (cx - this.panX) / this.zoom;
  var my = (cy - this.panY) / this.zoom;
  this.zoom = z;
  this.panX = cx - mx * z;
  this.panY = cy - my * z;
  this._updateTransform();
  this._updateZoomDisplay();
};

Renderer.prototype.zoomAt = function(factor, cx, cy) {
  var mx = (cx - this.panX) / this.zoom;
  var my = (cy - this.panY) / this.zoom;
  this.zoom *= factor;
  this.zoom = Math.max(0.05, Math.min(this.zoom, 20));
  this.panX = cx - mx * this.zoom;
  this.panY = cy - my * this.zoom;
  this._updateTransform();
  this._updateZoomDisplay();
};

Renderer.prototype.pan = function(dx, dy) {
  this.panX += dx;
  this.panY += dy;
  this._updateTransform();
};

Renderer.prototype._updateZoomDisplay = function() {
  var el = document.getElementById('zoomDisplay');
  if (el) el.textContent = Math.round(this.zoom * 100) / 100 + 'x (' + Math.round(this.zoom) + 'px/mm)';
};

/* ===== Interaction ===== */
Renderer.prototype.initInteraction = function(container) {
  var self = this;
  var isDragging = false;
  var lastX = 0, lastY = 0;

  container.addEventListener('mousedown', function(e) {
    if (e.button === 0) {
      isDragging = true;
      self._dragDist = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      container.classList.add('dragging');
    }
  });

  window.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    self._dragDist = (self._dragDist || 0) + Math.abs(dx) + Math.abs(dy);
    self.pan(dx, dy);
  });

  window.addEventListener('mouseup', function() {
    isDragging = false;
    container.classList.remove('dragging');
  });

  // Manual fold editor: clicking a panel selects it, but ONLY when the pointer
  // barely moved. Panning starts with a mousedown on whatever is under the
  // cursor, so without this guard every drag across the net would silently
  // re-select a panel.
  container.addEventListener('click', function(e) {
    if ((self._dragDist || 0) > 4) return;
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var cidx = t.getAttribute('data-idx');
    if (cidx != null) {
      if (self.onCreaseClick) self.onCreaseClick(parseInt(cidx, 10), e);
      return;
    }
    var key = t.getAttribute('data-key');
    if (key == null) return;
    if (self.onPanelClick) self.onPanelClick(key, e);
  });

  container.addEventListener('mouseover', function(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var cidx = t.getAttribute('data-idx');
    if (cidx != null) {
      if (self.onCreaseHover) self.onCreaseHover(parseInt(cidx, 10), e);
      return;
    }
    var key = t.getAttribute('data-key');
    if (key == null) return;
    if (self.onPanelHover) self.onPanelHover(key, e);
  });

  container.addEventListener('wheel', function(e) {
    e.preventDefault();
    var rect = container.getBoundingClientRect();
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top;
    var factor = e.deltaY > 0 ? 0.9 : 1.1;
    self.zoomAt(factor, cx, cy);
  }, { passive: false });

  container.addEventListener('dblclick', function() {
    self.fit();
  });

  // Touch support
  var touchDist = 0;
  var touchCenter = { x: 0, y: 0 };
  container.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      isDragging = true;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      isDragging = false;
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDist = Math.sqrt(dx * dx + dy * dy);
      var rect = container.getBoundingClientRect();
      touchCenter.x = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      touchCenter.y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    }
  }, { passive: false });

  container.addEventListener('touchmove', function(e) {
    e.preventDefault();
    if (e.touches.length === 1 && isDragging) {
      var dx = e.touches[0].clientX - lastX;
      var dy = e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      self.pan(dx, dy);
    } else if (e.touches.length === 2) {
      var ndx = e.touches[0].clientX - e.touches[1].clientX;
      var ndy = e.touches[0].clientY - e.touches[1].clientY;
      var newDist = Math.sqrt(ndx * ndx + ndy * ndy);
      if (touchDist > 0) {
        self.zoomAt(newDist / touchDist, touchCenter.x, touchCenter.y);
      }
      touchDist = newDist;
    }
  }, { passive: false });

  container.addEventListener('touchend', function() {
    isDragging = false;
    touchDist = 0;
  });
};

if (typeof window !== 'undefined') window.Renderer = Renderer;
