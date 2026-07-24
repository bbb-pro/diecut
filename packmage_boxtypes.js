/*
 * packmage_boxtypes.js — Packmage box library integration
 *
 * Converts packmage.cn API data to the DieCut Designer renderer format.
 * Supports dynamic parameter changes via API proxy.
 *
 * Data format (fe array):
 *   [0, style, x1, y1, x2, y2]       — Line segment (style: 1=cut, 0=crease)
 *   [1, style, cx, cy, r, sa, ea]    — Arc (center, radius, start/end angle in degrees)
 *   [2, style, x1, y1, x2, y2, ...]  — Polyline
 */

/* ===== Geometry cache (in-memory) ===== */
var _geometryCache = {};

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
      if (style === 1) cuts.push(line);
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
      if (style === 1) cuts.push(points);
      else creases.push(points);
    } else if (type === 2) {
      var pts = [];
      for (var j = 2; j < e.length; j += 2) {
        pts.push([e[j] + absOx, e[j + 1] + absOy]);
      }
      if (pts.length >= 2) {
        if (style === 1) cuts.push(pts);
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

  return {
    cuts: cuts,
    creases: creases,
    dimensions: [],
    labels: [],
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
