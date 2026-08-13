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
    },
    renderer: null,
    currentData: null,
    allBoxTypes: [],
    paramUpdateTimer: null,
    isLoadingGeometry: false,

    init: function() {
      var svg = document.getElementById('diecutSvg');
      this.renderer = new Renderer(svg);
      this.renderer.resize();
      this.renderer.initInteraction(document.getElementById('canvasContainer'));

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

      var self = this;
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

      this.renderer.setOptions({
        showDims: this.state.showDims,
        showGrid: this.state.showGrid,
        showLabels: this.state.showLabels,
      });
      this.renderer.render(data);
    },

    /* ===== 3D preview ===== */
    render3D: function() {
      if (typeof Preview3D === 'undefined' || !Preview3D.render) return;
      var bt = this.allBoxTypes[this.state.boxTypeIndex];
      var container = document.getElementById('preview3d');
      if (!container) return;
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
      var b2 = document.getElementById('btnView2D');
      var b3 = document.getElementById('btnView3D');
      if (mode === '3d') {
        if (svg) svg.style.display = 'none';
        if (pv) pv.style.display = 'block';
        if (tb) tb.style.display = 'flex';
        if (b2) b2.classList.remove('active');
        if (b3) b3.classList.add('active');
        this.render3D();
        var fs = document.getElementById('foldSlider');
        if (fs) fs.value = Math.round(Preview3D.foldProgress * 100);
      } else {
        if (svg) svg.style.display = '';
        if (pv) pv.style.display = 'none';
        if (tb) tb.style.display = 'none';
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
        });
      });

      // View switch (2D / 3D)
      document.getElementById('btnView2D').addEventListener('click', function() { self.switchView('2d'); });
      document.getElementById('btnView3D').addEventListener('click', function() {
        self.switchTab('threed');
        self.switchView('3d');
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

      // Fold animation (3D折叠)
      var foldSlider = document.getElementById('foldSlider');
      if (foldSlider) {
        foldSlider.addEventListener('input', function() {
          Preview3D.setFold(parseInt(this.value, 10) / 100);
        });
      }
      document.getElementById('btnFoldPlay').addEventListener('click', function() {
        var slider = document.getElementById('foldSlider');
        if (slider) slider.value = 0;
        Preview3D.setFold(0);
        var startT = performance.now(), dur = 1300;
        function step(t) {
          var k = Math.min(1, (t - startT) / dur);
          var prog = k;
          Preview3D.setFold(prog);
          if (slider) slider.value = Math.round(prog * 100);
          if (k < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });

      var btnViewReset = document.getElementById('btnViewReset');
      if (btnViewReset) btnViewReset.addEventListener('click', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D._viewReset) Preview3D._viewReset();
      });
      var btnZoomIn3 = document.getElementById('btnZoomIn3');
      if (btnZoomIn3) btnZoomIn3.addEventListener('click', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D._viewZoom) Preview3D._viewZoom(1 / 1.15);
      });
      var btnZoomOut3 = document.getElementById('btnZoomOut3');
      if (btnZoomOut3) btnZoomOut3.addEventListener('click', function() {
        if (typeof Preview3D !== 'undefined' && Preview3D._viewZoom) Preview3D._viewZoom(1.15);
      });

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
