const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

// ---------------------------------------------------------------------------
// Supply matching
//
// Three need cards and three resource cards. Holding the matching
// resource next to a need resolves it.
// ---------------------------------------------------------------------------

const CARDS = {
  'object-a': { kind: 'need', type: 'water', label: 'Need water', resolved: 'Has water now' },
  'object-b': { kind: 'need', type: 'medicine', label: 'Need medicine', resolved: 'Has medicine now' },
  'object-c': { kind: 'need', type: 'light', label: 'Need light', resolved: 'Has light now' },
  'bottle': { kind: 'resource', type: 'water', label: 'Water' },
  'notebook': { kind: 'resource', type: 'medicine', label: 'Medicine' },
  'phone': { kind: 'resource', type: 'light', label: 'Light' },
};

// A resource counts as "delivered" to a need when the two codes are within
// this many code-widths of each other. Measuring in code-widths (instead of
// pixels) keeps the rule the same whether the cards are near or far from
// the camera.
const MATCH_RANGE = 2;
// How long a correct pair has to stay together before the need is resolved,
// so a card sliding past doesn't trigger it by accident.
const HOLD_MS = 700;

function parseCard(text) {
  return CARDS[text.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Camera setup
// ---------------------------------------------------------------------------

navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
  .then((stream) => {
    video.srcObject = stream;
    // Continuous autofocus helps codes held close to the lens stay sharp.
    // Browsers that don't support it just ignore the request.
    const [track] = stream.getVideoTracks();
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  })
  .catch((error) => {
    console.error('Unable to access webcam:', error);
  });

let started = false;

video.addEventListener('loadedmetadata', () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  if (!started) {
    started = true;
    startDetection();
    requestAnimationFrame(render);
  }
});

// ---------------------------------------------------------------------------
// Detection
//
// Codes can appear anywhere from tiny (card far from the camera) to filling
// the frame (card held right in front of it). Two strategies:
//
// 1. The browser's native BarcodeDetector (Chrome/Edge). It finds every code
//    in a frame at any size and is fast, so it's used whenever available.
// 2. A jsQR fallback. jsQR only decodes one code per call and struggles when
//    a code is much bigger or smaller than it expects, so the frame is
//    scanned as an image pyramid: several downscaled copies, each tiled into
//    overlapping windows sized for one band of code sizes.
// ---------------------------------------------------------------------------

// How long it takes to sweep every scale once. Tracks must outlive this, or
// codes only found at one scale would blink in and out.
let scanCycleMs = 0;

async function startDetection() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        runNativeDetection(detector);
        return;
      }
    } catch (error) {
      console.warn('BarcodeDetector unavailable, falling back to jsQR:', error);
    }
  }

  runPyramidDetection();
}

// Codes far from the camera can be too small for the detector to resolve.
// So every other frame, one region of the image (a 2x2 grid of overlapping
// regions, taken in turn) is enlarged and scanned as well.
const ZOOM = 2;
const ZOOM_REGION = 0.6;
const ZOOM_ORIGINS = [[0, 0], [1, 0], [0, 1], [1, 1]];

const zoomCanvas = document.createElement('canvas');
const zoomCtx = zoomCanvas.getContext('2d');
let nativeFrame = 0;
let zoomCycleStartedAt = 0;

async function runNativeDetection(detector) {
  if (video.readyState >= video.HAVE_ENOUGH_DATA) {
    try {
      if (nativeFrame % 2 === 0) {
        reportNativeCodes(await detector.detect(video), { x: 0, y: 0, scale: 1 });
      } else {
        const region = prepareZoomRegion((nativeFrame - 1) / 2 % ZOOM_ORIGINS.length);
        reportNativeCodes(await detector.detect(zoomCanvas), region);
      }
    } catch (error) {
      console.error('Detection failed:', error);
    }
    nativeFrame++;
  }

  requestAnimationFrame(() => runNativeDetection(detector));
}

function prepareZoomRegion(index) {
  if (index === 0) {
    const now = performance.now();
    if (zoomCycleStartedAt) {
      scanCycleMs = now - zoomCycleStartedAt;
    }
    zoomCycleStartedAt = now;
  }

  const width = Math.round(video.videoWidth * ZOOM_REGION);
  const height = Math.round(video.videoHeight * ZOOM_REGION);
  const [col, row] = ZOOM_ORIGINS[index];
  const x = col * (video.videoWidth - width);
  const y = row * (video.videoHeight - height);

  if (zoomCanvas.width !== width * ZOOM || zoomCanvas.height !== height * ZOOM) {
    zoomCanvas.width = width * ZOOM;
    zoomCanvas.height = height * ZOOM;
  }
  zoomCtx.imageSmoothingQuality = 'high';
  zoomCtx.drawImage(video, x, y, width, height, 0, 0, zoomCanvas.width, zoomCanvas.height);

  return { x, y, scale: ZOOM };
}

