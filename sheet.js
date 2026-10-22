// ---------------------------------------------------------------------------
// Map sheet
//
// Draws the floor plan with its four QR anchors, at floor-plan pixel scale.
// Used by the printable map (map.html) and the map screen (display.html).
// Needs map.js and the qrcode-generator library.
// ---------------------------------------------------------------------------

// Resolves to a canvas holding the sheet, with `margin` pixels of white
// around the floor plan if any anchor sticks out past its edges.
function drawMapSheet() {
  const margin = Math.max(0, ...Object.values(MAP.anchors).flatMap(({ x, y }) => [
    -x, -y, x - MAP.width, y - MAP.height,
  ].map((overhang) => overhang + MAP.anchorSize / 2)));

  const canvas = document.createElement('canvas');
  canvas.width = MAP.width + margin * 2;
  canvas.height = MAP.height + margin * 2;
  canvas.margin = margin;
  const ctx = canvas.getContext('2d');

  return new Promise((resolve, reject) => {
    const plan = new Image();
    plan.onerror = reject;
    plan.onload = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(plan, margin, margin, MAP.width, MAP.height);

      for (const [text, { x, y }] of Object.entries(MAP.anchors)) {
        drawQr(ctx, text, margin + x - MAP.anchorSize / 2, margin + y - MAP.anchorSize / 2, MAP.anchorSize);
      }
      resolve(canvas);
    };
    plan.src = MAP.image;
  });
}

// Draws a code filling `size` square pixels, including its quiet zone.
// The quiet zone is painted white because the code sits on the plan.
function drawQr(ctx, text, left, top, size) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const QUIET_ZONE = 4;
  const count = qr.getModuleCount();
  const cell = size / (count + QUIET_ZONE * 2);

  ctx.fillStyle = '#fff';
  ctx.fillRect(left, top, size, size);
  ctx.fillStyle = '#000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        // Round to whole pixels so neighbouring modules don't leave seams.
        const x = Math.round(left + (col + QUIET_ZONE) * cell);
        const y = Math.round(top + (row + QUIET_ZONE) * cell);
        const nextX = Math.round(left + (col + QUIET_ZONE + 1) * cell);
        const nextY = Math.round(top + (row + QUIET_ZONE + 1) * cell);
        ctx.fillRect(x, y, nextX - x, nextY - y);
      }
    }
  }
}
