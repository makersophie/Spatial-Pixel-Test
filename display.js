// ---------------------------------------------------------------------------
// Map screen
//
// Shows the map full screen so a computer monitor can stand in for the
// printed sheet. A phone running the camera page (index.html?display=<id>)
// films the screen with the character cards on it and sends what it sees
// here over a peer-to-peer link; this page draws each character's reaction
// on the map itself and plays its sound.
// ---------------------------------------------------------------------------

const mapCanvas = document.getElementById('screen');
const screenCtx = mapCanvas.getContext('2d');
const statusText = document.getElementById('status-text');
const pairPanel = document.getElementById('pair');
const showPairButton = document.getElementById('show-pair');

// The phone needs HTTPS for its camera, so when this page is opened from a
// local server the pairing code points at the published site instead.
const PUBLISHED_URL = 'https://makersophie.github.io/Spatial-Pixel-Test/';

const RING_COLORS = { mouse: '#ff9500', human: '#007aff' };

// Characters drop off the map if the phone hasn't mentioned them lately,
// e.g. because the link stalled.
const STALE_MS = 1000;

let sheet = null;
let state = { characters: [], calibrated: false, gameOver: false };
let lastMessageAt = 0;
let phoneConnected = false;
const lastReactions = new Map();

drawMapSheet().then((canvas) => {
  sheet = canvas;
  requestAnimationFrame(render);
});

// ---------------------------------------------------------------------------
// Pairing
//
// The peer id is kept between visits so a phone that was already paired can
// reconnect after this page is reloaded.
// ---------------------------------------------------------------------------

const ID_KEY = 'spatial-pixel-display-id';

function savedId() {
  try {
    return localStorage.getItem(ID_KEY);
  } catch {
    return null;
  }
}

function saveId(id) {
  try {
    localStorage.setItem(ID_KEY, id);
  } catch {
    // Pairing still works for this visit.
  }
}

function startPeer(id) {
  const peer = new Peer(id);

  peer.on('open', (openId) => {
    saveId(openId);
    showPairingCode(openId);
    setStatus('Waiting for phone');
  });

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      phoneConnected = true;
      pairPanel.classList.add('hidden');
      showPairButton.classList.remove('hidden');
      setStatus('Phone connected');
    });
    conn.on('data', (message) => {
      if (message?.type === 'state') {
        state = message;
        lastMessageAt = performance.now();
      }
    });
    conn.on('close', () => {
      phoneConnected = false;
      setStatus('Phone disconnected');
    });
  });

  peer.on('error', (error) => {
    if (error.type === 'unavailable-id') {
      // Another tab already holds the saved id; take a fresh one.
      peer.destroy();
      startPeer(newId());
    } else {
      setStatus(`Connection problem: ${error.type}`);
    }
  });

  // The signalling server drops idle peers; reconnect so new phones can pair.
  peer.on('disconnected', () => peer.reconnect());
}

function newId() {
  return `spatial-pixel-${Math.random().toString(36).slice(2, 10)}`;
}

function showPairingCode(id) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const url = new URL('index.html', local ? PUBLISHED_URL : location.href);
  url.searchParams.set('display', id);

  const qr = qrcode(0, 'M');
  qr.addData(url.href);
  qr.make();
  document.getElementById('pair-qr').src = qr.createDataURL(8, 4);
  const link = document.getElementById('pair-link');
  link.href = url.href;
  link.textContent = url.href;
}

function setStatus(text) {
  statusText.textContent = text;
}

startPeer(savedId() ?? newId());

document.getElementById('fullscreen').addEventListener('click', () => {
  document.documentElement.requestFullscreen?.();
});

showPairButton.addEventListener('click', () => {
  pairPanel.classList.toggle('hidden');
});

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function render(now) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(mapCanvas.clientWidth * dpr);
  const height = Math.round(mapCanvas.clientHeight * dpr);
  if (mapCanvas.width !== width || mapCanvas.height !== height) {
    mapCanvas.width = width;
    mapCanvas.height = height;
  }

  // Fit the whole sheet on screen, centred, so all four anchors show.
  const scale = Math.min(width / sheet.width, height / sheet.height);
  const left = (width - sheet.width * scale) / 2;
  const top = (height - sheet.height * scale) / 2;
  const toScreen = ({ x, y }) => ({
    x: left + (sheet.margin + x) * scale,
    y: top + (sheet.margin + y) * scale,
  });

  screenCtx.fillStyle = '#fff';
  screenCtx.fillRect(0, 0, width, height);
  screenCtx.drawImage(sheet, left, top, sheet.width * scale, sheet.height * scale);

  const fresh = now - lastMessageAt < STALE_MS;
  const characters = fresh ? state.characters : [];

  for (const character of characters) {
    const center = toScreen(character);
    const radius = character.radius * scale * 1.6;

    screenCtx.strokeStyle = RING_COLORS[character.kind] ?? '#000';
    screenCtx.lineWidth = Math.max(4, radius * 0.12);
    screenCtx.beginPath();
    screenCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    screenCtx.stroke();

    if (character.bubble) {
      drawSpeechBubble(screenCtx, center.x, center.y - radius, character.bubble, Math.max(16, width * 0.016));
    }

    // Play a reaction's sound once, when it first appears.
    if (character.bubble && character.bubble !== lastReactions.get(character.id)) {
      playSound(character.sound);
    }
    lastReactions.set(character.id, character.bubble);
  }

  if (fresh && state.battle) {
    drawBanner(screenCtx, state.battle);
  } else if (fresh && state.gameOver) {
    drawBanner(screenCtx, 'GAME OVER');
  }

  if (phoneConnected) {
    if (!fresh) {
      setStatus('Phone connected, no picture yet');
    } else if (!state.calibrated) {
      setStatus('Phone can’t see all four corner codes');
    } else {
      setStatus(`Tracking ${characters.length} character${characters.length === 1 ? '' : 's'}`);
    }
  }

  requestAnimationFrame(render);
}
