/*
 * app.js — Main application logic
 * Manages state, events, parameter linking, module coordination
 */

(function() {
  var App = {
    state: {
      boxTypeIndex: 0,
      params: {},
      compensation: 0,
      showDims: true,
      showGrid: true,
      showLabels: false,
      viewMode: '2d',
      artFace: 'M0',
      // Manual fold editor
      showPanels: true,
      selectedPanel: null,
      selectedCrease: null,
      linkFrom: null,   // two-step hinge linking: first panel picked
      foldOv: { items: [], stale: false },
    },
    renderer: null,
    currentData: null,
    allBoxTypes: [],
    paramUpdateTimer: null,
    isLoadingGeometry: false,

    init: function() {
      var self = this;
      var svg = document.getElementById('diecutSvg');
      this.renderer = new Renderer(svg);
      this.renderer.resize();
      this.renderer.initInteraction(document.getElementById('canvasContainer'));
      // Manual fold editor: clicking a panel in the 2D dieline selects it, so it
      // can then be re-hung in 3D. Clicking a crease selects that fold line (S3).
      this.renderer.onPanelClick = function(key) { self.selectPanel(key); };
      this.renderer.onCreaseClick = function(idx) { self.selectCrease(idx); };

      // Use ONLY packmage box types (no FEFCO)
      if (typeof PackmageBoxTypes !== 'undefined') {
        this.allBoxTypes = PackmageBoxTypes.build();
      }

      this.populateBoxTypes();
      this.buildLibraryBrowser();
      this.bindEvents();
      this.selectBoxType(0, false);
      this.switchTab('library');
      this.renderer.fit();

      window.addEventListener('resize', function() {
        self.renderer.resize();
        self.renderer.fit();
        self.render();
      });

      setTimeout(function() {
        self.renderer.resize();
        self.renderer.fit();
        self.render();
      }, 50);
    },

    populateBoxTypes: function() {
      var select = document.getElementById('boxTypeSelect');
      select.innerHTML = '';
      var self = this;
      this.allBoxTypes.forEach(function(bt, i) {
        var opt = document.createElement('option');
        opt.value = i;
        opt.textContent = bt.id + ' - ' + bt.name;
        select.appendChild(opt);
      });
      select.addEventListener('change', function() {
        self.selectBoxType(parseInt(this.value));
      });
    },

    selectBoxType: function(index, autoTab) {
      this.state.boxTypeIndex = index;
      var bt = this.allBoxTypes[index];
      var self = this;

      // Initialize params with defaults
      this.state.params = {};
      bt.params.forEach(function(p) {
        self.state.params[p.key] = p.default;
      });
      // Default CAL=0 (no compensation); packmage API defaults to CAL=2 if not sent
      this.state.params.CAL = this.state.compensation || 0;

      // Reset to default geometry
      bt.currentBoxData = bt.packmageData;
      bt.isLive = false;

      // Compute derived params
      if (bt.compute) bt.compute(this.state.params);
      this._foldOvLoad();   // per-box overrides; fingerprint mismatch wipes them
      this.renderParams();
      this.render();
      if (this.state.viewMode === '3d') this.render3D();
      this.updateBoxInfo();
      this.updateCurrentPreview(bt);
      document.getElementById('boxTypeSelect').value = index;
      // Only switch to params tab when user actively selects (not during init)
      if (autoTab !== false) this.switchTab('params');
    },

    updateCurrentPreview: function(bt) {
      var img = document.getElementById('currentBoxPreviewImg');
      var name = document.getElementById('currentBoxPreviewName');
      if (img) {
        img.style.display = '';
        img.src = 'https://online.packmage.cn/Content/boximg/' + bt.id + '-M.png';
      }
      if (name) name.textContent = bt.id + ' · ' + bt.name;
    },

    renderParams: function() {
      var container = document.getElementById('paramList');
      container.innerHTML = '';
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      var self = this;

      // --- Editable input params (L, W, D, etc.) ---
      bt.params.forEach(function(p) {
        var div = document.createElement('div');
        div.className = 'param-item';

        var label = document.createElement('label');
        label.innerHTML = '<span>' + p.label + '</span><span class="param-unit">mm</span>';
        div.appendChild(label);

        var input = document.createElement('input');
        input.type = 'number';
        input.min = p.min;
        input.max = p.max;
        input.step = p.step || 1;
        input.value = self.state.params[p.key];
        input.dataset.key = p.key;

        input.addEventListener('input', function() {
          var val = parseFloat(this.value);
          if (isNaN(val)) val = p.default;
          val = Math.max(p.min, Math.min(p.max, val));
          self.state.params[p.key] = val;
          if (bt.compute) bt.compute(self.state.params);
          self.scheduleParamUpdate();
          self.updateBoxInfo();
        });

        input.addEventListener('change', function() {
          var val = parseFloat(this.value);
          if (isNaN(val)) {
            val = p.default;
            this.value = val;
          }
          val = Math.max(p.min, Math.min(p.max, val));
          this.value = val;
          self.state.params[p.key] = val;
          if (bt.compute) bt.compute(self.state.params);
          self.scheduleParamUpdate();
          self.updateBoxInfo();
        });

        div.appendChild(input);

        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = p.min;
        slider.max = Math.max(p.min + 1, Math.min(p.max, p.default * 5));
        slider.step = p.step || 1;
        slider.value = self.state.params[p.key];

        slider.addEventListener('input', function() {
          var val = parseFloat(this.value);
          self.state.params[p.key] = val;
          input.value = val;
          if (bt.compute) bt.compute(self.state.params);
          self.scheduleParamUpdate();
          self.updateBoxInfo();
        });

        div.appendChild(slider);
        container.appendChild(div);
      });

      // --- Read-only derived params ---
      if (bt.derived && bt.derived.length > 0) {
        var section = document.createElement('div');
        section.className = 'param-derived-section';
        section.id = 'derivedSection';

        var title = document.createElement('div');
        title.className = 'param-derived-title';
        title.textContent = '自动计算参数';
        section.appendChild(title);

        bt.derived.forEach(function(d) {
          var row = document.createElement('div');
          row.className = 'param-derived-row';

          var rowLabel = document.createElement('span');
          rowLabel.className = 'param-derived-label';
          rowLabel.textContent = d.label;

          var rowVal = document.createElement('span');
          rowVal.className = 'param-derived-value';
          var val = self.state.params[d.key];
          rowVal.textContent = (typeof val === 'number' && !isNaN(val)) ? val.toFixed(1) + ' mm' : '—';
          rowVal.dataset.key = d.key;

          row.appendChild(rowLabel);
          row.appendChild(rowVal);
          section.appendChild(row);
        });

        container.appendChild(section);
      }
    },

    // Debounced parameter update — calls API after user stops typing
    scheduleParamUpdate: function() {
      var self = this;
      if (this.paramUpdateTimer) clearTimeout(this.paramUpdateTimer);

      // Show loading indicator
      this.showLoading(true);

      this.paramUpdateTimer = setTimeout(function() {
        self.updateGeometryFromAPI();
      }, 700);
    },

    updateGeometryFromAPI: function() {
      var self = this;
      var bt = this.allBoxTypes[this.state.boxTypeIndex];

      if (!bt.updateGeometry) {
        this.showLoading(false);
        this.render();
        return;
      }

      bt.updateGeometry(this.state.params, function(success) {
        self.showLoading(false);
        try {
          self._foldOvLoad();   // params may have changed → invalidate stale overrides
          if (bt.compute) bt.compute(self.state.params);
          self.render();
          self.renderer.fit();
          self.updateBoxInfo();
          self.updateDerivedDisplay();
          if (self.state.viewMode === '3d') self.render3D();
        } catch (e) {
          console.error('[App] Render error after geometry update:', e);
        }

        if (!success) {
          self.showStatus('参数超出范围或服务器繁忙，使用默认几何数据');
        } else if (bt.isLive) {
          self.showStatus('几何数据已实时更新');
        }
      });
    },

    showLoading: function(loading) {
      this.isLoadingGeometry = loading;
      var overlay = document.getElementById('loadingOverlay');
      if (overlay) {
        overlay.style.display = loading ? 'flex' : 'none';
      }
    },

    showStatus: function(msg) {
      var info = document.getElementById('overlayInfo');
      if (info) {
        info.textContent = msg;
        setTimeout(function() {
          info.textContent = '';
        }, 3000);
      }
    },

    // Update derived param display values without rebuilding DOM
    updateDerivedDisplay: function() {
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      if (!bt.derived) return;
      var section = document.getElementById('derivedSection');
      if (!section) return;
      bt.derived.forEach(function(d) {
        var el = section.querySelector('[data-key="' + d.key + '"]');
        if (el) {
          var val = App.state.params[d.key];
          el.textContent = (typeof val === 'number' && !isNaN(val)) ? val.toFixed(1) + ' mm' : '—';
        }
      });
    },

    render: function() {
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      var comp = this.state.compensation;
      if (bt.compute) bt.compute(this.state.params);
      var data = bt.draw(this.state.params, comp);
      this.currentData = data;

      // Manual fold editor: the clickable panel overlay. Resolved through
      // Preview3D.resolveFaces so these are exactly the panels the 3D view folds.
      data.panels = this.resolvePanels(bt);
      // Visual merge groups ("只显示不合并"): which panels belong to one
      // continuous board split only by creases. The 2D renderer draws each group
      // as a single board (same fill, no internal boundary) without touching the
      // fold tree. Null/empty when unavailable.
      data.visualGroups = this.visualMergeGroups(bt);

      this.renderer.setOptions({
        showDims: this.state.showDims,
        showGrid: this.state.showGrid,
        showLabels: this.state.showLabels,
        showPanels: this.state.showPanels,
      });
      this.renderer.render(data);
      // Highlight the user's overrides on the 2D net (root pin + direction flips).
      // Must run AFTER render(): render rebuilds the whole SVG and would wipe them.
      var _ov2d = this._foldOvMap(null);
      this.renderer.setPanelMarks(_ov2d.root, _ov2d.flips);
      this.renderer.setPanelHighlight(this.state.selectedPanel);
    },

    /* Panels for the 2D overlay, straight from the 3D panel resolver.
     * Returns null when the resolver is unavailable, which simply means the
     * overlay is not drawn — the dieline itself is unaffected. */
    resolvePanels: function(bt) {
      if (typeof Preview3D === 'undefined' || !Preview3D.resolveFaces) return null;
      try {
        var r = Preview3D.resolveFaces(bt);
        if (!r || !r.faceData) return null;
        var keys = Object.keys(r.faceData);
        var out = [];
        keys.forEach(function(k) {
          out.push({ key: k, bbox: r.faceData[k], poly: r.polys[k] || null });
        });
        return out.length ? out : null;
      } catch (e) {
        return null;
      }
    },

    /* Visual merge groups for the 2D net. Returns Preview3D.computeVisualGroups
     * result ({groups, bridges}) or null when the resolver is unavailable.
     * Whitelisted box types only: the merge fixes cartons whose long walls are
     * split into thin strips by horizontal creases (A042's left wall). Other
     * box types keep their normal lid/body/base panel split, so they are NOT
     * merged here — otherwise their fold flaps would visually fuse. */
    visualMergeGroups: function(bt) {
      if (typeof Preview3D === 'undefined' || !Preview3D.computeVisualGroups) return null;
      var id = (bt && bt.id) || '';
      var enabled = ['A042'].indexOf(id) >= 0;
      if (!enabled) return null;
      try {
        return Preview3D.computeVisualGroups(bt);
      } catch (e) {
        return null;
      }
    },

    /* ===== Manual fold editor: selection + overrides ===== */

    selectPanel: function(key) {
      // Two-step hinge linking ("两板连铰链"): a panel is already picked as
      // endpoint A, so this click is endpoint B — create the forced hinge and
      // leave normal selection untouched.
      if (this.state.linkFrom && key && key !== this.state.linkFrom) {
        var a = this.state.linkFrom;
        this.state.linkFrom = null;
        this.state.selectedPanel = key;
        this.renderer.setPanelHighlight(key);
        this.renderer.setCreaseHighlight(null);
        this._foldSelStatus();
        this._addPanelHinge(a, key);
        return;
      }
      if (this.state.linkFrom && key === this.state.linkFrom) this.state.linkFrom = null;
      this.state.selectedPanel = (this.state.selectedPanel === key) ? null : key;
      this.state.selectedCrease = null;
      this.renderer.setPanelHighlight(this.state.selectedPanel);
      this.renderer.setCreaseHighlight(null);
      // Sync the 3D highlight so the picked panel glows there too. Cheap call
      // (just sets emissive on the right materials) and safe when 3D is not
      // mounted — setSelected is undefined in that case.
      if (typeof Preview3D !== 'undefined' && Preview3D.setSelected) {
        Preview3D.setSelected(this.state.selectedPanel);
      }
      this._foldSelStatus();
    },

    selectCrease: function(idx) {
      this.state.selectedCrease = (this.state.selectedCrease === idx) ? null : idx;
      this.state.selectedPanel = null;
      this.state.linkFrom = null;
      this.renderer.setPanelHighlight(null);
      this.renderer.setCreaseHighlight(this.state.selectedCrease);
      // Picking a crease deselects the panel; clear the 3D highlight as well.
      if (typeof Preview3D !== 'undefined' && Preview3D.setSelected) {
        Preview3D.setSelected(null);
      }
      this._foldSelStatus();
    },

    /* One line of feedback under the fold editor buttons. */
    _foldSelStatus: function() {
      var el = document.getElementById('foldSelInfo');
      if (el) {
        el.textContent = this.state.linkFrom
          ? '连接模式：已选 ' + this.state.linkFrom + '，再点另一块面板组成铰链（点同一面板取消）'
          : (this.state.selectedPanel
              ? '已选中面板 ' + this.state.selectedPanel
              : (this.state.selectedCrease != null
                  ? '已选中压痕线 #' + this.state.selectedCrease
                  : '未选中（在刀模图上点选面板或压痕线）'));
      }
      var hasPanel = !!this.state.selectedPanel;
      var hasCrease = this.state.selectedCrease != null;
      var bRoot = document.getElementById('btnSetRoot');
      var bFlip = document.getElementById('btnFlipHinge');
      var bCreaseHinge = document.getElementById('btnCreaseHinge');
      var bCreaseNofold = document.getElementById('btnCreaseNofold');
      var bLink = document.getElementById('btnLinkHinge');
      var bAngle = document.getElementById('btnFoldAngle');
      if (bRoot) bRoot.disabled = !hasPanel;
      if (bFlip) bFlip.disabled = !hasPanel;
      if (bCreaseHinge) bCreaseHinge.disabled = !hasCrease;
      if (bCreaseNofold) bCreaseNofold.disabled = !hasCrease;
      if (bLink) {
        bLink.disabled = !hasPanel;
        bLink.textContent = this.state.linkFrom ? '取消连接' : '两板连铰链';
      }
      if (bAngle) bAngle.disabled = !hasPanel;
    },

    /* Size fingerprint: any param change invalidates the stored overrides. */
    _foldOvFp: function() {
      var p = this.state.params || {};
      return Object.keys(p).sort().map(function(k) {
        return k + '=' + (typeof p[k] === 'number' ? Math.round(p[k]) : p[k]);
      }).join('&');
    },

    /* Load overrides for the current box from localStorage; a fingerprint
     * mismatch wipes them (the dieline was regenerated, stored geometry may
     * point at different panels now). */
    _foldOvLoad: function() {
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      var fp = this._foldOvFp();
      var res = { items: [], stale: false };
      try {
        var raw = localStorage.getItem('packmage.foldov.' + bt.id);
        if (raw) {
          var obj = JSON.parse(raw);
          if (obj && Array.isArray(obj.items) && obj.fp === fp) res.items = obj.items;
          else if (obj && Array.isArray(obj.items)) res.stale = true;
        }
      } catch (e) { /* corrupt entry: start clean */ }
      this.state.foldOv = res;
      this.renderFoldOvList();
      if (res.stale) this.showStatus('尺寸参数已变化，先前的手动折叠调整已失效');
    },

    _foldOvSave: function(items) {
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      try {
        if (!items.length) localStorage.removeItem('packmage.foldov.' + bt.id);
        else localStorage.setItem('packmage.foldov.' + bt.id,
          JSON.stringify({ v: 1, boxId: bt.id, fp: this._foldOvFp(), items: items }));
      } catch (e) { /* storage full / disabled: session-only */ }
      this.state.foldOv.items = items;
      this.state.foldOv.stale = false;
      this.renderFoldOvList();
    },

    /* bbox centre of the given panel — the geometry we store (never the index:
     * after a resize the fe array is regenerated and indices shift). */
    _panelCenter: function(key) {
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      try {
        var r = Preview3D.resolveFaces(bt);
        var b = r && r.faceData && r.faceData[key];
        if (b && b.length >= 4) return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      } catch (e) {}
      return null;
    },

    /* Which panel key owns point p? Smallest containing panel wins — raster
     * panels do not overlap, but bbox rounding can nest a flap inside a body. */
    _foldOvKeyAt: function(p, fd) {
      if (!p || !fd) return null;
      var best = null, bestA = Infinity;
      Object.keys(fd).forEach(function(k) {
        var b = fd[k];
        if (!b || b.length < 4) return;
        if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]) {
          var a = (b[2] - b[0]) * (b[3] - b[1]);
          if (a < bestA) { bestA = a; best = k; }
        }
      });
      return best;
    },

    /* Current faceData (the exact panel geometry the 3D build folds). */
    _foldFd: function() {
      try {
        if (typeof Preview3D === 'undefined' || !Preview3D.resolveFaces) return null;
        var bt = this.allBoxTypes[this.state.boxTypeIndex];
        var r = Preview3D.resolveFaces(bt);
        return (r && r.faceData) || null;
      } catch (e) { return null; }
    },

    /* Longest straight run in a crease polyline (consecutive collinear points
     * merged) — the segment a forced hinge / nofold ban is stored as. */
    _longestStraightSeg: function(line) {
      if (!line || line.length < 2) return null;
      var best = null, i = 0;
      while (i < line.length - 1) {
        var j = i + 1;
        while (j < line.length - 1) {
          var ux = line[j][0] - line[i][0], uy = line[j][1] - line[i][1];
          var vx = line[j + 1][0] - line[j][0], vy = line[j + 1][1] - line[j][1];
          var L1 = Math.hypot(ux, uy), L2 = Math.hypot(vx, vy);
          if (L2 < 1e-9 || Math.abs(ux * vy - uy * vx) > 1e-6 * L1 * L2) break;
          j++;
        }
        var len = Math.hypot(line[j][0] - line[i][0], line[j][1] - line[i][1]);
        if (!best || len > best.len) {
          best = { g: [line[i][0], line[i][1], line[j][0], line[j][1]], len: len };
        }
        i = j;
      }
      return best ? best.g : null;
    },

    /* Segment [x1,y1,x2,y2] -> the hinge-axis object shape the 3D build
     * consumes (same fields as an edgesOverlap result: orient/cx/cy/dir/len). */
    _ovFromSeg: function(g) {
      if (!g || g.length < 4) return null;
      var dx = g[2] - g[0], dy = g[3] - g[1];
      var len = Math.hypot(dx, dy);
      if (len < 1e-6) return null;
      var orient = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
      return {
        x1: Math.min(g[0], g[2]), y1: Math.min(g[1], g[3]),
        x2: Math.max(g[0], g[2]), y2: Math.max(g[1], g[3]),
        orient: orient,
        cx: (g[0] + g[2]) / 2, cy: (g[1] + g[3]) / 2,
        dir: orient === 'h' ? { x: dx >= 0 ? 1 : -1, y: 0 } : { x: 0, y: dy >= 0 ? 1 : -1 },
        len: len
      };
    },

    /* Nearest panel to point p. Strict containment wins FIRST (smallest
     * containing panel, matching _foldOvKeyAt's nesting rule); the tol-mm
     * radius (2 mm default — bbox rounding on shared edges puts the probe
     * just outside both boxes) is only a fallback. Order matters: on a shared
     * edge the outside probe sits 1.5 mm from the SMALL neighbour, which would
     * otherwise beat the panel that actually contains the probe. */
    _panelNear: function(p, fd, tol) {
      tol = tol || 2;
      var best = null, bestA = Infinity;
      Object.keys(fd).forEach(function(k) {
        var b = fd[k];
        if (!b || b.length < 4) return;
        if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]) {
          var a0 = (b[2] - b[0]) * (b[3] - b[1]);
          if (a0 < bestA) { bestA = a0; best = k; }
        }
      });
      if (best) return best;
      var bestD = Infinity;
      Object.keys(fd).forEach(function(k) {
        var b = fd[k];
        if (!b || b.length < 4) return;
        var dx = Math.max(b[0] - p[0], 0, p[0] - b[2]);
        var dy = Math.max(b[1] - p[1], 0, p[1] - b[3]);
        var d = Math.hypot(dx, dy);
        if (d <= tol) {
          var a = (b[2] - b[0]) * (b[3] - b[1]);
          if (a < bestA || (a === bestA && d < bestD)) { bestA = a; bestD = d; best = k; }
        }
      });
      return best;
    },

    /* Which two panels sit on either side of segment g? Samples the segment and
     * probes 1.5 mm out on both sides; a side needs >=50% of samples hitting one
     * and the same panel. Parent = the larger panel (fold trees root at bodies,
     * not flaps). Returns {parent, child} or null. */
    _hingePairFromSeg: function(g, fd) {
      if (!g || g.length < 4 || !fd) return null;
      var L = Math.hypot(g[2] - g[0], g[3] - g[1]);
      if (L < 2) return null;
      var ux = (g[2] - g[0]) / L, uy = (g[3] - g[1]) / L;
      var nx = -uy, ny = ux;
      var n = Math.max(6, Math.min(40, Math.round(L / 5)));
      var PROBE = 1.5;
      var sideA = {}, sideB = {}, hits = 0;
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var px = g[0] + (g[2] - g[0]) * t, py = g[1] + (g[3] - g[1]) * t;
        var ka = this._panelNear([px + nx * PROBE, py + ny * PROBE], fd, 2);
        var kb = this._panelNear([px - nx * PROBE, py - ny * PROBE], fd, 2);
        if (ka && kb && ka !== kb) {
          sideA[ka] = (sideA[ka] || 0) + 1;
          sideB[kb] = (sideB[kb] || 0) + 1;
          hits++;
        }
      }
      if (!hits || hits < n * 0.5) return null;
      var bestA = null, cA = 0, bestB = null, cB = 0;
      Object.keys(sideA).forEach(function(k) { if (sideA[k] > cA) { cA = sideA[k]; bestA = k; } });
      Object.keys(sideB).forEach(function(k) { if (sideB[k] > cB) { cB = sideB[k]; bestB = k; } });
      if (!bestA || !bestB || bestA === bestB) return null;
      if (cA < hits * 0.5 || cB < hits * 0.5) return null;
      var ba = fd[bestA], bb = fd[bestB];
      if (!ba || !bb) return null;
      var areaA = (ba[2] - ba[0]) * (ba[3] - ba[1]);
      var areaB = (bb[2] - bb[0]) * (bb[3] - bb[1]);
      return areaA >= areaB
        ? { parent: bestA, child: bestB }
        : { parent: bestB, child: bestA };
    },

    /* Longest shared edge between two panel bboxes (2 mm tolerance). This is
     * the hinge axis stored for a two-panel forced link. */
    _sharedEdgeSeg: function(ka, kb, fd) {
      var a = fd[ka], b = fd[kb];
      if (!a || !b || a.length < 4 || b.length < 4) return null;
      var TOL = 2;
      var cands = [
        { fixed: a[2], other: b[0], vert: true  },   // a right edge ≈ b left edge
        { fixed: a[0], other: b[2], vert: true  },
        { fixed: a[3], other: b[1], vert: false },   // a bottom ≈ b top (net coords)
        { fixed: a[1], other: b[3], vert: false }
      ];
      var best = null;
      cands.forEach(function(c) {
        if (Math.abs(c.fixed - c.other) > TOL) return;
        var lo, hi;
        if (c.vert) {
          lo = Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3]));
          hi = Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]));
        } else {
          lo = Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2]));
          hi = Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]));
        }
        if (hi - lo < 2) return;
        if (!best || hi - lo > best.len) {
          best = c.vert
            ? { g: [c.fixed, lo, c.fixed, hi], len: hi - lo }
            : { g: [lo, c.fixed, hi, c.fixed], len: hi - lo };
        }
      });
      return best ? best.g : null;
    },

    /* Current overrides resolved to panel keys (what 3D consumes and what the
     * 2D net highlights). Uses the same resolveFaces the 3D build uses.
     * S3/S4: hinge items resolve to {parent, child, ov} pairs (child-keyed so a
     * later instruction for the same panel wins), nofold items to banned
     * 'a|b' pairs, angle items to {key: foldMult} (180° -> 2, 0° -> 0). */
    _foldOvMap: function(fd) {
      var out = { root: null, flips: [], hinges: [], nofolds: [], angles: {} };
      var ov = this.state.foldOv;
      if (!ov || !ov.items || !ov.items.length) return out;
      if (!fd) fd = this._foldFd();
      if (!fd) return out;
      var self = this;
      var hMap = {};
      ov.items.forEach(function(it) {
        if (it.t === 'root' || it.t === 'flip') {
          var k = self._foldOvKeyAt(it.p, fd);
          if (!k) return;
          if (it.t === 'root') out.root = k;
          else if (out.flips.indexOf(k) < 0) out.flips.push(k);
        } else if (it.t === 'hinge' && it.g && it.g.length >= 4) {
          var pair = self._hingePairFromSeg(it.g, fd);
          var ovs = self._ovFromSeg(it.g);
          if (pair && ovs) hMap[pair.child] = { parent: pair.parent, child: pair.child, ov: ovs };
        } else if (it.t === 'nofold' && it.g && it.g.length >= 4) {
          var p2 = self._hingePairFromSeg(it.g, fd);
          if (!p2) return;
          var kk = p2.parent < p2.child ? p2.parent + '|' + p2.child : p2.child + '|' + p2.parent;
          if (out.nofolds.indexOf(kk) < 0) out.nofolds.push(kk);
        } else if (it.t === 'angle') {
          var k3 = self._foldOvKeyAt(it.p, fd);
          if (k3) out.angles[k3] = (it.deg === 180) ? 2 : 0;
        }
      });
      Object.keys(hMap).forEach(function(c) { out.hinges.push(hMap[c]); });
      return out;
    },

    /* Pin the selected panel as the fold-tree base (replaces any old pin). */
    setFoldRoot: function() {
      var key = this.state.selectedPanel;
      if (!key) return;
      var p = this._panelCenter(key);
      if (!p) { this.showStatus('无法定位该面板，请重试'); return; }
      var items = (this.state.foldOv.items || []).filter(function(it) { return it.t !== 'root'; });
      items.unshift({ t: 'root', p: p, k: key });
      this._foldOvSave(items);
      this.showStatus('已把 ' + key + ' 设为固定面，切换 3D 预览生效');
    },

    /* Toggle a fold-direction flip on the selected panel. */
    toggleFoldFlip: function() {
      var key = this.state.selectedPanel;
      if (!key) return;
      var p = this._panelCenter(key);
      if (!p) { this.showStatus('无法定位该面板，请重试'); return; }
      var items = (this.state.foldOv.items || []).slice();
      var hit = -1;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.t === 'flip' && Math.hypot(it.p[0] - p[0], it.p[1] - p[1]) < 1) { hit = i; break; }
      }
      if (hit >= 0) {
        items.splice(hit, 1);
        this.showStatus('已取消 ' + key + ' 的折向翻转');
      } else {
        items.push({ t: 'flip', p: p, k: key });
        this.showStatus('已翻转 ' + key + ' 的折向，切换 3D 预览生效');
      }
      this._foldOvSave(items);
    },

    /* S3: the selected crease line becomes a forced hinge ("线→铰链") or a
     * banned fold ("线→禁止折叠"). Both are stored as GEOMETRY (the longest
     * straight segment of the line); the panel pair is re-resolved from that
     * geometry at map time, so a re-render never desyncs. */
    setCreaseHinge: function(ban) {
      var idx = this.state.selectedCrease;
      if (idx == null || !this.currentData || !this.currentData.creases) return;
      var line = this.currentData.creases[idx];
      var g = this._longestStraightSeg(line);
      if (!g) { this.showStatus('该压痕线无法解析出直线段'); return; }
      var fd = this._foldFd();
      if (!fd) { this.showStatus('无法解析面板几何'); return; }
      var pair = this._hingePairFromSeg(g, fd);
      if (!pair) { this.showStatus('无法从这条线的两侧解析出两个面板'); return; }
      var items = (this.state.foldOv.items || []).filter(function(it) {
        return !(it.t === 'hinge' && it.g && it.g.length === 4 &&
                 it.g[0] === g[0] && it.g[1] === g[1] && it.g[2] === g[2] && it.g[3] === g[3]);
      });
      if (ban) {
        items.push({ t: 'nofold', g: g, k: pair.parent + '|' + pair.child });
        this.showStatus('已禁止 ' + pair.parent + ' — ' + pair.child + ' 之间折叠，切换 3D 预览生效');
      } else {
        items.push({ t: 'hinge', g: g, k: pair.parent + '>' + pair.child });
        this.showStatus('已强制铰链 ' + pair.parent + ' → ' + pair.child + '，切换 3D 预览生效');
      }
      this._foldOvSave(items);
    },

    /* S3, two-step mode: pick panel A, press the button, pick panel B — the
     * panels' longest shared edge becomes a forced hinge. */
    beginLinkHinge: function() {
      var key = this.state.selectedPanel;
      if (!key) return;
      this.state.linkFrom = this.state.linkFrom ? null : key;
      if (!this.state.linkFrom) this.showStatus('已取消连接模式');
      this._foldSelStatus();
    },

    _addPanelHinge: function(ka, kb) {
      var fd = this._foldFd();
      if (!fd || !fd[ka] || !fd[kb]) { this.showStatus('无法解析面板几何'); return; }
      var g = this._sharedEdgeSeg(ka, kb, fd);
      if (!g) {
        this.showStatus(ka + ' 与 ' + kb + ' 没有共享边（容差 2mm），无法连铰链');
        return;
      }
      var items = (this.state.foldOv.items || []).filter(function(it) {
        return !(it.t === 'hinge' && it.g && it.g.length === 4 &&
                 it.g[0] === g[0] && it.g[1] === g[1] && it.g[2] === g[2] && it.g[3] === g[3]);
      });
      items.push({ t: 'hinge', g: g, k: ka + '>' + kb });
      this._foldOvSave(items);
      this.showStatus('已强制铰链 ' + ka + ' → ' + kb + '，切换 3D 预览生效');
    },

    /* S4: cycle the selected panel's fold angle 180° → 0° → default. */
    toggleFoldAngle: function() {
      var key = this.state.selectedPanel;
      if (!key) return;
      var p = this._panelCenter(key);
      if (!p) { this.showStatus('无法定位该面板，请重试'); return; }
      var items = (this.state.foldOv.items || []).slice();
      var hit = -1;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.t === 'angle' && Math.hypot(it.p[0] - p[0], it.p[1] - p[1]) < 1) { hit = i; break; }
      }
      if (hit < 0) {
        items.push({ t: 'angle', p: p, deg: 180, k: key });
        this.showStatus(key + ' 折叠角度 → 180°，切换 3D 预览生效');
      } else if (items[hit].deg === 180) {
        items[hit].deg = 0;
        this.showStatus(key + ' 折叠角度 → 0°（保持平展）');
      } else {
        items.splice(hit, 1);
        this.showStatus('已恢复 ' + key + ' 的默认折叠角度');
      }
      this._foldOvSave(items);
    },

    clearFoldOv: function() {
      this._foldOvSave([]);
      this.showStatus('已清除全部手动折叠调整');
    },

    /* Sidebar list of the current overrides, each with a delete button. */
    renderFoldOvList: function() {
      var el = document.getElementById('foldOvList');
      if (!el) return;
      var items = (this.state.foldOv && this.state.foldOv.items) || [];
      if (!items.length) {
        el.innerHTML = '<div class="fold-ov-empty">无手动调整</div>';
        return;
      }
      var html = '';
      items.forEach(function(it, i) {
        var label = it.t === 'root' ? '固定面'
          : it.t === 'flip' ? '翻转折向'
          : it.t === 'hinge' ? '强制铰链'
          : it.t === 'nofold' ? '禁止折叠'
          : it.t === 'angle' ? ('折叠 ' + it.deg + '°')
          : it.t;
        html += '<div class="fold-ov-item"><span>' + label +
          (it.k ? ' · ' + it.k : '') + '</span>' +
          '<button class="fold-ov-del" data-idx="' + i + '" title="删除">&times;</button></div>';
      });
      el.innerHTML = html;
    },

    /* ===== 3D preview ===== */
    render3D: function() {
      if (typeof Preview3D === 'undefined' || !Preview3D.render) return;
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      var container = document.getElementById('preview3d');
      if (!container) return;
      // Fold editor: hand the manual overrides to the 3D build before rendering.
      var _ov = this._foldOvMap(null);
      Preview3D._overrides = (_ov.root || _ov.flips.length || _ov.hinges.length ||
        _ov.nofolds.length || Object.keys(_ov.angles).length) ? _ov : null;
      // 3D picking: a short click (no drag) raycasts the panel mesh and routes
      // the hit through the same selector the 2D dieline uses, so the manual
      // fold editor sees a unified "selected panel" regardless of view.
      var self = this;
      Preview3D.onPanelClick = function(key) { self.selectPanel(key); };
      Preview3D.render(container, bt, this.state.params);
      var info = document.getElementById('boxInfo3D');
      if (info) {
        var p = this.state.params;
        var dims = [];
        if (p.L !== undefined) dims.push('L=' + p.L);
        if (p.W !== undefined) dims.push('W=' + p.W);
        if (p.D !== undefined) dims.push('D=' + p.D);
        var badge = bt.isLive ? '<span class="live-badge">实时</span>' : '<span class="default-badge">默认</span>';
        info.innerHTML = '<div class="info-title">' + bt.name + '</div>' +
          '<div>' + badge + '<span class="info-cat">' + bt.category + '</span></div>' +
          '<div>' + dims.join(' &middot; ') + ' mm</div>';
      }
    },

    switchView: function(mode) {
      this.state.viewMode = mode;
      var svg = document.getElementById('canvasContainer');
      var pv = document.getElementById('preview3d');
      var tb = document.getElementById('previewToolbar');
      var co = document.getElementById('canvasOverlay');
      var b2 = document.getElementById('btnView2D');
      var b3 = document.getElementById('btnView3D');
      if (mode === '3d') {
        if (svg) svg.style.display = 'none';
        if (pv) pv.style.display = 'block';
        if (tb) tb.style.display = 'flex';
        if (co) co.style.display = 'none';   // 2D hint would clash with the 3D bottom toolbar
        if (b2) b2.classList.remove('active');
        if (b3) b3.classList.add('active');
        this.render3D();
        var fs = document.getElementById('foldSlider');
        if (fs) fs.value = Math.round(Preview3D.foldProgress * 100);
      } else {
        if (svg) svg.style.display = '';
        if (pv) pv.style.display = 'none';
        if (tb) tb.style.display = 'none';
        if (co) co.style.display = '';
        if (b3) b3.classList.remove('active');
        if (b2) b2.classList.add('active');
        if (pv && typeof Preview3D !== 'undefined' && Preview3D._cleanup) Preview3D._cleanup(pv);
      }
    },

    _artFaceName: function(key) {
      var map = { M0: '正面', M5: '背面', M1: '左侧', M3: '右侧', M2: '顶面', M4: '底面' };
      return map[key] || key;
    },

    updateBoxInfo: function() {
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      var p = this.state.params;
      var info = document.getElementById('boxInfo');
      var dims = [];

      // Find L, W, D params
      if (p.L !== undefined) dims.push('L=' + p.L + 'mm');
      if (p.W !== undefined) dims.push('W=' + p.W + 'mm');
      if (p.D !== undefined) dims.push('D=' + p.D + 'mm');
      // Some boxes use different param names
      bt.params.forEach(function(param) {
        var key = param.key;
        if (key !== 'L' && key !== 'W' && key !== 'D' && key !== 'CAL' && key !== 'CHOOSE') {
          if (p[key] !== undefined) dims.push(key + '=' + p[key] + 'mm');
        }
      });

      if (this.currentData) {
        var bb = this.currentData.bbox;
        var w = parseFloat((bb.maxX - bb.minX).toFixed(1));
        var h = parseFloat((bb.maxY - bb.minY).toFixed(1));
        var area = (w * h / 100).toFixed(1);
        var liveBadge = bt.isLive ? '<span class="live-badge">实时</span>' : '<span class="default-badge">默认</span>';
        info.innerHTML =
          '<div class="info-title">' + bt.name + '</div>' +
          '<div>' + liveBadge + '<span class="info-cat">' + bt.category + '</span></div>' +
          '<div>' + dims.join(' &middot; ') + '</div>' +
          '<div>Unfold: ' + w + ' &times; ' + h + ' mm</div>' +
          '<div>Area: ' + area + ' cm&#178;</div>' +
          (this.state.compensation > 0 ? '<div>Comp: ' + this.state.compensation + 'mm</div>' : '');
      } else {
        info.innerHTML = '<div>' + dims.join(' &middot; ') + '</div>';
      }
    },

    // Build the box library browser with categories
    buildLibraryBrowser: function() {
      var container = document.getElementById('categoryList');
      if (!container) return;
      container.innerHTML = '';

      if (typeof PackmageBoxTypes === 'undefined') {
        container.innerHTML = '<div class="lib-empty">盒型数据未加载</div>';
        return;
      }

      var catalog = PackmageBoxTypes.getCatalog();
      var self = this;

      // Group boxes by category using bitmask tid
      // tid is a bitmask: bit N = belongs to category with idx=N
      // tid=0 means "free" (category 0 only)
      catalog.categories.forEach(function(cat) {
        var bitMask = cat.idx === 0 ? 0 : (1 << cat.idx);
        var boxes;
        if (cat.idx === 0) {
          // Category 0 (常用): boxes with tid=0 OR bit 0 set
          boxes = catalog.boxes.filter(function(b) {
            return b.tid === 0 || (b.tid & 1) !== 0;
          });
        } else {
          boxes = catalog.boxes.filter(function(b) {
            return (b.tid & bitMask) !== 0;
          });
        }
        if (!boxes || boxes.length === 0) return;

        var catDiv = document.createElement('div');
        catDiv.className = 'lib-category';

        var catHeader = document.createElement('div');
        catHeader.className = 'lib-cat-header';
        catHeader.innerHTML = '<span class="lib-cat-name">' + cat.name + '</span><span class="lib-cat-count">' + boxes.length + '</span>';
        catDiv.appendChild(catHeader);

        var boxList = document.createElement('div');
        boxList.className = 'lib-box-list';
        boxList.style.display = 'none';

        boxes.forEach(function(b) {
          var boxDiv = document.createElement('div');
          boxDiv.className = 'lib-box-item';
          if (PackmageBoxTypes.hasGeometry(b.id)) {
            boxDiv.classList.add('lib-box-available');
          } else {
            boxDiv.classList.add('lib-box-catalog');
          }
          var shortTag = b.tags ? b.tags.split(',')[0] : b.id;
          var thumbUrl = 'https://online.packmage.cn/Content/boximg/' + b.id + '-M.png';
          boxDiv.innerHTML =
            '<img class="lib-box-thumb" src="' + thumbUrl + '" loading="lazy" alt="" onerror="this.style.display=\'none\'">' +
            '<span class="lib-box-id">' + b.id + '</span>' +
            '<span class="lib-box-name">' + shortTag + '</span>' +
            (PackmageBoxTypes.hasGeometry(b.id) ? '<span class="lib-box-badge">Ready</span>' : '');
          boxDiv.addEventListener('click', function() {
            self.selectPackmageBox(b.id);
            if (self.closeDrawer) self.closeDrawer();
          });
          boxDiv.addEventListener('mouseenter', function(e) {
            self.showBoxPreview(b.id, shortTag, e.currentTarget);
          });
          boxDiv.addEventListener('mouseleave', function() {
            self.hideBoxPreview();
          });
          boxList.appendChild(boxDiv);
        });

        catHeader.addEventListener('click', function() {
          boxList.style.display = boxList.style.display === 'none' ? 'block' : 'none';
          catDiv.classList.toggle('lib-cat-expanded');
        });

        catDiv.appendChild(boxList);
        container.appendChild(catDiv);
      });
    },

    // Select a box from the packmage library by ID
    selectPackmageBox: function(boxId) {
      for (var i = 0; i < this.allBoxTypes.length; i++) {
        if (this.allBoxTypes[i].id === boxId) {
          this.selectBoxType(i);
          return;
        }
      }
      var info = document.getElementById('boxInfo');
      if (info) {
        info.innerHTML = '<div class="info-title">' + boxId + '</div><div class="info-warn">该盒型暂无可用几何数据。</div>';
      }
    },

    switchTab: function(tab) {
      var tabs = document.querySelectorAll('.panel-tab');
      tabs.forEach(function(t) { t.classList.remove('active'); });
      var tabBtn = document.querySelector('.panel-tab[data-tab="' + tab + '"]');
      if (tabBtn) tabBtn.classList.add('active');

      document.getElementById('tabLibrary').style.display = tab === 'library' ? 'block' : 'none';
      document.getElementById('tabParams').style.display = tab === 'params' ? 'block' : 'none';
      document.getElementById('tabThree').style.display = tab === 'threed' ? 'block' : 'none';
      if (tab === 'threed') this.switchView('3d');
      else if (tab === 'library' || tab === 'params') this.switchView('2d');
      if (tab !== 'library') this.hideBoxPreview();
    },

    // Generate SVG string from die-cut geometry for preview
    generateDieCutSVG: function(boxId) {
      if (typeof PackmageData === 'undefined' || !PackmageData.boxes[boxId]) return '';
      var b = PackmageData.boxes[boxId];
      if (!b.fe || b.fe.length === 0) return '';
      var data = PackmageBoxTypes.convertGeometry(b.fe, b.de.ox, b.de.oy);
      var bb = data.bbox;
      var w = bb.maxX - bb.minX;
      var h = bb.maxY - bb.minY;
      if (w <= 0 || h <= 0) return '';
      var pad = 5;
      var parts = [];
      // Cuts (red solid)
      data.cuts.forEach(function(line) {
        if (line.length < 2) return;
        var d = 'M' + line[0][0].toFixed(1) + ',' + line[0][1].toFixed(1);
        for (var i = 1; i < line.length; i++) d += 'L' + line[i][0].toFixed(1) + ',' + line[i][1].toFixed(1);
        parts.push('<path d="' + d + '" stroke="#e53e3e" stroke-width="0.8" fill="none"/>');
      });
      // Creases (blue dashed)
      data.creases.forEach(function(line) {
        if (line.length < 2) return;
        var d = 'M' + line[0][0].toFixed(1) + ',' + line[0][1].toFixed(1);
        for (var i = 1; i < line.length; i++) d += 'L' + line[i][0].toFixed(1) + ',' + line[i][1].toFixed(1);
        parts.push('<path d="' + d + '" stroke="#3182ce" stroke-width="0.5" fill="none" stroke-dasharray="2,1"/>');
      });
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
        (bb.minX - pad) + ' ' + (bb.minY - pad) + ' ' + (w + pad * 2) + ' ' + (h + pad * 2) +
        '" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">' +
        '<rect x="' + (bb.minX - pad) + '" y="' + (bb.minY - pad) +
        '" width="' + (w + pad * 2) + '" height="' + (h + pad * 2) + '" fill="#fafafa"/>' +
        parts.join('') + '</svg>';
      return svg;
    },

    // Show larger preview tooltip for a box in the library
    showBoxPreview: function(boxId, boxName, targetEl) {
      var tooltip = document.getElementById('boxPreviewTooltip');
      if (!tooltip || !targetEl) return;

      // Build tooltip content: SVG die-cut preview + packmage thumbnail
      var svgHTML = this.generateDieCutSVG(boxId);
      var thumbUrl = 'https://online.packmage.cn/Content/boximg/' + boxId + '-M.png';

      tooltip.innerHTML =
        '<div class="tooltip-section">' +
          '<div class="tooltip-label">Die-Cut Preview</div>' +
          '<div class="tooltip-svg">' + (svgHTML || '<span class="tooltip-nodata">暂无几何数据</span>') + '</div>' +
        '</div>' +
        '<div class="tooltip-section">' +
          '<div class="tooltip-label">盒型参考图</div>' +
          '<img class="tooltip-thumb" src="' + thumbUrl + '" alt="" onerror="this.parentElement.style.display=\'none\'">' +
        '</div>' +
        '<div class="tooltip-id">' + boxId + ' &middot; ' + boxName + '</div>';

      tooltip.classList.remove('hidden');

      // Position tooltip to the right of the panel (floating outside)
      var rect = targetEl.getBoundingClientRect();
      var panelRect = document.getElementById('paramPanel').getBoundingClientRect();
      var tooltipW = 280;
      var tooltipH = tooltip.offsetHeight || 400;

      // Try right side first, then left
      var left = rect.right + 8;
      if (left + tooltipW > window.innerWidth - 10) {
        left = rect.left - tooltipW - 8;
      }
      if (left < 10) left = 10;

      var top = rect.top - 10;
      if (top + tooltipH > window.innerHeight - 10) {
        top = window.innerHeight - tooltipH - 10;
      }
      if (top < 10) top = 10;

      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
    },

    hideBoxPreview: function() {
      var tooltip = document.getElementById('boxPreviewTooltip');
      if (tooltip) tooltip.classList.add('hidden');
    },

    bindEvents: function() {
      var self = this;

      // Export buttons
      document.getElementById('btnExportSVG').addEventListener('click', function() {
        if (!self.currentData) return;
        var bt = self.allBoxTypes[self.state.boxTypeIndex];
        Exporter.exportSVG(self.currentData, bt.id);
      });

      document.getElementById('btnExportDXF').addEventListener('click', function() {
        if (!self.currentData) return;
        var bt = self.allBoxTypes[self.state.boxTypeIndex];
        Exporter.exportDXF(self.currentData, bt.id);
      });

      document.getElementById('btnExportPDF').addEventListener('click', function() {
        if (!self.currentData) return;
        var bt = self.allBoxTypes[self.state.boxTypeIndex];
        Exporter.exportPDF(self.currentData, bt.id);
      });

      // Display options
      document.getElementById('chkDimensions').addEventListener('change', function() {
        self.state.showDims = this.checked;
        self.render();
      });

      document.getElementById('chkGrid').addEventListener('change', function() {
        self.state.showGrid = this.checked;
        self.render();
      });

      document.getElementById('chkLabels').addEventListener('change', function() {
        self.state.showLabels = this.checked;
        self.render();
      });

      document.getElementById('chkPanels').addEventListener('change', function() {
        self.state.showPanels = this.checked;
        self.render();
      });

      // Paper thickness compensation — sends CAL param to packmage API
      document.getElementById('chkCompensation').addEventListener('change', function() {
        var thickness = parseFloat(document.getElementById('paperThickness').value);
        self.state.compensation = this.checked ? thickness : 0;
        self.state.params.CAL = this.checked ? thickness : 0;
        document.getElementById('paperThickness').disabled = !this.checked;
        self.scheduleParamUpdate();
        self.updateBoxInfo();
      });

      document.getElementById('paperThickness').addEventListener('change', function() {
        if (document.getElementById('chkCompensation').checked) {
          var thickness = parseFloat(this.value);
          self.state.compensation = thickness;
          self.state.params.CAL = thickness;
          self.scheduleParamUpdate();
          self.updateBoxInfo();
        }
      });

      // Zoom controls
      document.getElementById('btnZoomIn').addEventListener('click', function() {
        self.renderer.setZoom(self.renderer.zoom * 1.2);
      });

      document.getElementById('btnZoomOut').addEventListener('click', function() {
        self.renderer.setZoom(self.renderer.zoom / 1.2);
      });

      document.getElementById('btnZoomFit').addEventListener('click', function() {
        self.renderer.fit();
      });

      document.getElementById('btnZoom100').addEventListener('click', function() {
        self.renderer.setZoom(1);
      });

      // Reset params
      document.getElementById('btnResetParams').addEventListener('click', function() {
        self.selectBoxType(self.state.boxTypeIndex);
      });

      // Tab switching
      document.querySelectorAll('.panel-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          self.switchTab(this.dataset.tab);
          if (self.closeDrawer) self.closeDrawer();
        });
      });

      // Mobile slide-in drawer (left panel becomes a drawer on narrow screens)
      self.closeDrawer = function() {
        var pp = document.getElementById('paramPanel');
        var bd = document.getElementById('panelBackdrop');
        if (pp) pp.classList.remove('open');
        if (bd) bd.classList.remove('show');
      };
      var btnMenu = document.getElementById('btnMenu');
      var panelBackdrop = document.getElementById('panelBackdrop');
      if (btnMenu) btnMenu.addEventListener('click', function() {
        var pp = document.getElementById('paramPanel');
        if (!pp) return;
        var isOpen = pp.classList.toggle('open');
        if (panelBackdrop) panelBackdrop.classList.toggle('show', isOpen);
      });
      if (panelBackdrop) panelBackdrop.addEventListener('click', function() { self.closeDrawer(); });

      // View switch (2D / 3D)
      document.getElementById('btnView2D').addEventListener('click', function() { self.switchView('2d'); });
      document.getElementById('btnView3D').addEventListener('click', function() {
        self.switchTab('threed');
        self.switchView('3d');
        if (self.closeDrawer) self.closeDrawer();
      });

      // Artwork (贴图): upload + face select + clear
      var artUpload = document.getElementById('artUpload');
      if (artUpload) {
        artUpload.addEventListener('change', function() {
          var file = this.files && this.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function(e) {
            Preview3D.setFaceTexture(self.state.artFace, e.target.result);
            self.showStatus('已贴图到「' + self._artFaceName(self.state.artFace) + '」');
          };
          reader.readAsDataURL(file);
        });
      }
      document.querySelectorAll('.art-face-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.art-face-btn').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          self.state.artFace = btn.dataset.face;
          var st = document.getElementById('artFaceStatus');
          if (st) st.textContent = '当前面：' + btn.textContent;
        });
      });
      document.getElementById('btnClearArt').addEventListener('click', function() {
        Preview3D.clearFaceTextures();
        self.showStatus('已清除全部贴图');
      });

      // Manual fold editor buttons (2D 侧栏「折叠调整」)
      var bFoldRoot = document.getElementById('btnSetRoot');
      var bFoldFlip = document.getElementById('btnFlipHinge');
      var bFoldClr = document.getElementById('btnClearFoldOv');
      var bCreaseHinge = document.getElementById('btnCreaseHinge');
      var bCreaseNofold = document.getElementById('btnCreaseNofold');
      var bLinkHinge = document.getElementById('btnLinkHinge');
      var bFoldAngle = document.getElementById('btnFoldAngle');
      if (bFoldRoot) bFoldRoot.addEventListener('click', function() { self.setFoldRoot(); });
      if (bFoldFlip) bFoldFlip.addEventListener('click', function() { self.toggleFoldFlip(); });
      if (bFoldClr) bFoldClr.addEventListener('click', function() { self.clearFoldOv(); });
      if (bCreaseHinge) bCreaseHinge.addEventListener('click', function() { self.setCreaseHinge(false); });
      if (bCreaseNofold) bCreaseNofold.addEventListener('click', function() { self.setCreaseHinge(true); });
      if (bLinkHinge) bLinkHinge.addEventListener('click', function() { self.beginLinkHinge(); });
      if (bFoldAngle) bFoldAngle.addEventListener('click', function() { self.toggleFoldAngle(); });
      var ovListEl = document.getElementById('foldOvList');
      if (ovListEl) ovListEl.addEventListener('click', function(e) {
        var btn = e.target.closest ? e.target.closest('.fold-ov-del') : null;
        if (!btn) return;
        var i = parseInt(btn.getAttribute('data-idx'), 10);
        var items = (self.state.foldOv.items || []).slice();
        if (i >= 0 && i < items.length) {
          items.splice(i, 1);
          self._foldOvSave(items);
        }
      });

      // Fold animation (3D折叠) — 点击"播放"循环折叠/展开(ping-pong)，再次点击暂停
      var foldSlider = document.getElementById('foldSlider');
      var btnFoldPlay = document.getElementById('btnFoldPlay');
      var foldPlaying = false, foldRAF = null;
      function foldStopPlay() {
        foldPlaying = false;
        if (foldRAF) { cancelAnimationFrame(foldRAF); foldRAF = null; }
        if (btnFoldPlay) { btnFoldPlay.innerHTML = '&#9654; 播放'; btnFoldPlay.classList.remove('pt-playing'); }
      }
      function foldStartPlay() {
        if (foldPlaying) return;
        foldPlaying = true;
        if (btnFoldPlay) { btnFoldPlay.innerHTML = '&#9208; 暂停'; btnFoldPlay.classList.add('pt-playing'); }
        if (foldSlider) foldSlider.value = 0;
        Preview3D.setFold(0);
        var startT = performance.now(), dur = 1500, hold = 450;
        var cycle = 2 * dur + 2 * hold;   // 合拢 → 停顿 → 展开 → 停顿
        function step(t) {
          if (!foldPlaying) return;
          var tt = (t - startT) % cycle;
          var prog;
          if (tt < dur) prog = tt / dur;                                  // 合拢 0→1
          else if (tt < dur + hold) prog = 1;                            // 保持合拢
          else if (tt < 2 * dur + hold) prog = 1 - (tt - dur - hold) / dur; // 展开 1→0
          else prog = 0;                                                 // 保持展开
          Preview3D.setFold(prog);
          if (foldSlider) foldSlider.value = Math.round(prog * 100);
          foldRAF = requestAnimationFrame(step);
        }
        foldRAF = requestAnimationFrame(step);
      }
      if (foldSlider) {
        foldSlider.addEventListener('input', function() {
          foldStopPlay();
          Preview3D.setFold(parseInt(this.value, 10) / 100);
        });
      }
      if (btnFoldPlay) {
        btnFoldPlay.addEventListener('click', function() {
          if (foldPlaying) foldStopPlay(); else foldStartPlay();
        });
      }

      var btnViewReset = document.getElementById('btnViewReset');
      if (btnViewReset) btnViewReset.addEventListener('click', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D._viewReset) Preview3D._viewReset();
      });
      var btnZoomIn3 = document.getElementById('btnZoomIn3');
      if (btnZoomIn3) btnZoomIn3.addEventListener('click', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D._viewZoom) Preview3D._viewZoom(1.15);
      });
      var btnZoomOut3 = document.getElementById('btnZoomOut3');
      if (btnZoomOut3) btnZoomOut3.addEventListener('click', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D._viewZoom) Preview3D._viewZoom(1 / 1.15);
      });

      // packmage-style view presets (展开/正面/左面/背面/右面/顶部/底部)
      var presetButtons = document.querySelectorAll('#viewPresetGroup .pt-preset');
      function clearPresetActive() {
        presetButtons.forEach(function(b) { b.classList.remove('pt-active'); });
      }
      function setPresetActive(name) {
        clearPresetActive();
        var btn = document.querySelector('#viewPresetGroup .pt-preset[data-preset="' + name + '"]');
        if (btn) btn.classList.add('pt-active');
      }
      presetButtons.forEach(function(btn) {
        btn.addEventListener('click', function() {
          var name = this.getAttribute('data-preset');
          if (typeof Preview3D !== 'undefined' && Preview3D.setViewPreset) {
            Preview3D.setViewPreset(name);
          }
          setPresetActive(name);
        });
      });
      // Keep the preset highlighted when the user picks one from the toolbar;
      // a manual drag clears it (handled in preview3d via _currentPreset).
      if (typeof Preview3D !== 'undefined') {
        Preview3D._presetChanged = function(name) { setPresetActive(name); };
      }

      // Display mode (彩样/白样/骨架线)
      var modeButtons = document.querySelectorAll('#displayModeGroup .seg-btn');
      modeButtons.forEach(function(btn) {
        btn.addEventListener('click', function() {
          modeButtons.forEach(function(b) { b.classList.remove('active'); });
          this.classList.add('active');
          var mode = this.getAttribute('data-mode');
          if (typeof Preview3D !== 'undefined' && Preview3D.setDisplayMode) Preview3D.setDisplayMode(mode);
        });
      });

      // Paper colour swatches
      var swatches = document.querySelectorAll('#paperColorGroup .swatch');
      swatches.forEach(function(sw) {
        sw.addEventListener('click', function() {
          swatches.forEach(function(s) { s.classList.remove('active'); });
          this.classList.add('active');
          var hex = this.getAttribute('data-color');
          if (typeof Preview3D !== 'undefined' && Preview3D.setPaperColor) Preview3D.setPaperColor(parseInt(hex.slice(1), 16));
        });
      });

      // Grain on/off
      var chkGrain = document.getElementById('chkGrain');
      if (chkGrain) chkGrain.addEventListener('change', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D.setPaperGrain) Preview3D.setPaperGrain(this.checked);
      });

      // Light intensity
      var lightSlider = document.getElementById('lightSlider');
      if (lightSlider) lightSlider.addEventListener('input', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D.setLightIntensity) Preview3D.setLightIntensity(parseInt(this.value, 10) / 100);
      });

      // Background colour
      var bgButtons = document.querySelectorAll('#bgColorGroup .bg-btn');
      bgButtons.forEach(function(btn) {
        btn.addEventListener('click', function() {
          bgButtons.forEach(function(b) { b.classList.remove('active'); });
          this.classList.add('active');
          var bg = this.getAttribute('data-bg');
          if (typeof Preview3D !== 'undefined' && Preview3D.setBackgroundColor) Preview3D.setBackgroundColor(bg);
        });
      });

      // Fold step buttons (packmage 前进/后退): fold one assembly stage at a time
      var btnFoldBack = document.getElementById('btnFoldBack');
      var btnFoldFwd = document.getElementById('btnFoldFwd');
      function foldStep(dir) {
        foldStopPlay();
        var n = (Preview3D && Preview3D._stageCount) || 1;
        var cur = (Preview3D && Preview3D.foldProgress) || 0;
        var next = Math.max(0, Math.min(1, cur + dir / n));
        Preview3D.setFold(next);
        if (foldSlider) foldSlider.value = Math.round(next * 100);
      }
      if (btnFoldFwd) btnFoldFwd.addEventListener('click', function() { foldStep(1); });
      if (btnFoldBack) btnFoldBack.addEventListener('click', function() { foldStep(-1); });

      // Search
      var searchInput = document.getElementById('boxSearch');
      if (searchInput) {
        searchInput.addEventListener('input', function() {
          var q = this.value.trim().toLowerCase();
          var items = document.querySelectorAll('.lib-box-item');
          var cats = document.querySelectorAll('.lib-category');
          cats.forEach(function(cat) {
            var hasVisible = false;
            var boxItems = cat.querySelectorAll('.lib-box-item');
            boxItems.forEach(function(item) {
              var id = item.querySelector('.lib-box-id').textContent.toLowerCase();
              var name = item.querySelector('.lib-box-name').textContent.toLowerCase();
              if (!q || id.indexOf(q) >= 0 || name.indexOf(q) >= 0) {
                item.style.display = '';
                hasVisible = true;
              } else {
                item.style.display = 'none';
              }
            });
            cat.style.display = hasVisible ? '' : 'none';
            if (q && hasVisible) {
              var boxList = cat.querySelector('.lib-box-list');
              if (boxList) boxList.style.display = 'block';
              cat.classList.add('lib-cat-expanded');
            }
          });
        });
      }

      // Keyboard shortcuts
      document.addEventListener('keydown', function(e) {
        if (e.target.tagName === 'INPUT') return;
        switch (e.key) {
          case 'f': case 'F':
            self.renderer.fit();
            break;
          case '+': case '=':
            self.renderer.setZoom(self.renderer.zoom * 1.2);
            break;
          case '-':
            self.renderer.setZoom(self.renderer.zoom / 1.2);
            break;
          case '0':
            self.renderer.setZoom(1);
            break;
          case 'Escape':
            // Close any open modal here if needed
            break;
        }
      });
    },
  };

  // Expose for debugging
  if (typeof window !== 'undefined') window.App = App;

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { App.init(); });
  } else {
    App.init();
  }
})();
