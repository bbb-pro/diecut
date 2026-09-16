/*
 * exporter.js — Г÷╒И┤▐Ф√┤Д╩╤Е╞╪Е┤╨Ф╗║Е²≈
 * Ф■╞Ф▄│: SVG / DXF / PDF Д╦┴Г╖█Ф═╪Е╪▐
 * Г╨©Ф²║Х╖└Х▄┐: Хё│Е┬┤Г╨©=Е╝·Г╨©, Е▌▀Г≈∙Г╨©=Х≥ Г╨©
 * Г╨╞Г╨©Г╗©Е╥╔Г╗▀Ф√┤Д╩╤, Ф≈═Е╓ Д╫≥Х┴╡Е²≈
 */

var Exporter = {};

/* ===== Download helper ===== */
function downloadFile(filename, content, mime) {
  var blob;
  if (content instanceof Blob) {
    blob = content;
  } else {
    blob = new Blob([content], { type: mime || 'application/octet-stream' });
  }
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 100);
}

/* ===== SVG Export ===== */
Exporter.exportSVG = function(data, boxName) {
  var bb = data.bbox;
  var pad = 5;
  var minX = Math.floor(bb.minX - pad);
  var minY = Math.floor(bb.minY - pad);
  var w = Math.ceil(bb.maxX - bb.minX + pad * 2);
  var h = Math.ceil(bb.maxY - bb.minY + pad * 2);

  var lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<svg xmlns="http://www.w3.org/2000/svg" ' +
    'width="' + w + 'mm" height="' + h + 'mm" ' +
    'viewBox="' + minX + ' ' + minY + ' ' + w + ' ' + h + '">');

  // Metadata
  lines.push('<!-- DieCut Template: ' + boxName + ' -->');
  lines.push('<!-- Cut lines: solid stroke #FF0000 -->');
  lines.push('<!-- Crease lines: dashed stroke #0000FF -->');
  lines.push('<!-- Units: millimeters (mm) -->');

  // Cut lines (solid red)
  lines.push('<g id="cut-lines" stroke="#FF0000" stroke-width="0.6" fill="none">');
  data.cuts.forEach(function(poly) {
    var pts = poly.map(function(p) { return p[0].toFixed(3) + ',' + p[1].toFixed(3); }).join(' ');
    lines.push('  <polyline points="' + pts + '"/>');
  });
  lines.push('</g>');

  // Crease lines (dashed blue)
  lines.push('<g id="crease-lines" stroke="#0000FF" stroke-width="0.4" fill="none" stroke-dasharray="3,2">');
  data.creases.forEach(function(poly) {
    var pts = poly.map(function(p) { return p[0].toFixed(3) + ',' + p[1].toFixed(3); }).join(' ');
    lines.push('  <polyline points="' + pts + '"/>');
  });
  lines.push('</g>');

  lines.push('</svg>');

  var content = lines.join('\n');
  downloadFile((boxName || 'diecut') + '.svg', content, 'image/svg+xml');
};

/* ===== DXF Export (R12 format, POLYLINE/VERTEX entities) ===== */
Exporter.exportDXF = function(data, boxName) {
  var L = [];

  function group(code, value) {
    L.push(String(code));
    L.push(String(value));
  }

  // -- HEADER --
  group(0, 'SECTION');
  group(2, 'HEADER');
  group(9, '$ACADVER');
  group(1, 'AC1009');
  group(9, '$INSBASE');
  group(10, 0);
  group(20, 0);
  group(30, 0);
  group(9, '$EXTMIN');
  group(10, 0);
  group(20, 0);
  group(9, '$EXTMAX');
  group(10, 0);
  group(20, 0);
  group(9, '$INSUNITS');
  group(70, 4);
  group(0, 'ENDSEC');

  // -- TABLES --
  group(0, 'SECTION');
  group(2, 'TABLES');

  // LTYPE table (must come before LAYER — LAYER references linetype names)
  group(0, 'TABLE');
  group(2, 'LTYPE');
  group(70, 2);

  group(0, 'LTYPE');
  group(2, 'CONTINUOUS');
  group(70, 0);
  group(3, 'Solid line');
  group(72, 65);
  group(73, 0);
  group(40, 0);

  group(0, 'LTYPE');
  group(2, 'DASHED');
  group(70, 0);
  group(3, '__ __ __ __ __ __ __ __ __ __ __ __ __ _');
  group(72, 65);
  group(73, 2);
  group(40, 6);
  group(49, 3);
  group(49, -3);

  group(0, 'ENDTAB');

  // LAYER table
  group(0, 'TABLE');
  group(2, 'LAYER');
  group(70, 2);

  group(0, 'LAYER');
  group(2, 'CUT');
  group(70, 0);
  group(62, 1);
  group(6, 'CONTINUOUS');

  group(0, 'LAYER');
  group(2, 'CREASE');
  group(70, 0);
  group(62, 5);
  group(6, 'DASHED');

  group(0, 'ENDTAB');
  group(0, 'ENDSEC');

  // -- BLOCKS (empty but present for compliance) --
  group(0, 'SECTION');
  group(2, 'BLOCKS');
  group(0, 'ENDSEC');

  // -- ENTITIES --
  group(0, 'SECTION');
  group(2, 'ENTITIES');

  // Cut lines: POLYLINE + VERTEX + SEQEND (R12 standard entities)
  data.cuts.forEach(function(poly) {
    if (poly.length < 2) return;
    group(0, 'POLYLINE');
    group(8, 'CUT');
    group(66, 1);   // vertices follow flag
    group(70, 0);   // open polyline
    for (var i = 0; i < poly.length; i++) {
      group(0, 'VERTEX');
      group(8, 'CUT');
      group(10, poly[i][0].toFixed(3));
      group(20, poly[i][1].toFixed(3));
      group(30, 0);
    }
    group(0, 'SEQEND');
    group(8, 'CUT');
  });

  // Crease lines
  data.creases.forEach(function(poly) {
    if (poly.length < 2) return;
    group(0, 'POLYLINE');
    group(8, 'CREASE');
    group(66, 1);
    group(70, 0);
    for (var j = 0; j < poly.length; j++) {
      group(0, 'VERTEX');
      group(8, 'CREASE');
      group(10, poly[j][0].toFixed(3));
      group(20, poly[j][1].toFixed(3));
      group(30, 0);
    }
    group(0, 'SEQEND');
    group(8, 'CREASE');
  });

  group(0, 'ENDSEC');
  group(0, 'EOF');

  var content = L.join('\r\n');
  downloadFile((boxName || 'diecut') + '.dxf', content, 'application/dxf');
};

