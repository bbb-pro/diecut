/*
 * boxTypes.js — FEFCO standard box type library with ArtiosCAD formulas
 *
 * Variable system based on ArtiosCAD / FEFCO standard:
 *   Inputs:   L (Length), W (Width), D (Depth/Height)
 *   Constants:
 *     CAL = Cut Allowance (knife line compensation)   default 0.5 mm
 *     IL  = Insertion Length (insertion allowance)     default 1.5 mm
 *     CR  = Corner Radius                              default 2 mm
 *     SB2 = Slot Base offset                            default 2 mm
 *     SO  = Sheet Offset                               default 0 mm
 *     SOL = Sheet Offset Lid                            default 0 mm
 *     OG  = Over Glue                                  default 0 mm
 *     O2  = Offset 2                                   default 0 mm
 *     EFW = End Flap Width                              default 5 mm
 *     JW  = Joint Width (glue tab width)               default 8 mm
 *
 * draw() returns:
 *   cuts:       [[[x,y],...], ...]  cut lines (solid red)
 *   creases:    [[[x,y],...], ...]  crease lines (dashed blue)
 *   dimensions: [{type,x1,y1,x2,y2,label,offset}, ...]
 *   labels:     [{x,y,text,rotation}, ...]
 *   bbox:       {minX,minY,maxX,maxY}
 */

/* ===== ArtiosCAD standard constants ===== */
var AC = {
  CAL: 0.5,    // Cut Allowance / knife line compensation
  IL:  1.5,    // Insertion Length allowance
  CR:  2,      // Corner Radius
  SB2: 2,      // Slot Base offset
  SO:  0,      // Sheet Offset
  SOL: 0,      // Sheet Offset (Lid)
  OG:  0,      // Over Glue
  O2:  0,      // Offset 2
  EFW: 5,      // End Flap Width
  JW:  8,      // Joint / Glue tab Width
};

/* ===== Helpers ===== */
function dimH(x1, x2, y, label, offset) {
  return { type: 'h', x1: x1, y1: y, x2: x2, y2: y, label: label, offset: offset };
}
function dimV(y1, y2, x, label, offset) {
  return { type: 'v', x1: x, y1: y1, x2: x, y2: y2, label: label, offset: offset };
}
function lbl(x, y, text) {
  return { x: x, y: y, text: text, rotation: 0 };
}

/* Round to 1 decimal for display */
function r1(v) { return Math.round(v * 10) / 10; }

/* ==================================================================
 * FEFCO 0201 — Regular Slotted Container (RSC)
 * Most common corrugated box. All flaps are equal length (W/2 + IL).
 *
 * Layout (horizontal):
 *   [Glue G][Back L][Side W][Front L][Side W]
 * Vertical:
 *   [Top flaps (height=FL)] [Body (height=D)] [Bottom flaps (height=FL)]
 *   FL = W/2 + IL
 *
 * Cuts: outer rectangle + vertical slits between flaps (top & bottom)
 * Creases: vertical panel boundaries (body only) + horizontal fold lines
 * ================================================================== */
function draw0201(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var G  = p.G;
  var FL = p.FL;  // W/2 + IL

  var x0 = 0;
  var xG = G;                    // glue tab right / Back left
  var x1 = G + L;                // Back right / Side1 left
  var x2 = G + L + W;            // Side1 right / Front left
  var x3 = G + 2 * L + W;        // Front right / Side2 left
  var x4 = G + 2 * L + 2 * W;    // right edge

  var yTop = 0;                  // top of flaps
  var yBT  = FL;                 // body top (fold line)
  var yBB  = FL + D;             // body bottom (fold line)
  var yBot = FL + D + FL;        // bottom of flaps

  var ga = Math.min(G * 0.3, 3); // glue tab angle offset

  // Outer outline: rectangle with glue tab on left
  var outline = [
    [xG, yTop],                    // top-left of Back top flap
    [x4, yTop],                    // top-right
    [x4, yBot],                    // bottom-right
    [xG, yBot],                    // bottom-left of Side2 bottom flap
    [xG, yBB],                     // up to glue tab bottom
    [x0, yBB - ga],                // glue tab bottom angle
    [x0, yBT + ga],                // glue tab top angle
    [xG, yBT]                      // back to Back top
  ];

  // Vertical slit cuts between flaps (top)
  var slitCuts = [
    [[x1, yTop], [x1, yBT]],   // Back-Side1 top slit
    [[x2, yTop], [x2, yBT]],   // Side1-Front top slit
    [[x3, yTop], [x3, yBT]],   // Front-Side2 top slit
    // Bottom slits
    [[x1, yBB], [x1, yBot]],   // Back-Side1 bottom slit
    [[x2, yBB], [x2, yBot]],   // Side1-Front bottom slit
    [[x3, yBB], [x3, yBot]],   // Front-Side2 bottom slit
  ];

  // Crease lines
  var creases = [
    // Vertical panel boundaries (body section only)
    [[xG, yBT], [xG, yBB]],     // Back left (also glue tab fold)
    [[x1, yBT], [x1, yBB]],     // Back-Side1
    [[x2, yBT], [x2, yBB]],     // Side1-Front
    [[x3, yBT], [x3, yBB]],     // Front-Side2
    // Horizontal fold lines
    [[xG, yBT], [x4, yBT]],     // top flap fold
    [[xG, yBB], [x4, yBB]],     // bottom flap fold
  ];

  var dimensions = [
    dimH(xG, x1, yBot + 12, 'L=' + L, 12),
    dimH(x1, x2, yTop - 8, 'W=' + W, 8),
    dimH(xG, x1, yTop - 8, 'L=' + L, 8),
    dimV(yBT, yBB, x4 + 12, 'D=' + D, 12),
    dimV(yTop, yBT, x4 + 4, 'FL=' + r1(FL), 4),
    dimH(x0, xG, yBB + 8, 'G=' + G, 8),
  ];

  var labels = [
    lbl((xG + x1) / 2, yBT + D / 2, 'BACK'),
    lbl((x1 + x2) / 2, yBT + D / 2, 'SIDE'),
    lbl((x2 + x3) / 2, yBT + D / 2, 'FRONT'),
    lbl((x3 + x4) / 2, yBT + D / 2, 'SIDE'),
    lbl((xG + x4) / 2, yTop + FL / 2, 'TOP FLAP'),
    lbl((xG + x4) / 2, yBB + FL / 2, 'BOT FLAP'),
  ];

  return {
    cuts: [outline].concat(slitCuts),
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: 0, maxX: x4, maxY: yBot }
  };
}