// Map corners from the scanned image back to full-resolution frame space.
function reportNativeCodes(codes, { x, y, scale }) {
  for (const code of codes) {
    const [tl, tr, br, bl] = code.cornerPoints.map((point) => ({
      x: x + point.x / scale,
      y: y + point.y / scale,
    }));
    reportDetection(code.rawValue, {
      topLeftCorner: tl,
      topRightCorner: tr,
      bottomRightCorner: br,
      bottomLeftCorner: bl,
    });
  }
}

// Each level targets codes of roughly `qrSize` pixels in the source frame.
// The level is downscaled so those codes come out around TARGET_QR_PX, which
// is a size jsQR decodes reliably, and so big codes are cheap to scan.
const PYRAMID_LEVELS = [1000, 420, 180, 80];
const TARGET_QR_PX = 90;
// Windows are three code-widths wide and step by two, so neighbouring
// windows overlap by one code-width and no code can fall across a seam.
const TILE_FACTOR = 3;
const STEP_FACTOR = 2;
// Milliseconds of jsQR work per animation frame; the rest of a pass carries
// over to the next frame so the page stays responsive.
const SCAN_BUDGET_MS = 24;

const pyramid = PYRAMID_LEVELS.map((qrSize) => {
  const canvas = document.createElement('canvas');
  return {
    qrSize,
    canvas,
    ctx: canvas.getContext('2d', { willReadFrequently: true }),
    scale: 1,
  };
});

let scanJobs = [];
let passStartedAt = 0;

function runPyramidDetection() {
  if (video.readyState >= video.HAVE_ENOUGH_DATA) {
    if (scanJobs.length === 0) {
      if (passStartedAt) {
        scanCycleMs = performance.now() - passStartedAt;
      }
      scanJobs = startPyramidPass();
      passStartedAt = performance.now();
    }

    const deadline = performance.now() + SCAN_BUDGET_MS;
    while (scanJobs.length > 0 && performance.now() < deadline) {
      scanTile(scanJobs.shift());
    }
  }

  requestAnimationFrame(runPyramidDetection);
}

// Snapshot the current frame into every pyramid level and queue up all of
// their tiles, coarsest (largest codes, fewest tiles) first.
function startPyramidPass() {
  const jobs = [];

  for (const level of pyramid) {
    level.scale = Math.min(1, TARGET_QR_PX / level.qrSize);
    const width = Math.round(video.videoWidth * level.scale);
    const height = Math.round(video.videoHeight * level.scale);
    if (level.canvas.width !== width || level.canvas.height !== height) {
      level.canvas.width = width;
      level.canvas.height = height;
    }
    level.ctx.drawImage(video, 0, 0, width, height);

    const qrPx = level.qrSize * level.scale;
    const tileWidth = Math.min(width, Math.round(qrPx * TILE_FACTOR));
    const tileHeight = Math.min(height, Math.round(qrPx * TILE_FACTOR));
    const step = Math.round(qrPx * STEP_FACTOR);

    for (const y of getTilePositions(height, tileHeight, step)) {
      for (const x of getTilePositions(width, tileWidth, step)) {
        jobs.push({ level, x, y, width: tileWidth, height: tileHeight });
      }
    }
  }

  return jobs;
}

// Start offsets for tiles of `tile` covering `dimension`, stepping by `step`
// and with a final tile flush against the far edge so the whole frame is
// covered even when it doesn't divide evenly by the step.
function getTilePositions(dimension, tile, step) {
  if (dimension <= tile) {
    return [0];
  }

  const positions = [];
  for (let pos = 0; pos + tile <= dimension; pos += step) {
    positions.push(pos);
  }

  const lastPosition = dimension - tile;
  if (positions[positions.length - 1] !== lastPosition) {
    positions.push(lastPosition);
  }

  return positions;
}

// Need and resource cards sit right next to each other, so a tile often
// holds more than one code. jsQR only returns one per call, so after each
// hit the code is painted over and the same tile is scanned again.
const MAX_CODES_PER_TILE = 4;

function scanTile({ level, x, y, width, height }) {
  for (let i = 0; i < MAX_CODES_PER_TILE; i++) {
    const tile = level.ctx.getImageData(x, y, width, height);
    const qrCode = jsQR(tile.data, width, height, { inversionAttempts: 'dontInvert' });
    if (!qrCode) {
      return;
    }

    const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = qrCode.location;
    const inLevel = [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner]
      .map((point) => ({ x: point.x + x, y: point.y + y }));
    maskCode(level.ctx, inLevel);

    // Map the corners from level space back to full-resolution frame space.
    const [tl, tr, br, bl] = inLevel.map((point) => ({
      x: point.x / level.scale,
      y: point.y / level.scale,
    }));
    reportDetection(qrCode.data, {
      topLeftCorner: tl,
      topRightCorner: tr,
      bottomRightCorner: br,
      bottomLeftCorner: bl,
    });
  }
}

