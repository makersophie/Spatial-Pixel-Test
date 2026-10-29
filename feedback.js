// ---------------------------------------------------------------------------
// Feedback: sounds and speech bubbles
//
// Shared by the camera tracker (index.html) and the map screen
// (display.html), so a reaction looks and sounds the same on either.
// ---------------------------------------------------------------------------

// Short synthesised jingles, as [frequency Hz, seconds] notes.
const SOUNDS = {
  sneak: [[660, 0.08], [880, 0.08], [660, 0.08]],
  home: [[523, 0.15], [659, 0.15], [784, 0.3]],
  scared: [[220, 0.12], [208, 0.12], [196, 0.35]],
  cook: [[440, 0.1], [0, 0.05], [440, 0.1]],
  fix: [[300, 0.07], [0, 0.07], [300, 0.07], [0, 0.07], [300, 0.07]],
  relax: [[392, 0.35], [330, 0.45]],
  gameover: [[392, 0.2], [330, 0.2], [262, 0.6]],
  happy: [[784, 0.1], [988, 0.1], [1175, 0.1], [1568, 0.25]],
  // Rising, like a question.
  pizza: [[523, 0.1], [659, 0.1], [880, 0.2]],
  veg: [[440, 0.1], [494, 0.1], [659, 0.2]],
  // Mouse Strikes Back (battle.js).
  help: [[880, 0.1], [0, 0.05], [880, 0.1], [0, 0.05], [880, 0.1]],
  tick: [[880, 0.08]],
  fight: [[523, 0.08], [659, 0.08], [784, 0.08], [1047, 0.3]],
  bite: [[180, 0.05], [120, 0.1]],
  swat: [[1200, 0.03], [300, 0.12]],
  combo: [[660, 0.06], [880, 0.06], [1320, 0.2]],
  ko: [[400, 0.1], [300, 0.1], [200, 0.3]],
  micewin: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.15], [784, 0.1], [1047, 0.4]],
  humanwin: [[392, 0.15], [523, 0.15], [392, 0.15], [262, 0.5]],
};

// Browsers only allow audio after the user interacts with the page, so the
// first tap or click anywhere turns sound on. iPhones only count the end of
// a tap, so every kind of tap and key press is listened for.
let audio = null;

function unlockAudio() {
  audio ??= new AudioContext();
  return audio.resume();
}

function soundOn() {
  return audio?.state === 'running';
}

for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) {
  window.addEventListener(type, unlockAudio);
}

function playSound(name) {
  if (!soundOn() || !SOUNDS[name]) {
    return;
  }
  let at = audio.currentTime;
  for (const [frequency, duration] of SOUNDS[name]) {
    if (frequency > 0) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.08, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + duration);
    }
    at += duration;
  }
}

// A white speech bubble whose tail points down at (cx, bottom).
function drawSpeechBubble(ctx, cx, bottom, text, fontSize) {
  const padding = fontSize * 0.5;
  const tail = fontSize * 0.6;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(text).width + padding * 2;
  const height = fontSize + padding * 2;
  const x = Math.min(Math.max(cx - width / 2, 0), ctx.canvas.width - width);
  const y = Math.max(bottom - tail - height, 0);

  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(2, fontSize * 0.1);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, fontSize * 0.4);
  ctx.moveTo(cx - tail * 0.6, y + height);
  ctx.lineTo(cx, y + height + tail);
  ctx.lineTo(cx + tail * 0.6, y + height);
  ctx.fill();
  ctx.stroke();
  // Hide the bubble's bottom edge where the tail joins it.
  ctx.fillRect(cx - tail * 0.6 + ctx.lineWidth, y + height - ctx.lineWidth,
    tail * 1.2 - ctx.lineWidth * 2, ctx.lineWidth * 2);

  ctx.fillStyle = '#000';
  ctx.fillText(text, x + padding, y + height / 2);
}

// A banner across the middle of the canvas.
function drawBanner(ctx, text) {
  const { width, height } = ctx.canvas;
  const fontSize = width * 0.09;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(0, height / 2 - fontSize, width, fontSize * 2);
  ctx.fillStyle = '#ff3b30';
  ctx.fillText(text, width / 2, height / 2);
  ctx.textAlign = 'start';
}