/* ==================================================================
 * FEFCO 0200 — Full Overlap Slotted Container (FOL)
 * Similar to 0201 but outer flaps overlap (FL = W + IL for major flaps)
 *
 * Layout: same as 0201 but major flaps (Back/Front) are full width W
 * ================================================================== */
function draw0200(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var G  = p.G;
  var FL_minor = p.FL_min;  // W/2 + IL (side flaps)
  var FL_major = p.FL_maj;  // W + IL  (back/front flaps - full overlap)

  var x0 = 0;
  var xG = G;
  var x1 = G + L;
  var x2 = G + L + W;
  var x3 = G + 2 * L + W;
  var x4 = G + 2 * L + 2 * W;

  // Major flaps extend higher/lower than minor flaps
  var yMajTop = 0;
  var yMinTop = FL_major - FL_minor;  // minor flaps start lower
  var yBT = FL_major;
  var yBB = FL_major + D;
  var yMinBot = yBB + FL_minor;
  var yMajBot = yBB + FL_major;

  var ga = Math.min(G * 0.3, 3);

  // Outline: stepped shape where major flaps extend beyond minor
  var outline = [
    [xG, yMajTop],                 // top-left of Back major flap
    [x1, yMajTop],                 // top-right of Back major flap
    [x1, yMinTop],                 // step down to Side minor flap
    [x2, yMinTop],                 // top of Side minor flap
    [x2, yMajTop],                 // step up to Front major flap
    [x3, yMajTop],                 // top of Front major flap
    [x3, yMinTop],                 // step down to Side minor flap
    [x4, yMinTop],                 // top of Side2 minor flap
    // right edge down
    [x4, yMinBot],                 // bottom of Side2 minor flap
    [x3, yMinBot],                 // step to Front major bottom
    [x3, yMajBot],                 // bottom of Front major flap
    [x2, yMajBot],                 // bottom-left of Front major
    [x2, yMinBot],                 // step to Side1 bottom
    [x1, yMinBot],                 // bottom of Side1 minor
    [x1, yMajBot],                 // step to Back major bottom
    [xG, yMajBot],                 // bottom of Back major flap
    [xG, yBB],                     // up to glue tab
    [x0, yBB - ga],
    [x0, yBT + ga],
    [xG, yBT]
  ];

  // Slit cuts between flaps
  var slitCuts = [
    [[x1, yMinTop], [x1, yBT]],   // Back-Side1 top slit (minor level)
    [[x2, yMinTop], [x2, yBT]],   // Side1-Front top slit
    [[x3, yMinTop], [x3, yBT]],   // Front-Side2 top slit
    [[x1, yBB], [x1, yMinBot]],   // Back-Side1 bottom slit
    [[x2, yBB], [x2, yMinBot]],   // Side1-Front bottom slit
    [[x3, yBB], [x3, yMinBot]],   // Front-Side2 bottom slit
  ];

  var creases = [
    [[xG, yBT], [xG, yBB]],
    [[x1, yBT], [x1, yBB]],
    [[x2, yBT], [x2, yBB]],
    [[x3, yBT], [x3, yBB]],
    // Horizontal fold lines
    [[xG, yBT], [x4, yBT]],
    [[xG, yBB], [x4, yBB]],
  ];

  var dimensions = [
    dimH(xG, x1, yMajBot + 12, 'L=' + L, 12),
    dimH(x1, x2, yMajTop - 8, 'W=' + W, 8),
    dimV(yBT, yBB, x4 + 12, 'D=' + D, 12),
    dimV(yMajTop, yBT, x4 + 4, 'FL_maj=' + r1(FL_major), 4),
    dimV(yMinTop, yBT, x1 - 4, 'FL_min=' + r1(FL_minor), 4),
    dimH(x0, xG, yBB + 8, 'G=' + G, 8),
  ];

  var labels = [
    lbl((xG + x1) / 2, yBT + D / 2, 'BACK'),
    lbl((x1 + x2) / 2, yBT + D / 2, 'SIDE'),
    lbl((x2 + x3) / 2, yBT + D / 2, 'FRONT'),
    lbl((x3 + x4) / 2, yBT + D / 2, 'SIDE'),
  ];

  return {
    cuts: [outline].concat(slitCuts),
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: 0, maxX: x4, maxY: yMajBot }
  };
}

/* ==================================================================
 * FEFCO 0301 — Telescopic Box (Base + Lid)
 * Two-part box: a shallow Base (tray) and a Lid that slides over it.
 *
 * Base layout (cross-shaped):
 *        [ Top wall: L x (D+D2) ]
 *   [Left wall] [ Bottom: L x W ] [Right wall]
 *   [(D+D1)xW ] [                ] [(D+D2)xW ]
 *        [ Bottom wall: L x (D+D1) ]
 *
 * Lid layout (cross-shaped, slightly larger):
 *        [ Top wall: L2 x (D+D4) ]
 *   [Left wall] [ Top: L2 x W2 ] [Right wall]
 *   [(D+D3)xW2] [               ] [(D+D4)xW2]
 *        [ Bottom wall: L2 x (D+D3) ]
 *
 * Formulas (from ArtiosCAD):
 *   L1=CAL, W1=CAL, D1=IL, D2=IL
 *   D3=D1, D4=D2
 *   L2=L1+3*CAL, W2=CAL (=W1+CAL for lid clearance)
 *   Base: KDFL_b = 2*(D+D2)+L+L1,  KDFW_b = 2*(D+D1)+W+W1+2*SO
 *   Lid:  KDFL_l = 2*(D+D3)+L+L2+2*SOL, KDFW_l = 2*(D+D4)+W+W2
 * ================================================================== */