// jsQR's corners sit on the finder pattern centres, so grow the quad a bit
// before filling it to make sure the whole code is covered.
function maskCode(ctx, corners) {
  const cx = corners.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = corners.reduce((sum, p) => sum + p.y, 0) / 4;
  const grow = 1.4;

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  corners.forEach((p, i) => {
    const px = cx + (p.x - cx) * grow;
    const py = cy + (p.y - cy) * grow;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Tracking
//
// Detections are folded into tracks that persist briefly after a code is
// last seen. This dedupes the same code found in several pyramid tiles,
// and stops overlays flickering when a code is missed for a frame or two.
// ---------------------------------------------------------------------------

const tracks = [];
let nextTrackId = 1;

function reportDetection(data, location) {
  const card = parseCard(data);
  const center = centerOf(location);
  const size = sizeOf(location);
  const now = performance.now();

  const existing = tracks.find((track) => {
    if (track.data !== data) {
      return false;
    }
    const distance = Math.hypot(track.center.x - center.x, track.center.y - center.y);
    return distance < Math.max(track.size, size) * 1.5;
  });

  if (existing) {
    Object.assign(existing, { location, center, size, lastSeen: now });
  } else {
    tracks.push({ id: nextTrackId++, data, card, location, center, size, lastSeen: now });
  }
}

function pruneTracks(now) {
  const ttl = Math.max(350, scanCycleMs * 1.5);
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (now - tracks[i].lastSeen > ttl) {
      tracks.splice(i, 1);
    }
  }
}

function centerOf(location) {
  const points = cornersOf(location);
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / 4,
    y: points.reduce((sum, p) => sum + p.y, 0) / 4,
  };
}

// Average side length, used as the code's apparent size.
function sizeOf(location) {
  const points = cornersOf(location);
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total / 4;
}

function cornersOf(location) {
  return [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
}

// ---------------------------------------------------------------------------
// Matching and rendering
// ---------------------------------------------------------------------------

function render(now) {
  pruneTracks(now);

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  for (const track of tracks) {
    drawBox(track.location);
    drawLabel(track.location, labelFor(track, now));
  }

  requestAnimationFrame(render);
}

function labelFor(track, now) {
  const { data, card } = track;
  if (!card) {
    return data;
  }

  if (card.kind === 'resource') {
    const need = nearestNeed(track);
    if (!need) {
      track.pairTarget = null;
    }
    if (need && need.card.type === track.card.type && heldFor(track, need, now) < HOLD_MS) {
      return `${card.label} - delivering...`;
    }
    return card.label;
  }

  const resource = resourceFor(track);
  if (!resource) {
    return card.label;
  }
  if (resource.card.type !== card.type) {
    return `${card.label} - that's not what I need`;
  }
  if (heldFor(resource, track, now) >= HOLD_MS) {
    return card.resolved;
  }
  return card.label;
}

// The need card within range of this resource card, closest first.
function nearestNeed(resource) {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const need of tracks) {
    if (need.card?.kind !== 'need') {
      continue;
    }
    const distance = Math.hypot(need.center.x - resource.center.x, need.center.y - resource.center.y);
    const range = MATCH_RANGE * (need.size + resource.size) / 2;
    if (distance < range && distance < nearestDistance) {
      nearest = need;
      nearestDistance = distance;
    }
  }

  return nearest;
}

// The resource card currently delivering to this need card, if any. A
// matching resource wins over a wrong one when both are nearby.
function resourceFor(need) {
  const candidates = tracks.filter((track) => track.card?.kind === 'resource' && nearestNeed(track) === need);
  return candidates.find((track) => track.card.type === need.card.type) ?? candidates[0] ?? null;
}

// How long `resource` has been paired with `need`. Restarts whenever the
// resource moves to a different need.
function heldFor(resource, need, now) {
  if (resource.pairTarget !== need.id) {
    resource.pairTarget = need.id;
    resource.pairStart = now;
  }
  return now - resource.pairStart;
}

function drawBox(location) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = '#00ff00';
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.006);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

function drawLabel(location, text) {
  const { bottomLeftCorner, bottomRightCorner } = location;

  const fontSize = Math.max(16, overlay.width * 0.02);
  const padding = fontSize * 0.25;
  const x = Math.min(bottomLeftCorner.x, bottomRightCorner.x);
  const y = Math.max(bottomLeftCorner.y, bottomRightCorner.y) + padding;

  overlayCtx.font = `${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(x - padding, y - padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = '#00ff00';
  overlayCtx.fillText(text, x, y);
}