/* ===== PDF Export (minimal vector PDF) ===== */
Exporter.exportPDF = function(data, boxName) {
  var bb = data.bbox;
  var pad = 5;
  var mmToPt = 72 / 25.4; // 1mm = 2.8346 pt

  // Page size in points
  var pageW = (bb.maxX - bb.minX + pad * 2) * mmToPt;
  var pageH = (bb.maxY - bb.minY + pad * 2) * mmToPt;
  var offsetX = -bb.minX + pad;
  var offsetY = -bb.minY + pad;

  // Build content stream
  var stream = [];

  // Helper: convert mm coords to PDF points (flip Y)
  function toPt(x, y) {
    var px = (x + offsetX) * mmToPt;
    var py = pageH - (y + offsetY) * mmToPt;
    return [px.toFixed(2), py.toFixed(2)];
  }

  // Cut lines: solid, red
  stream.push('0.6 w'); // line width 0.6pt
  stream.push('1 0 0 RG'); // red stroke
  stream.push('[] 0 d'); // solid
  data.cuts.forEach(function(poly) {
    if (poly.length < 2) return;
    for (var i = 0; i < poly.length; i++) {
      var pt = toPt(poly[i][0], poly[i][1]);
      if (i === 0) stream.push(pt[0] + ' ' + pt[1] + ' m');
      else stream.push(pt[0] + ' ' + pt[1] + ' l');
    }
    stream.push('S');
  });

  // Crease lines: dashed, blue
  stream.push('0.4 w');
  stream.push('0 0 1 RG'); // blue stroke
  stream.push('[6 3] 0 d'); // dashed pattern (6pt on, 3pt off)
  data.creases.forEach(function(poly) {
    if (poly.length < 2) return;
    for (var i = 0; i < poly.length; i++) {
      var pt = toPt(poly[i][0], poly[i][1]);
      if (i === 0) stream.push(pt[0] + ' ' + pt[1] + ' m');
      else stream.push(pt[0] + ' ' + pt[1] + ' l');
    }
    stream.push('S');
  });

  var streamStr = stream.join('\n');

  // Build PDF
  var objects = [];
  var offsets = [];

  // Object 1: Catalog
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');

  // Object 2: Pages
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');

  // Object 3: Page
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
    pageW.toFixed(2) + ' ' + pageH.toFixed(2) + '] ' +
    '/Contents 4 0 R /Resources << >> >>');

  // Object 4: Content stream
  objects.push('<< /Length ' + streamStr.length + ' >>\nstream\n' + streamStr + '\nendstream');

  // Build PDF string
  var pdf = '%PDF-1.4\n';
  for (var i = 0; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }

  // Xref
  var xrefOffset = pdf.length;
  pdf += 'xref\n';
  pdf += '0 ' + (objects.length + 1) + '\n';
  pdf += '0000000000 65535 f \n';
  for (var j = 0; j < offsets.length; j++) {
    pdf += ('0000000000' + offsets[j]).slice(-10) + ' 00000 n \n';
  }

  // Trailer
  pdf += 'trailer\n';
  pdf += '<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
  pdf += 'startxref\n';
  pdf += xrefOffset + '\n';
  pdf += '%%EOF';

  // Convert to Uint8Array for binary safety
  var bytes = new Uint8Array(pdf.length);
  for (var k = 0; k < pdf.length; k++) bytes[k] = pdf.charCodeAt(k);
  var blob = new Blob([bytes], { type: 'application/pdf' });
  downloadFile((boxName || 'diecut') + '.pdf', blob);
};

if (typeof window !== 'undefined') window.Exporter = Exporter;