function draw0301(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var L1 = p.L1, W1 = p.W1, D1 = p.D1, D2 = p.D2;
  var L2 = p.L2, W2 = p.W2, D3 = p.D3, D4 = p.D4;
  var SB2 = p.SB2;

  // --- BASE PART ---
  var bWallT = D + D2;   // top/bottom wall height for base (using D2)
  var bWallL = D + D1;   // left/right wall height for base (using D1)
  var bCx = bWallL;      // center X start (left wall width)
  var bCy = bWallT;      // center Y start (top wall height)
  var bW = L + L1;       // base center panel width
  var bH = W + W1;       // base center panel height

  // Base cross outline
  var bOutline = [
    [bCx, 0],                      // top-left of top wall
    [bCx + bW, 0],                 // top-right of top wall
    [bCx + bW, bCy],               // down to right wall top
    [bCx + bW + bWallL, bCy],      // right wall top-right
    [bCx + bW + bWallL, bCy + bH], // right wall bottom-right
    [bCx + bW, bCy + bH],          // down to bottom wall
    [bCx + bW, bCy + bH + bWallT], // bottom wall bottom-right
    [bCx, bCy + bH + bWallT],     // bottom wall bottom-left
    [bCx, bCy + bH],               // up to left wall bottom
    [0, bCy + bH],                 // left wall bottom-left
    [0, bCy],                     // left wall top-left
    [bCx, bCy]                     // back to center top-left
  ];

  // Base creases (cross fold lines)
  var bCreases = [
    [[bCx, bCy], [bCx + bW, bCy]],              // top wall fold
    [[bCx, bCy + bH], [bCx + bW, bCy + bH]],    // bottom wall fold
    [[bCx, bCy], [bCx, bCy + bH]],              // left wall fold
    [[bCx + bW, bCy], [bCx + bW, bCy + bH]],    // right wall fold
  ];

  // Base glue tabs on wall ends
  var gt = 3;  // glue tab height on walls
  var bGlueCuts = [
    // Top wall glue tabs (left & right corners)
    [[bCx, 0], [bCx - gt, gt], [bCx - gt, bCy - gt], [bCx, bCy]],
    [[bCx + bW, 0], [bCx + bW + gt, gt], [bCx + bW + gt, bCy - gt], [bCx + bW, bCy]],
    // Bottom wall glue tabs
    [[bCx, bCy + bH], [bCx - gt, bCy + bH + gt], [bCx - gt, bCy + bH + bWallT - gt], [bCx, bCy + bH + bWallT]],
    [[bCx + bW, bCy + bH], [bCx + bW + gt, bCy + bH + gt], [bCx + bW + gt, bCy + bH + bWallT - gt], [bCx + bW, bCy + bH + bWallT]],
  ];

  var bBBox = { minX: 0, minY: 0, maxX: bCx + bW + bWallL, maxY: bCy + bH + bWallT };

  // --- LID PART (positioned to the right of base) ---
  var gap = 20;  // gap between base and lid
  var lOffX = bBBox.maxX + gap;
  var lWallT = D + D4;   // lid top/bottom wall
  var lWallL = D + D3;   // lid left/right wall
  var lCx = lOffX + lWallL;
  var lCy = lWallT;
  var lW = L + L2;       // lid center panel (slightly larger)
  var lH = W + W2;

  // Lid cross outline
  var lOutline = [
    [lCx, 0],
    [lCx + lW, 0],
    [lCx + lW, lCy],
    [lCx + lW + lWallL, lCy],
    [lCx + lW + lWallL, lCy + lH],
    [lCx + lW, lCy + lH],
    [lCx + lW, lCy + lH + lWallT],
    [lCx, lCy + lH + lWallT],
    [lCx, lCy + lH],
    [lOffX, lCy + lH],
    [lOffX, lCy],
    [lCx, lCy]
  ];

  var lCreases = [
    [[lCx, lCy], [lCx + lW, lCy]],
    [[lCx, lCy + lH], [lCx + lW, lCy + lH]],
    [[lCx, lCy], [lCx, lCy + lH]],
    [[lCx + lW, lCy], [lCx + lW, lCy + lH]],
  ];

  // Lid glue tabs
  var lGlueCuts = [
    [[lCx, 0], [lCx - gt, gt], [lCx - gt, lCy - gt], [lCx, lCy]],
    [[lCx + lW, 0], [lCx + lW + gt, gt], [lCx + lW + gt, lCy - gt], [lCx + lW, lCy]],
    [[lCx, lCy + lH], [lCx - gt, lCy + lH + gt], [lCx - gt, lCy + lH + lWallT - gt], [lCx, lCy + lH + lWallT]],
    [[lCx + lW, lCy + lH], [lCx + lW + gt, lCy + lH + gt], [lCx + lW + gt, lCy + lH + lWallT - gt], [lCx + lW, lCy + lH + lWallT]],
  ];

  var lBBox = { minX: lOffX, minY: 0, maxX: lCx + lW + lWallL, maxY: lCy + lH + lWallT };

  // Combine all cuts and creases
  var allCuts = [bOutline].concat(bGlueCuts).concat([lOutline]).concat(lGlueCuts);
  var allCreases = bCreases.concat(lCreases);

  var dimensions = [
    // Base dimensions
    dimH(bCx, bCx + bW, bBBox.maxY + 12, 'L+L1=' + r1(bW), 12),
    dimV(bCy, bCy + bH, bBBox.maxX + 4, 'W+W1=' + r1(bH), 4),
    dimV(0, bCy, 4, 'D+D2=' + r1(bWallT), 0),
    // Lid dimensions
    dimH(lCx, lCx + lW, lBBox.maxY + 12, 'L+L2=' + r1(lW), 12),
    dimV(lCy, lCy + lH, lBBox.maxX + 4, 'W+W2=' + r1(lH), 4),
  ];

  var labels = [
    lbl(bCx + bW / 2, bCy + bH / 2, 'BASE'),
    lbl(bCx + bW / 2, bCy / 2, 'BW-T'),
    lbl(bCx + bW / 2, bCy + bH + bWallT / 2, 'BW-B'),
    lbl(lCx + lW / 2, lCy + lH / 2, 'LID'),
    lbl(lCx + lW / 2, lCy / 2, 'LW-T'),
    lbl(lCx + lW / 2, lCy + lH + lWallT / 2, 'LW-B'),
  ];

  return {
    cuts: allCuts,
    creases: allCreases,
    dimensions: dimensions,
    labels: labels,
    bbox: {
      minX: 0,
      minY: 0,
      maxX: Math.max(bBBox.maxX, lBBox.maxX),
      maxY: Math.max(bBBox.maxY, lBBox.maxY)
    }
  };
}

/* ==================================================================
 * FEFCO 0451 — Crash Lock Bottom (Auto-Bottom)
 * Cross-shaped layout with interlocking bottom flaps.
 *
 * Formulas:
 *   L1=CAL, W1=CAL, D1=IL, D2=IL
 *   KDFL = 2*(D+D2)+L+L1
 *   KDFW = 2*(D+D1)+W+W1+2*SO
 *
 * Layout:
 *        [ Top wall: L x (D+D2) ]
 *   [Left wall] [ Bottom: L x W ] [Right wall]
 *   [(D+D1)xW ] [                ] [(D+D2)xW ]
 *        [ Bottom wall: L x (D+D1) ]
 * Bottom wall has interlocking tab/slot for crash-lock
 * ================================================================== */
