const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    // Prefer the rear camera on phones; laptops ignore this.
    facingMode: { ideal: 'environment' },
  },
  audio: false,
};

// ---------------------------------------------------------------------------
// Supply matching
//
// Three need cards and three resource cards. A need card is matched while
// its resource card is anywhere in the frame.
// ---------------------------------------------------------------------------

// Keys are the text inside the printed QR codes; `name` is the label shown.
const CARDS = {
  'object-a': { name: 'need-water', kind: 'need', type: 'water' },
  'object-c': { name: 'need-light', kind: 'need', type: 'light' },
  'object-b': { name: 'need-medicine', kind: 'need', type: 'medicine' },
  'bottle': { name: 'water', kind: 'resource', type: 'water' },
  'phone': { name: 'light', kind: 'resource', type: 'light' },
  'notebook': { name: 'medicine', kind: 'resource', type: 'medicine' },
  // Characters that move around the printed map (see cards.html). The
  // printed labels (MS-01 etc.) differ from the text inside the codes.
  // `reactions` override PLACE_REACTIONS for that one character.
  'bottle-empty': {
    name: 'MS-01',
    kind: 'mouse',
    reactions: { 'kitchen': { text: 'I want pizza?', sound: 'pizza' } },
  },
  'bottle-half': {
    name: 'MS-02',
    kind: 'mouse',
    reactions: { 'kitchen': { text: 'Are there vegs?', sound: 'veg' } },
  },
  'bottle-full': { name: 'HM-01', kind: 'human' },
};

const NEED_COLOR = '#ff0000';
const MATCHED_COLOR = '#00ff00';
const ANCHOR_COLOR = '#ffcc00';
const MAP_COLOR = 'rgba(0, 200, 255, 0.9)';

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
// So every ZOOM_EVERY frames, one region of the image (a 2x2 grid of
// overlapping regions, taken in turn) is enlarged and scanned instead. The
// other frames scan the whole picture, so moving cards update quickly.
const ZOOM = 2;
const ZOOM_REGION = 0.6;
const ZOOM_ORIGINS = [[0, 0], [1, 0], [0, 1], [1, 1]];
const ZOOM_EVERY = 3;

const zoomCanvas = document.createElement('canvas');
const zoomCtx = zoomCanvas.getContext('2d');
let nativeFrame = 0;
let zoomCycleStartedAt = 0;