function draw0451(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var L1 = p.L1, W1 = p.W1, D1 = p.D1, D2 = p.D2;
  var SB2 = p.SB2;

  var wallT = D + D2;   // top wall height
  var wallB = D + D1;   // bottom wall height
  var wallL = D + D1;   // left wall width
  var wallR = D + D2;   // right wall width
  var cx = wallL;       // center X start
  var cy = wallT;       // center Y start
  var cw = L + L1;      // center panel width
  var ch = W + W1;      // center panel height

  // Tab/slot dimensions for crash lock
  var tabW = Math.min(L * 0.15, 15);
  var tabH = Math.min(wallB * 0.3, 8);

  // Cross outline (with crash-lock tab on bottom wall)
  var outline = [
    [cx, 0],                              // top-left of top wall
    [cx + cw, 0],                         // top-right of top wall
    [cx + cw, cy],                        // down to right wall top
    [cx + cw + wallR, cy],               // right wall top-right
    [cx + cw + wallR, cy + ch],          // right wall bottom-right
    [cx + cw, cy + ch],                   // down to bottom wall
    // Bottom wall with interlocking tab
    [cx + cw, cy + ch + wallB],           // bottom-right of bottom wall
    [cx + cw / 2 + tabW, cy + ch + wallB],
    [cx + cw / 2 + tabW, cy + ch + wallB + tabH],
    [cx + cw / 2 + tabW * 0.3, cy + ch + wallB + tabH],
    [cx + cw / 2 + tabW * 0.3, cy + ch + wallB],
    [cx + cw / 2 - tabW * 0.3, cy + ch + wallB],
    [cx + cw / 2 - tabW * 0.3, cy + ch + wallB + tabH],
    [cx + cw / 2 - tabW, cy + ch + wallB + tabH],
    [cx + cw / 2 - tabW, cy + ch + wallB],
    [cx, cy + ch + wallB],               // bottom-left of bottom wall
    [cx, cy + ch],                        // up to left wall bottom
    [0, cy + ch],                         // left wall bottom-left
    [0, cy],                              // left wall top-left
    [cx, cy]                              // back to center top-left
  ];

  // Glue tabs on wall corners
  var gt = 3;
  var glueCuts = [
    [[cx, 0], [cx - gt, gt], [cx - gt, cy - gt], [cx, cy]],
    [[cx + cw, 0], [cx + cw + gt, gt], [cx + cw + gt, cy - gt], [cx + cw, cy]],
    [[cx, cy + ch], [cx - gt, cy + ch + gt], [cx - gt, cy + ch + wallB - gt], [cx, cy + ch + wallB]],
    [[cx + cw, cy + ch], [cx + cw + gt, cy + ch + gt], [cx + cw + gt, cy + ch + wallB - gt], [cx + cw, cy + ch + wallB]],
  ];

  // Slot cut in bottom panel (for tab insertion)
  var slotCut = [
    [[cx + cw / 2 - tabW * 0.3, cy + ch - 0.5], [cx + cw / 2 + tabW * 0.3, cy + ch - 0.5]]
  ];

  var creases = [
    [[cx, cy], [cx + cw, cy]],              // top wall fold
    [[cx, cy + ch], [cx + cw, cy + ch]],    // bottom wall fold
    [[cx, cy], [cx, cy + ch]],              // left wall fold
    [[cx + cw, cy], [cx + cw, cy + ch]],    // right wall fold
    // Crash lock diagonal creases (on bottom wall)
    [[cx, cy + ch], [cx + cw / 2 - tabW, cy + ch + wallB]],
    [[cx + cw, cy + ch], [cx + cw / 2 + tabW, cy + ch + wallB]],
  ];

  var maxX = cx + cw + wallR;
  var maxY = cy + ch + wallB;

  var dimensions = [
    dimH(cx, cx + cw, maxY + 12, 'L+L1=' + r1(cw), 12),
    dimV(cy, cy + ch, maxX + 4, 'W+W1=' + r1(ch), 4),
    dimV(0, cy, 4, 'D+D2=' + r1(wallT), 0),
    dimV(cy + ch, maxY, maxX + 4, 'D+D1=' + r1(wallB), 4),
  ];

  var labels = [
    lbl(cx + cw / 2, cy + ch / 2, 'BOTTOM'),
    lbl(cx + cw / 2, cy / 2, 'TOP WALL'),
    lbl(cx + cw / 2, cy + ch + wallB / 2, 'BOT WALL'),
    lbl(cx / 2, cy + ch / 2, 'L'),
    lbl(cx + cw + wallR / 2, cy + ch / 2, 'R'),
  ];

  return {
    cuts: [outline].concat(glueCuts).concat(slotCut),
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: 0, maxX: maxX, maxY: maxY }
  };
}

/* ==================================================================
 * FEFCO 0601 — Sleeve (Wrap-around with end flaps)
 * Simple tube/sleeve with glue tab and end flaps.
 *
 * Formulas:
 *   L1=CAL, W1=CAL, D1=IL, D2=IL
 *   KDFX = L+L1+2*EFW  (sheet length)
 *   KDFT = W+W1+D+D2+OG  (sheet width)
 *
 * Layout (horizontal):
 *   [EndFlap EFW][Panel L][Glue G][Panel W][Panel L][Panel W][EndFlap EFW]
 * Simplified: [EFW][L+L1][G][W+W1]  (folded sleeve)
 * ================================================================== */
function draw0601(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var L1 = p.L1, W1 = p.W1, D2 = p.D2;
  var EFW = p.EFW;
  var G = p.G;

  // Sleeve layout: [EndFlap][L panel][W panel][Glue tab]
  // Height of sheet = D + D2 (sleeve height + insertion)
  var x0 = 0;
  var xEF = EFW;                 // end flap right
  var xL = EFW + L + L1;         // L panel right
  var xW = EFW + L + L1 + W + W1; // W panel right
  var xG = xW + G;               // glue tab right

  var y0 = 0;
  var yD = D + D2;               // sheet height

  var ga = Math.min(G * 0.3, 3);

  // Outer outline
  var outline = [
    [xEF, y0],                    // top-left of L panel (end flap top)
    [xL, y0],                     // top-right of L panel
    [xL, y0],                     // corner
    [xW, y0],                     // top-right of W panel
    [xG, y0 + ga],               // glue tab top angle
    [xG, yD - ga],               // glue tab bottom angle
    [xW, yD],                     // bottom-right of W panel
    [xL, yD],                     // bottom-right of L panel
    [xL, yD],                     // corner
    [xEF, yD],                    // bottom-left (end flap bottom)
    [x0, yD / 2],                 // end flap point (triangular)
    [xEF, y0]                     // close
  ];

  var creases = [
    [[xEF, y0], [xEF, yD]],      // end flap fold
    [[xL, y0], [xL, yD]],        // L-W panel boundary
    [[xW, y0], [xW, yD]],        // W-glue boundary
  ];

  var dimensions = [
    dimH(xEF, xL, yD + 12, 'L+L1=' + r1(L + L1), 12),
    dimH(xL, xW, y0 - 8, 'W+W1=' + r1(W + W1), 8),
    dimV(y0, yD, xG + 12, 'D+D2=' + r1(yD), 12),
    dimH(x0, xEF, yD / 2 + 8, 'EFW=' + EFW, 8),
    dimH(xW, xG, yD + 8, 'G=' + G, 8),
  ];

  var labels = [
    lbl((xEF + xL) / 2, yD / 2, 'L'),
    lbl((xL + xW) / 2, yD / 2, 'W'),
    lbl((xW + xG) / 2, yD / 2, 'G'),
    lbl(xEF / 2, yD / 2, 'EF'),
  ];

  return {
    cuts: [outline],
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: 0, maxX: xG, maxY: yD }
  };
}

/* ==================================================================
 * FEFCO 0911 — Inner Fitting (Divider/Partition)
 * Cross-shaped interior fitting that sits inside a box.
 *
 * Formulas:
 *   L1=-2*OG, D1=-OG, D2=-OG (negative allowances for tight fit)
 *   KDFX = 2*(D+D2)+L+L1
 *   KDFY = 2*(D+D1)+W+W1+2*SO
 *
 * Layout: same cross shape as 0451 but without glue tabs
 * ================================================================== */
function draw0911(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var L1 = p.L1, W1 = p.W1, D1 = p.D1, D2 = p.D2;

  var wallT = D + D2;
  var wallB = D + D1;
  var wallL = D + D1;
  var wallR = D + D2;
  var cx = wallL;
  var cy = wallT;
  var cw = L + L1;
  var ch = W + W1;

  // Simple cross outline (no glue tabs, no interlocking)
  var outline = [
    [cx, 0],
    [cx + cw, 0],
    [cx + cw, cy],
    [cx + cw + wallR, cy],
    [cx + cw + wallR, cy + ch],
    [cx + cw, cy + ch],
    [cx + cw, cy + ch + wallB],
    [cx, cy + ch + wallB],
    [cx, cy + ch],
    [0, cy + ch],
    [0, cy],
    [cx, cy]
  ];

  // Slot cuts for interlocking partitions
  var slotW = Math.min(cw * 0.02, 1);
  var slotCuts = [
    // Vertical slot in center panel (for cross-partition)
    [[cx + cw / 2 - slotW, cy], [cx + cw / 2 - slotW, cy + ch]],
    [[cx + cw / 2 + slotW, cy], [cx + cw / 2 + slotW, cy + ch]],
  ];

  var creases = [
    [[cx, cy], [cx + cw, cy]],
    [[cx, cy + ch], [cx + cw, cy + ch]],
    [[cx, cy], [cx, cy + ch]],
    [[cx + cw, cy], [cx + cw, cy + ch]],
  ];

  var maxX = cx + cw + wallR;
  var maxY = cy + ch + wallB;

  var dimensions = [
    dimH(cx, cx + cw, maxY + 12, 'L+L1=' + r1(cw), 12),
    dimV(cy, cy + ch, maxX + 4, 'W+W1=' + r1(ch), 4),
    dimV(0, cy, 4, 'D+D2=' + r1(wallT), 0),
  ];

  var labels = [
    lbl(cx + cw / 2, cy + ch / 2, 'FITTING'),
    lbl(cx + cw / 2, cy / 2, 'WALL-T'),
    lbl(cx + cw / 2, cy + ch + wallB / 2, 'WALL-B'),
  ];

  return {
    cuts: [outline].concat(slotCuts),
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: 0, maxX: maxX, maxY: maxY }
  };
}

/* ==================================================================
 * PILLOW — Pillow Box
 * Curved top/bottom edges, tuck closure.
 * Not a FEFCO standard but commonly used in packaging.
 * ================================================================== */
function drawPILLOW(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var G = p.G;
  var CR = Math.min(D * 0.4, 15);  // curve radius

  var xG = 0, xB = G;
  var x1 = G + L;                  // back-flap boundary
  var x2 = G + 2 * L;              // right edge
  var yT = 0, yB = W;             // body top/bottom
  var curveH = D;                  // curve extension

  // Curved flap top and bottom
  function curvePoints(x1, x2, y, depth, n) {
    var pts = [];
    n = n || 16;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var x = x1 + (x2 - x1) * t;
      var yOff = depth * Math.sin(Math.PI * t);
      pts.push([x, y - yOff]);
    }
    return pts;
  }

  var topCurve = curvePoints(xB, x1, yT, curveH);
  var botCurve = curvePoints(xB, x1, yB, curveH);

  var outline = [
    [xB, yT]
  ].concat(topCurve).concat([
    [x1, yT],
    [x2, yT + D / 2],     // right curve
    [x1, yB],
  ]).concat(botCurve.reverse()).concat([
    [xB, yB],
    [xG, yB - G * 0.3],   // glue tab
    [xG, yT + G * 0.3],
    [xB, yT]
  ]);

  var creases = [
    [[xB, yT], [xB, yB]],      // back panel fold
    [[x1, yT], [x1, yB]],      // flap fold
  ];

  var dimensions = [
    dimH(xB, x1, yB + curveH + 12, 'L=' + L, 12),
    dimV(yT, yB, x2 + 12, 'W=' + W, 12),
    dimH(xG, xB, yB + 8, 'G=' + G, 8),
  ];

  var labels = [
    lbl((xB + x1) / 2, W / 2, 'BACK'),
    lbl((x1 + x2) / 2, W / 2, 'FLAP'),
  ];

  return {
    cuts: [outline],
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: -curveH, maxX: x2, maxY: yB + curveH }
  };
}

/* ==================================================================
 * GABLE — Gable Top Box
 * Peaked roof shape on top, tuck bottom.
 * ================================================================== */