async function runNativeDetection(detector) {
  if (video.readyState >= video.HAVE_ENOUGH_DATA) {
    try {
      if (nativeFrame % ZOOM_EVERY !== ZOOM_EVERY - 1) {
        reportNativeCodes(await detector.detect(video), { x: 0, y: 0, scale: 1 });
      } else {
        const region = prepareZoomRegion(Math.floor(nativeFrame / ZOOM_EVERY) % ZOOM_ORIGINS.length);
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
    origin: { x: 0, y: 0 },
    capturedAt: 0,
  };
});

let scanJobs = [];
let passStartedAt = 0;

function runPyramidDetection() {
  if (video.readyState >= video.HAVE_ENOUGH_DATA) {
    followTracks();

    // Following has its own time on top of the pyramid's budget, so a full
    // pass (and so finding new codes) doesn't slow down.
    const deadline = performance.now() + SCAN_BUDGET_MS;
    if (scanJobs.length === 0) {
      if (passStartedAt) {
        scanCycleMs = performance.now() - passStartedAt;
      }
      passStartedAt = performance.now();
      scanJobs = startPyramidPass();
    }

    // Always scan at least one tile, so new codes are still found while
    // following takes up most of the budget.
    do {
      scanTile(scanJobs.shift());
    } while (scanJobs.length > 0 && performance.now() < deadline);
  }

  requestAnimationFrame(runPyramidDetection);
}

// A full pyramid pass takes many frames, which makes cards being moved
// around feel sluggish. So every frame, each object already found is looked
// for again in a small window around where it was last seen, scaled so the
// code comes out at TARGET_QR_PX.
const FOLLOW_WINDOW = 3;
const FOLLOW_MAX_AGE_MS = 1000;

const follow = {
  canvas: document.createElement('canvas'),
  scale: 1,
  origin: { x: 0, y: 0 },
  capturedAt: 0,
};
follow.ctx = follow.canvas.getContext('2d', { willReadFrequently: true });

function followTracks() {
  const now = performance.now();
  // Copied first: a code found here can add to `tracks`.
  const targets = tracks.filter((track) => isZoneObject(track) && now - track.lastSeen < FOLLOW_MAX_AGE_MS);

  for (const track of targets) {
    const half = track.size * FOLLOW_WINDOW / 2;
    const x = Math.max(0, Math.round(track.center.x - half));
    const y = Math.max(0, Math.round(track.center.y - half));
    const width = Math.min(video.videoWidth, Math.round(track.center.x + half)) - x;
    const height = Math.min(video.videoHeight, Math.round(track.center.y + half)) - y;
    if (width <= 0 || height <= 0) {
      continue;
    }

    follow.scale = Math.min(1, TARGET_QR_PX / track.size);
    follow.origin = { x, y };
    follow.capturedAt = performance.now();
    const scaledWidth = Math.max(1, Math.round(width * follow.scale));
    const scaledHeight = Math.max(1, Math.round(height * follow.scale));
    if (follow.canvas.width !== scaledWidth || follow.canvas.height !== scaledHeight) {
      follow.canvas.width = scaledWidth;
      follow.canvas.height = scaledHeight;
    }
    follow.ctx.drawImage(video, x, y, width, height, 0, 0, scaledWidth, scaledHeight);

    // Stop as soon as the code turns up. A neighbouring card in the window
    // can be decoded first, so allow one more try after that.
    const region = { level: follow, x: 0, y: 0, width: scaledWidth, height: scaledHeight };
    for (let i = 0; i < 2 && track.lastSeen !== follow.capturedAt; i++) {
      if (scanTile(region, 1) === 0) {
        break;
      }
    }
    track.misses = track.lastSeen === follow.capturedAt ? 0 : (track.misses ?? 0) + 1;
  }
}

// Snapshot the current frame into every pyramid level and queue up all of
// their tiles, coarsest (largest codes, fewest tiles) first.
function startPyramidPass() {
  const jobs = [];

  for (const level of pyramid) {
    level.capturedAt = passStartedAt;
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

// Returns how many codes were found.
function scanTile({ level, x, y, width, height }, maxCodes = MAX_CODES_PER_TILE) {
  for (let i = 0; i < maxCodes; i++) {
    const tile = level.ctx.getImageData(x, y, width, height);
    const qrCode = jsQR(tile.data, width, height, { inversionAttempts: 'dontInvert' });
    if (!qrCode) {
      return i;
    }

    const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = qrCode.location;
    const inLevel = [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner]
      .map((point) => ({ x: point.x + x, y: point.y + y }));
    maskCode(level.ctx, inLevel);

    // Map the corners from level space back to full-resolution frame space.
    const [tl, tr, br, bl] = inLevel.map((point) => ({
      x: level.origin.x + point.x / level.scale,
      y: level.origin.y + point.y / level.scale,
    }));
    reportDetection(qrCode.data, {
      topLeftCorner: tl,
      topRightCorner: tr,
      bottomRightCorner: br,
      bottomLeftCorner: bl,
    }, level.capturedAt);
  }
  return maxCodes;
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

// `seenAt` is when the scanned picture was taken. A pyramid pass works from
// a snapshot for many frames, so its finds can be older than what following
// has already reported, and mustn't drag a moving card back.
function reportDetection(data, location, seenAt = performance.now()) {
  const card = parseCard(data);
  const center = centerOf(location);
  const size = sizeOf(location);

  // There's only one of each character, so a character card that jumped
  // further than usual (moved quickly) is still the same track rather than
  // a second copy left behind.
  const unique = card?.kind === 'mouse' || card?.kind === 'human';
  const existing = tracks.find((track) => {
    if (track.data !== data) {
      return false;
    }
    const distance = Math.hypot(track.center.x - center.x, track.center.y - center.y);
    return unique || distance < Math.max(track.size, size) * 1.5;
  });

  if (!existing) {
    tracks.push({ id: nextTrackId++, data, card, location, center, size, lastSeen: seenAt });
  } else if (seenAt >= existing.lastSeen) {
    Object.assign(existing, { location, center, size, lastSeen: seenAt });
  }
}

// Following looks for a code every frame, so once it has missed one several
// times in a row the card has most likely been taken away. It goes after
// MIN_TTL_MS then, rather than waiting out a whole pyramid pass.
const MIN_TTL_MS = 350;
const FOLLOW_MISSES = 8;

function pruneTracks(now) {
  const ttl = Math.max(MIN_TTL_MS, scanCycleMs * 1.5);
  for (let i = tracks.length - 1; i >= 0; i--) {
    const age = now - tracks[i].lastSeen;
    if (age > ttl || (age > MIN_TTL_MS && tracks[i].misses >= FOLLOW_MISSES)) {
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
// Map calibration
//
// The printed map (map.html) has a QR anchor at each corner. While all four
// are in frame, a homography is fitted from their centres in the frame to
// their known positions on the floor plan, so any code in the frame can be
// placed on the map. The last fit is kept when an anchor is briefly hidden
// (e.g. by a hand), on the assumption that the map and camera stay put.
// ---------------------------------------------------------------------------

let frameToMap = null;
let mapToFrame = null;
let calibrationLive = false;

function updateCalibration() {
  const frame = [];
  const map = [];
  for (const [text, position] of Object.entries(MAP.anchors)) {
    const track = tracks.find((t) => t.data.trim().toLowerCase() === text);
    if (!track) {
      calibrationLive = false;
      return;
    }
    frame.push(quadCenter(track.location));
    map.push(position);
  }

  const forward = solveHomography(frame, map);
  const inverse = solveHomography(map, frame);
  calibrationLive = Boolean(forward && inverse);
  if (calibrationLive) {
    frameToMap = forward;
    mapToFrame = inverse;
  }
}

// Under perspective the average of the corners drifts off-centre, but the
// diagonals still cross at the true centre of the code.
function quadCenter(location) {
  const [a, b, c, d] = cornersOf(location);
  const denom = (a.x - c.x) * (b.y - d.y) - (a.y - c.y) * (b.x - d.x);
  if (Math.abs(denom) < 1e-9) {
    return centerOf(location);
  }
  const t = ((a.x - b.x) * (b.y - d.y) - (a.y - b.y) * (b.x - d.x)) / denom;
  return { x: a.x + t * (c.x - a.x), y: a.y + t * (c.y - a.y) };
}

// Fits the 3x3 matrix H (with H[2][2] = 1) mapping four `src` points onto
// four `dst` points, by solving the standard 8x8 linear system.
function solveHomography(src, dst) {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(rows[pivot][col]) < 1e-9) {
      return null;
    }
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];

    for (let r = 0; r < 8; r++) {
      if (r !== col) {
        const factor = rows[r][col] / rows[col][col];
        for (let k = col; k < 9; k++) {
          rows[r][k] -= factor * rows[col][k];
        }
      }
    }
  }

  const h = rows.map((row, i) => row[8] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyHomography(h, { x, y }) {
  const w = h[6] * x + h[7] * y + h[8];
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}

// Where a track sits on the floor plan, and which room that is.
function placeOnMap(track) {
  if (!frameToMap) {
    return null;
  }
  const point = applyHomography(frameToMap, track.center);
  return { point, zone: zoneAt(point) };
}

// Location queries, handy from the console:
//   whereIs('need-water')   -> 'kitchen'
//   whoIsIn('mouse hole')   -> ['bottle', ...] or [] if empty
function whereIs(name) {
  const track = tracks.find((t) => (t.card?.name ?? t.data) === name);
  return track ? placeOnMap(track)?.zone ?? null : null;
}

function whoIsIn(zone) {
  return tracks
    .filter((t) => !isMapAnchor(t.data) && placeOnMap(t)?.zone === zone)
    .map((t) => t.card?.name ?? t.data);
}

// ---------------------------------------------------------------------------
// Zones
//
// "Is this object inside the zone?" The zones are the rooms on the floor
// plan, located with the map anchors. Each becomes a polygon in frame
// coordinates. Its outline is grey while it's empty and fills green once an
// object's centre is inside it.
// ---------------------------------------------------------------------------

const ZONE_EMPTY_COLOR = 'rgba(170, 170, 170, 0.95)';
const ZONE_FULL_COLOR = '#34c759';
const ZONE_FULL_FILL = 'rgba(52, 199, 89, 0.3)';

// Anything that isn't part of the map can be in a zone.
function isZoneObject(track) {
  return !isMapAnchor(track.data);
}

function currentZones() {
  if (!mapToFrame) {
    return [];
  }
  return MAP.zones.map((zone) => ({
    name: zone.name,
    polygon: rectCorners(zone).map((p) => applyHomography(mapToFrame, p)),
  }));
}

// Ray casting: count how many polygon edges a ray to the right crosses.
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function rectCorners(rect) {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

// ---------------------------------------------------------------------------
// Reactions
//
// From the Spatial Computing Mouse brief: a character's reaction depends on
// the room it is in, unless another character is right next to it.
//   object + location = status, and mouse + human / mouse + mouse = event.
// Each reaction shows a speech bubble and plays a short sound when it starts.
// ---------------------------------------------------------------------------

const PLACE_REACTIONS = {
  mouse: {
    'kitchen': { text: 'Food stolen!', sound: 'sneak' },
    'mouse hole': { text: 'Home sweet home. Safe!', sound: 'home' },
    'living room': { text: 'Scared of being killed!', sound: 'scared' },
  },
  human: {
    'kitchen': { text: 'Preparing Food', sound: 'cook' },
    'mouse hole': { text: 'The wall has a hole. Needs patching!', sound: 'fix' },
    'living room': { text: 'Relaxing...', sound: 'relax' },
  },
};

// Meetings involve two cards but show one bubble (see render).
const CAUGHT = { text: 'Caught! Game over', sound: 'gameover', shared: true };
const MICE_MEET = { text: 'Happy happy!!!', sound: 'happy', shared: true };
// Both mice in the kitchen at once, whether or not they're side by side.
const KITCHEN_RAID = { text: 'Food Stolen!', sound: 'sneak', shared: true, anywhere: true };

// Two characters "meet" when their centres are this many card widths apart.
const MEET_DISTANCE = 2.5;

function isNear(a, b) {
  const distance = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
  return distance < Math.max(a.size, b.size) * MEET_DISTANCE;
}

function reactionFor(track, zone) {
  const kind = track.card?.kind;
  if (kind !== 'mouse' && kind !== 'human') {
    return null;
  }

  // Most important first: getting caught, then raiding the kitchen together,
  // then meeting, then the room on its own.
  const others = tracks.filter((t) => t !== track && isNear(t, track));
  if (kind === 'mouse') {
    if (others.some((t) => t.card?.kind === 'human')) {
      return CAUGHT;
    }
    if (zone === 'kitchen' && tracks.some((t) =>
      t !== track && t.card?.kind === 'mouse' && placeOnMap(t)?.zone === 'kitchen')) {
      return KITCHEN_RAID;
    }
    if (others.some((t) => t.card?.kind === 'mouse')) {
      return MICE_MEET;
    }
  } else if (others.some((t) => t.card?.kind === 'mouse')) {
    return CAUGHT;
  }

  return track.card.reactions?.[zone] ?? PLACE_REACTIONS[kind][zone] ?? null;
}

// ---------------------------------------------------------------------------
// Matching and rendering
// ---------------------------------------------------------------------------

// Sound needs a tap first (see feedback.js), so ask for one until it's on.
const soundButton = document.getElementById('sound');
soundButton.addEventListener('click', () => {
  unlockAudio().then(() => soundButton.classList.toggle('hidden', soundOn()));
});

const thanksLayer = document.getElementById('thanks');
const thanksElements = new Map();

function render(now) {
  pruneTracks(now);
  updateCalibration();

  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  drawMap();
  const zones = currentZones();
  drawZones(zones);

  const shown = new Set();
  let gameOver = false;
  // Cards that already showed a meeting this frame, so their partner doesn't
  // repeat the same bubble and sound.
  const met = [];
  const characters = [];
  for (const track of tracks) {
    if (!isZoneObject(track)) {
      drawBox(track.location, ANCHOR_COLOR);
      continue;
    }

    const matched = isMatched(track);
    const color = track.card?.kind === 'need' && !matched ? NEED_COLOR : MATCHED_COLOR;
    drawBox(track.location, color);
    const name = track.card?.name ?? track.data;
    const zone = placeOnMap(track)?.zone;
    drawLabel(track.location, zone ? `${name} @ ${zone}` : name);

    const reaction = reactionFor(track, zone);
    const partnerShown = reaction?.shared &&
      met.some((other) => other.reaction === reaction && (reaction.anywhere || isNear(other, track)));
    // A paired map screen plays the sounds itself.
    if (reaction && reaction !== track.reaction && !partnerShown && !displayLink) {
      playSound(reaction.sound);
    }
    track.reaction = reaction;
    if (reaction && !partnerShown) {
      drawBubble(track.location, reaction.text);
      if (reaction.shared) {
        met.push(track);
      }
    }
    gameOver ||= reaction === CAUGHT;

    const onMap = placeOnMap(track);
    if (onMap && (track.card?.kind === 'mouse' || track.card?.kind === 'human')) {
      characters.push({
        id: track.id,
        name,
        kind: track.card.kind,
        x: onMap.point.x,
        y: onMap.point.y,
        radius: mapRadius(track),
        zone,
        bubble: reaction && !partnerShown ? reaction.text : null,
        sound: reaction?.sound ?? null,
      });
    }

    if (matched) {
      showThanks(track);
      shown.add(track.id);
    }
  }

  for (const [id, element] of thanksElements) {
    if (!shown.has(id)) {
      element.remove();
      thanksElements.delete(id);
    }
  }

  if (gameOver) {
    drawBanner(overlayCtx, 'GAME OVER');
  }

  soundButton.classList.toggle('hidden', soundOn());

  sendToDisplay({ type: 'state', calibrated: calibrationLive, gameOver, characters }, now);

  requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// Map screen link
//
// Opened as index.html?display=<id> (by scanning the code on display.html),
// this page acts as the camera for a map shown on a computer screen and
// streams what it sees there over a PeerJS data connection.
// ---------------------------------------------------------------------------

const DISPLAY_ID = new URLSearchParams(location.search).get('display');
const SEND_INTERVAL_MS = 50;
const RECONNECT_MS = 2000;

let displayLink = null;
let lastSentAt = 0;

if (DISPLAY_ID && 'Peer' in window) {
  const peer = new Peer();
  const connect = () => {
    const conn = peer.connect(DISPLAY_ID, { reliable: true });
    conn.on('open', () => {
      displayLink = conn;
    });
    conn.on('close', () => {
      displayLink = null;
      setTimeout(connect, RECONNECT_MS);
    });
  };
  peer.on('open', connect);
  peer.on('error', (error) => {
    // The screen isn't up yet (or was reloaded); keep trying.
    if (error.type === 'peer-unavailable') {
      setTimeout(connect, RECONNECT_MS);
    } else {
      console.warn('Map screen link:', error);
    }
  });
}

function sendToDisplay(message, now) {
  if (!displayLink?.open || now - lastSentAt < SEND_INTERVAL_MS) {
    return;
  }
  lastSentAt = now;
  displayLink.send(message);
}

// Half the card's diagonal, measured on the map, so the screen can draw a
// ring around the card at the right size.
function mapRadius(track) {
  const [tl, , br] = cornersOf(track.location).map((p) => applyHomography(frameToMap, p));
  return Math.hypot(br.x - tl.x, br.y - tl.y) / 2;
}

// A need card is matched while its resource card is anywhere in the frame.
function isMatched(track) {
  if (track.card?.kind !== 'need') {
    return false;
  }
  return tracks.some((other) => other.card?.kind === 'resource' && other.card.type === track.card.type);
}

// The image is a DOM element over the video (not drawn into the canvas) so
// animated GIFs keep playing. It sits in the centre of the screen, clear of
// the code, and is rotated to follow the need card's angle.
function showThanks(track) {
  let element = thanksElements.get(track.id);
  if (!element) {
    element = document.createElement('figure');
    element.className = 'thanks';
    element.innerHTML = '<img src="thank-you.jpg" alt="">';
    thanksLayer.appendChild(element);
    thanksElements.set(track.id, element);
  }

  // The video is scaled uniformly (object-fit: cover), so the code's angle in
  // the frame is the same as on screen.
  const { topLeftCorner, topRightCorner } = track.location;
  const angle = Math.atan2(topRightCorner.y - topLeftCorner.y, topRightCorner.x - topLeftCorner.x);
  element.style.transform = `rotate(${angle}rad)`;
}

// Outlines the floor plan on top of the video, so it's easy to see whether
// the calibration lines up. Dashed once an anchor is out of view. (The rooms
// themselves are drawn as zones.)
function drawMap() {
  if (!mapToFrame) {
    return;
  }

  overlayCtx.save();
  overlayCtx.strokeStyle = MAP_COLOR;
  overlayCtx.lineWidth = Math.max(2, overlay.width * 0.003);
  overlayCtx.setLineDash(calibrationLive ? [] : [12, 8]);
  tracePolygon(rectCorners({ x: 0, y: 0, width: MAP.width, height: MAP.height })
    .map((p) => applyHomography(mapToFrame, p)));
  overlayCtx.stroke();
  overlayCtx.restore();
}

// The zone indicator: each zone's outline, filled green while any object's
// centre is inside it, with the zone's name in the middle.
function drawZones(zones) {
  const objects = tracks.filter(isZoneObject);
  const lineWidth = Math.max(3, overlay.width * 0.004);
  const fontSize = Math.max(16, overlay.width * 0.018);

  overlayCtx.save();
  for (const { name, polygon } of zones) {
    const occupied = objects.some((track) => pointInPolygon(track.center, polygon));

    tracePolygon(polygon);
    if (occupied) {
      overlayCtx.fillStyle = ZONE_FULL_FILL;
      overlayCtx.fill();
    }
    overlayCtx.strokeStyle = occupied ? ZONE_FULL_COLOR : ZONE_EMPTY_COLOR;
    overlayCtx.lineWidth = lineWidth;
    overlayCtx.stroke();

    const cx = polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length;
    const cy = polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length;
    overlayCtx.font = `bold ${fontSize}px sans-serif`;
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.lineWidth = fontSize * 0.25;
    overlayCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    overlayCtx.strokeText(name, cx, cy);
    overlayCtx.fillStyle = occupied ? ZONE_FULL_COLOR : '#fff';
    overlayCtx.fillText(name, cx, cy);
  }
  overlayCtx.restore();
}

function tracePolygon(points) {
  overlayCtx.beginPath();
  points.forEach((p, i) => (i === 0 ? overlayCtx.moveTo(p.x, p.y) : overlayCtx.lineTo(p.x, p.y)));
  overlayCtx.closePath();
}

function drawBox(location, color) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.006);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

// A speech bubble above the card, pointing down at it.
function drawBubble(location, text) {
  const points = cornersOf(location);
  const cx = points.reduce((sum, p) => sum + p.x, 0) / 4;
  const top = Math.min(...points.map((p) => p.y));
  drawSpeechBubble(overlayCtx, cx, top, text, Math.max(18, overlay.width * 0.022));
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