function drawGABLE(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var G = p.G;
  var GT = Math.min(W / 2, 40);  // gable height
  var F = Math.min(W / 2 + AC.IL, 25);  // bottom tuck

  var xG = 0, xB = G;
  var x1 = G + L, x2 = G + L + W, x3 = G + 2 * L + W, x4 = G + 2 * L + 2 * W;
  var yTuck = 0, yBT = F, yBB = F + D, yGable = F + D, yPeak = F + D + GT, yBot = yPeak + GT;

  var ga = Math.min(G * 0.3, 3);

  var outline = [
    [xB, yTuck],                  // top-left of back tuck
    [x1, yTuck],                  // top-right of back tuck
    [x1, yGable],                 // down to gable base
    [x1 + W / 2, yPeak],         // gable peak (side1)
    [x2, yGable],                 // gable valley
    [x2 + W / 2, yPeak],         // gable peak (front)
    [x3, yGable],                 // gable valley
    [x3 + W / 2, yPeak],         // gable peak (side2)
    [x4, yGable],                 // right gable base
    [x4, yBB],                    // down to body bottom
    [x3, yBB],                    // bottom of side2
    [x3, yBB + F],               // side2 bottom tuck
    [x2, yBB + F],               // front bottom tuck
    [x2, yBB],
    [x1, yBB],
    [x1, yBB + F],               // side1 bottom tuck
    [xB, yBB + F],               // back bottom tuck
    [xB, yBB],
    [xG, yBB - ga],
    [xG, yBT + ga],
    [xB, yBT],
    [xB, yTuck]
  ];

  var creases = [
    [[xB, yBT], [xB, yBB]],
    [[x1, yBT], [x1, yBB]],
    [[x2, yBT], [x2, yBB]],
    [[x3, yBT], [x3, yBB]],
    [[xB, yBT], [x4, yBT]],
    [[xB, yBB], [x4, yBB]],
    // Gable fold lines
    [[x1, yGable], [x1 + W / 2, yPeak]],
    [[x1 + W / 2, yPeak], [x2, yGable]],
    [[x2, yGable], [x2 + W / 2, yPeak]],
    [[x2 + W / 2, yPeak], [x3, yGable]],
    [[x3, yGable], [x3 + W / 2, yPeak]],
    [[x3 + W / 2, yPeak], [x4, yGable]],
  ];

  var dimensions = [
    dimH(xB, x1, yBot + 12, 'L=' + L, 12),
    dimH(x1, x2, yTuck - 8, 'W=' + W, 8),
    dimV(yBT, yBB, x4 + 12, 'D=' + D, 12),
    dimV(yGable, yPeak, x4 + 4, 'GT=' + r1(GT), 4),
    dimH(xG, xB, yBB + 8, 'G=' + G, 8),
  ];

  var labels = [
    lbl((xB + x1) / 2, yBT + D / 2, 'BACK'),
    lbl((x1 + x2) / 2, yBT + D / 2, 'SIDE'),
    lbl((x2 + x3) / 2, yBT + D / 2, 'FRONT'),
    lbl((x3 + x4) / 2, yBT + D / 2, 'SIDE'),
  ];

  return {
    cuts: [outline],
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: 0, maxX: x4, maxY: yBot }
  };
}

/* ==================================================================
 * TRAY — Tray with Lid (Display Tray)
 * Cross-shaped tray with corner cut-outs.
 *
 * KDFL = 2*(D+D1)+L+L1  (from FEFCO 0451 pattern)
 * KDFW = 2*(D+D2)+W+W1
 * ================================================================== */
function drawTRAY(p, comp) {
  var L = p.L, W = p.W, D = p.D;
  var L1 = p.L1, W1 = p.W1, D1 = p.D1, D2 = p.D2;

  var wallT = D + D1;
  var wallB = D + D1;
  var wallL = D + D2;
  var wallR = D + D2;
  var cx = wallL;
  var cy = wallT;
  var cw = L + L1;
  var ch = W + W1;

  // Corner cut-out angle (45°)
  var corner = Math.min(wallT * 0.6, wallL * 0.6, D * 0.8);

  // Outline with corner cutouts for tray walls
  var outline = [
    [cx + corner, 0],              // top wall, left of corner cut
    [cx + cw - corner, 0],         // top wall, right of corner cut
    [cx + cw, corner],             // top-right corner
    [cx + cw + wallR - corner, corner],
    [cx + cw + wallR, cy + corner],
    [cx + cw + wallR, cy + ch - corner],  // right wall
    [cx + cw + wallR - corner, cy + ch],
    [cx + cw, cy + ch - corner],
    [cx + cw, cy + ch + wallB - corner],
    [cx + cw - corner, cy + ch + wallB],
    [cx + corner, cy + ch + wallB],
    [cx, cy + ch + wallB - corner],
    [cx, cy + ch - corner],
    [0, cy + ch - corner],
    [0, cy + corner],
    [cx, cy + corner],
    [cx + corner, 0]
  ];

  var creases = [
    [[cx, cy], [cx + cw, cy]],
    [[cx, cy + ch], [cx + cw, cy + ch]],
    [[cx, cy], [cx, cy + ch]],
    [[cx + cw, cy], [cx + cw, cy + ch]],
  ];

  var maxX = cx + cw + wallR;
  var maxY = cy + ch + wallB;

  var dimensions = [
    dimH(cx, cx + cw, maxY + 12, 'L+L1=' + r1(cw), 12),
    dimV(cy, cy + ch, maxX + 4, 'W+W1=' + r1(ch), 4),
    dimV(0, cy, 4, 'D+D1=' + r1(wallT), 0),
  ];

  var labels = [
    lbl(cx + cw / 2, cy + ch / 2, 'BOTTOM'),
    lbl(cx + cw / 2, cy / 2, 'WALL'),
  ];

  return {
    cuts: [outline],
    creases: creases,
    dimensions: dimensions,
    labels: labels,
    bbox: { minX: 0, minY: 0, maxX: maxX, maxY: maxY }
  };
}

/* ==================================================================
 * BOX TYPE DEFINITIONS
 *
 * Each entry: { id, fefco, name, category, params, derived, compute, draw }
 * params:  editable inputs (L, W, D) — only these are user-editable
 * derived:  computed values with formula strings for display
 * compute:  function(p) — adds derived values to params object p
 * draw:     function(p, comp) — returns die-cut geometry
 * ================================================================== */
var BoxTypes = [
  /* --- FEFCO 0201: Regular Slotted Container --- */
  {
    id: '0201',
    fefco: '0201',
    name: 'FEFCO 0201 RSC (Regular Slotted Container)',
    category: 'Slotted Container',
    params: [
      { key: 'L', label: 'Length L', default: 200, min: 20, max: 2000, step: 1 },
      { key: 'W', label: 'Width W',  default: 150, min: 20, max: 2000, step: 1 },
      { key: 'D', label: 'Depth D',  default: 100, min: 10, max: 1000, step: 1 },
    ],
    derived: [
      { key: 'CAL', label: 'Cut Allowance CAL',  formula: '0.5' },
      { key: 'IL',  label: 'Insertion Length IL', formula: '1.5' },
      { key: 'FL',  label: 'Flap Length FL',     formula: 'W/2 + IL' },
      { key: 'G',   label: 'Glue Tab G',          formula: 'JW (8mm)' },
      { key: 'KDFW',label: 'Sheet Width KDFW',   formula: 'G + 2L + 2W' },
      { key: 'KDFH',label: 'Sheet Height KDFH',  formula: '2*FL + D' },
    ],
    compute: function(p) {
      p.CAL = AC.CAL;
      p.IL  = AC.IL;
      p.FL  = p.W / 2 + p.IL;
      p.G   = AC.JW;
      p.KDFW = p.G + 2 * p.L + 2 * p.W;
      p.KDFH = 2 * p.FL + p.D;
      return p;
    },
    draw: draw0201
  },

  /* --- FEFCO 0200: Full Overlap Slotted Container --- */
  {
    id: '0200',
    fefco: '0200',
    name: 'FEFCO 0200 FOL (Full Overlap)',
    category: 'Slotted Container',
    params: [
      { key: 'L', label: 'Length L', default: 200, min: 20, max: 2000, step: 1 },
      { key: 'W', label: 'Width W',  default: 150, min: 20, max: 2000, step: 1 },
      { key: 'D', label: 'Depth D',  default: 100, min: 10, max: 1000, step: 1 },
    ],
    derived: [
      { key: 'CAL',    label: 'Cut Allowance CAL',     formula: '0.5' },
      { key: 'IL',     label: 'Insertion Length IL',    formula: '1.5' },
      { key: 'FL_min', label: 'Minor Flap FL_min',     formula: 'W/2 + IL' },
      { key: 'FL_maj', label: 'Major Flap FL_maj',     formula: 'W + IL' },
      { key: 'G',      label: 'Glue Tab G',             formula: 'JW (8mm)' },
    ],
    compute: function(p) {
      p.CAL    = AC.CAL;
      p.IL     = AC.IL;
      p.FL_min = p.W / 2 + p.IL;
      p.FL_maj = p.W + p.IL;
      p.G      = AC.JW;
      return p;
    },
    draw: draw0200
  },

  /* --- FEFCO 0301: Telescopic Box (Base + Lid) --- */
  {
    id: '0301',
    fefco: '0301',
    name: 'FEFCO 0301 Telescopic Box (Base + Lid)',
    category: 'Telescopic',
    params: [
      { key: 'L', label: 'Length L', default: 150, min: 20, max: 1000, step: 1 },
      { key: 'W', label: 'Width W',  default: 100, min: 20, max: 1000, step: 1 },
      { key: 'D', label: 'Depth D',  default: 50,  min: 10, max: 500,  step: 1 },
    ],
    derived: [
      { key: 'L1', label: 'Base Length Allowance L1', formula: 'CAL' },
      { key: 'W1', label: 'Base Width Allowance W1',  formula: 'CAL' },
      { key: 'D1', label: 'Base Depth Allowance D1',  formula: 'IL' },
      { key: 'D2', label: 'Base Depth Allowance D2',  formula: 'IL' },
      { key: 'L2', label: 'Lid Length Allowance L2',  formula: 'L1 + 3*CAL' },
      { key: 'W2', label: 'Lid Width Allowance W2',   formula: 'CAL' },
      { key: 'D3', label: 'Lid Depth Allowance D3',   formula: 'D1' },
      { key: 'D4', label: 'Lid Depth Allowance D4',   formula: 'D2' },
      { key: 'SB2',label: 'Slot Base SB2',             formula: '2mm' },
      { key: 'KDFL_b', label: 'Base KDFL', formula: '2*(D+D2)+L+L1' },
      { key: 'KDFW_b', label: 'Base KDFW', formula: '2*(D+D1)+W+W1+2*SO' },
      { key: 'KDFL_l', label: 'Lid KDFL',  formula: '2*(D+D3)+L+L2+2*SOL' },
      { key: 'KDFW_l', label: 'Lid KDFW',  formula: '2*(D+D4)+W+W2' },
    ],
    compute: function(p) {
      p.L1  = AC.CAL;
      p.W1  = AC.CAL;
      p.D1  = AC.IL;
      p.D2  = AC.IL;
      p.L2  = p.L1 + 3 * AC.CAL;
      p.W2  = AC.CAL;
      p.D3  = p.D1;
      p.D4  = p.D2;
      p.SB2 = AC.SB2;
      p.SO  = AC.SO;
      p.SOL = AC.SOL;
      p.KDFL_b = 2 * (p.D + p.D2) + p.L + p.L1;
      p.KDFW_b = 2 * (p.D + p.D1) + p.W + p.W1 + 2 * p.SO;
      p.KDFL_l = 2 * (p.D + p.D3) + p.L + p.L2 + 2 * p.SOL;
      p.KDFW_l = 2 * (p.D + p.D4) + p.W + p.W2;
      return p;
    },
    draw: draw0301
  },

  /* --- FEFCO 0451: Crash Lock Bottom --- */
  {
    id: '0451',
    fefco: '0451',
    name: 'FEFCO 0451 Crash Lock Bottom',
    category: 'Auto-Bottom',
    params: [
      { key: 'L', label: 'Length L', default: 120, min: 20, max: 1000, step: 1 },
      { key: 'W', label: 'Width W',  default: 80,  min: 20, max: 1000, step: 1 },
      { key: 'D', label: 'Depth D',  default: 60,  min: 10, max: 500,  step: 1 },
    ],
    derived: [
      { key: 'L1',  label: 'Length Allowance L1',  formula: 'CAL' },
      { key: 'W1',  label: 'Width Allowance W1',   formula: 'CAL' },
      { key: 'D1',  label: 'Depth Allowance D1',   formula: 'IL' },
      { key: 'D2',  label: 'Depth Allowance D2',   formula: 'IL' },
      { key: 'SB2', label: 'Slot Base SB2',         formula: '2mm' },
      { key: 'KDFL',label: 'Sheet Length KDFL',     formula: '2*(D+D2)+L+L1' },
      { key: 'KDFW',label: 'Sheet Width KDFW',      formula: '2*(D+D1)+W+W1+2*SO' },
    ],
    compute: function(p) {
      p.L1  = AC.CAL;
      p.W1  = AC.CAL;
      p.D1  = AC.IL;
      p.D2  = AC.IL;
      p.SB2 = AC.SB2;
      p.SO  = AC.SO;
      p.KDFL = 2 * (p.D + p.D2) + p.L + p.L1;
      p.KDFW = 2 * (p.D + p.D1) + p.W + p.W1 + 2 * p.SO;
      return p;
    },
    draw: draw0451
  },

  /* --- FEFCO 0601: Sleeve --- */
  {
    id: '0601',
    fefco: '0601',
    name: 'FEFCO 0601 Sleeve',
    category: 'Sleeve',
    params: [
      { key: 'L', label: 'Length L', default: 150, min: 20, max: 1000, step: 1 },
      { key: 'W', label: 'Width W',  default: 100, min: 20, max: 1000, step: 1 },
      { key: 'D', label: 'Depth D',  default: 50,  min: 10, max: 500,  step: 1 },
    ],
    derived: [
      { key: 'L1', label: 'Length Allowance L1', formula: 'CAL' },
      { key: 'W1', label: 'Width Allowance W1',  formula: 'CAL' },
      { key: 'D2', label: 'Depth Allowance D2',  formula: 'IL' },
      { key: 'EFW',label: 'End Flap Width EFW',   formula: '5mm' },
      { key: 'G',  label: 'Glue Tab G',            formula: 'JW (8mm)' },
      { key: 'KDFX',label: 'Sheet Length KDFX',   formula: 'L+L1+2*EFW' },
      { key: 'KDFT',label: 'Sheet Width KDFT',    formula: 'W+W1+D+D2+OG' },
    ],
    compute: function(p) {
      p.L1  = AC.CAL;
      p.W1  = AC.CAL;
      p.D2  = AC.IL;
      p.EFW = AC.EFW;
      p.G   = AC.JW;
      p.OG  = AC.OG;
      p.KDFX = p.L + p.L1 + 2 * p.EFW;
      p.KDFT = p.W + p.W1 + p.D + p.D2 + p.OG;
      return p;
    },
    draw: draw0601
  },

  /* --- FEFCO 0911: Inner Fitting --- */
  {
    id: '0911',
    fefco: '0911',
    name: 'FEFCO 0911 Inner Fitting (Divider)',
    category: 'Interior',
    params: [
      { key: 'L', label: 'Length L', default: 150, min: 20, max: 1000, step: 1 },
      { key: 'W', label: 'Width W',  default: 100, min: 20, max: 1000, step: 1 },
      { key: 'D', label: 'Depth D',  default: 50,  min: 10, max: 500,  step: 1 },
    ],
    derived: [
      { key: 'L1',  label: 'Length Allowance L1',  formula: '-2*OG' },
      { key: 'W1',  label: 'Width Allowance W1',   formula: 'CAL' },
      { key: 'D1',  label: 'Depth Allowance D1',   formula: '-OG' },
      { key: 'D2',  label: 'Depth Allowance D2',   formula: '-OG' },
      { key: 'KDFX',label: 'Sheet Length KDFX',    formula: '2*(D+D2)+L+L1' },
      { key: 'KDFY',label: 'Sheet Width KDFY',     formula: '2*(D+D1)+W+W1+2*SO' },
    ],
    compute: function(p) {
      p.L1  = -2 * AC.OG;
      p.W1  = AC.CAL;
      p.D1  = -AC.OG;
      p.D2  = -AC.OG;
      p.SO  = AC.SO;
      p.KDFX = 2 * (p.D + p.D2) + p.L + p.L1;
      p.KDFY = 2 * (p.D + p.D1) + p.W + p.W1 + 2 * p.SO;
      return p;
    },
    draw: draw0911
  },

  /* --- PILLOW: Pillow Box --- */
  {
    id: 'PILLOW',
    fefco: '',
    name: 'Pillow Box',
    category: 'Special',
    params: [
      { key: 'L', label: 'Length L', default: 120, min: 20, max: 500, step: 1 },
      { key: 'W', label: 'Width W',  default: 60,  min: 20, max: 500, step: 1 },
      { key: 'D', label: 'Curve D',   default: 25,  min: 5,  max: 100, step: 1 },
    ],
    derived: [
      { key: 'G',  label: 'Glue Tab G',  formula: 'JW (8mm)' },
      { key: 'CR', label: 'Curve Radius', formula: 'min(D*0.4, 15)' },
    ],
    compute: function(p) {
      p.G  = AC.JW;
      p.CR = Math.min(p.D * 0.4, 15);
      return p;
    },
    draw: drawPILLOW
  },

  /* --- GABLE: Gable Top Box --- */
  {
    id: 'GABLE',
    fefco: '',
    name: 'Gable Top Box',
    category: 'Special',
    params: [
      { key: 'L', label: 'Length L', default: 80,  min: 20, max: 500, step: 1 },
      { key: 'W', label: 'Width W',  default: 50,  min: 20, max: 500, step: 1 },
      { key: 'D', label: 'Height D', default: 100, min: 20, max: 500, step: 1 },
    ],
    derived: [
      { key: 'GT', label: 'Gable Height GT', formula: 'min(W/2, 40)' },
      { key: 'F',  label: 'Bottom Tuck F',   formula: 'min(W/2+IL, 25)' },
      { key: 'G',  label: 'Glue Tab G',        formula: 'JW (8mm)' },
    ],
    compute: function(p) {
      p.GT = Math.min(p.W / 2, 40);
      p.F  = Math.min(p.W / 2 + AC.IL, 25);
      p.G  = AC.JW;
      return p;
    },
    draw: drawGABLE
  },

  /* --- TRAY: Tray with Lid --- */
  {
    id: 'TRAY',
    fefco: '',
    name: 'Display Tray',
    category: 'Tray',
    params: [
      { key: 'L', label: 'Length L', default: 150, min: 20, max: 500, step: 1 },
      { key: 'W', label: 'Width W',  default: 100, min: 20, max: 500, step: 1 },
      { key: 'D', label: 'Wall Height D', default: 40, min: 10, max: 200, step: 1 },
    ],
    derived: [
      { key: 'L1',  label: 'Length Allowance L1', formula: 'CAL' },
      { key: 'W1',  label: 'Width Allowance W1',  formula: 'CAL' },
      { key: 'D1',  label: 'Depth Allowance D1',  formula: 'IL' },
      { key: 'D2',  label: 'Depth Allowance D2',  formula: 'IL' },
      { key: 'KDFL',label: 'Sheet Length KDFL',   formula: '2*(D+D2)+L+L1' },
      { key: 'KDFW',label: 'Sheet Width KDFW',    formula: '2*(D+D1)+W+W1' },
    ],
    compute: function(p) {
      p.L1  = AC.CAL;
      p.W1  = AC.CAL;
      p.D1  = AC.IL;
      p.D2  = AC.IL;
      p.KDFL = 2 * (p.D + p.D2) + p.L + p.L1;
      p.KDFW = 2 * (p.D + p.D1) + p.W + p.W1;
      return p;
    },
    draw: drawTRAY
  },
];

if (typeof window !== 'undefined') window.BoxTypes = BoxTypes;
