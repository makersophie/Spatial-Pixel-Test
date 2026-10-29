// ---------------------------------------------------------------------------
// Battle: Mouse Strikes Back
//
// When the human meets both mice at once, the camera page turns into a
// fight. The cards are the controllers: pull a card away, then charge it
// back into an opponent to land a hit. Whoever was moving faster at the
// moment of contact is the attacker.
//   mouse charges the human  BITE, the human loses 10
//   both mice bite within 1s COMBO, the human loses 10 more
//   human charges a mouse    SWAT, that mouse loses 20
// The mice win by taking the human to 0, the human by knocking out both
// mice. When the minute runs out, the side with more health left wins.
// Needs script.js (tracks, isNear, miceSurroundHuman) and feedback.js.
// ---------------------------------------------------------------------------

const BATTLE = {
  humanHp: 100,
  mouseHp: 50,
  biteDamage: 10,
  comboDamage: 10,
  swatDamage: 20,
  comboWindowMs: 1000,
  countdownMs: 3000,
  durationMs: 60000,
  resultMs: 5000,
  // Give up if no fighter has been seen for this long.
  lostMs: 5000,
  // In code widths, like MEET_DISTANCE: a hit lands when two cards come as
  // close as a meeting, and they must move this far apart again before
  // they can land another. (A printed card is about three codes wide.)
  hitDistance: MEET_DISTANCE,
  apartDistance: 4,
};

const FIGHTERS = {
  'HM-01': { kind: 'human', icon: '🧑‍🍳' },
  'MS-01': { kind: 'mouse', icon: '🐭' },
  'MS-02': { kind: 'mouse', icon: '🐭' },
};

const battleLayer = document.getElementById('battle');
const battleField = battleLayer.querySelector('.battle-field');
const battleMessage = battleLayer.querySelector('.battle-message');
const battleTimer = battleLayer.querySelector('.battle-timer');

let battle = null;
// A new battle only starts once the three have moved apart after the last.
let battleArmed = true;
// Recent speed of each fighter, in code widths per second.
const motion = new Map();

// Called every frame by render(). Returns true while the battle screen is
// up, in which case the normal map view is skipped.
function updateBattle(now) {
  const fighters = tracks.filter((t) => FIGHTERS[t.card?.name]);
  trackMotion(fighters, now);

  if (!battle) {
    if (!miceSurroundHuman()) {
      battleArmed = true;
    } else if (battleArmed) {
      startBattle(now);
    }
    if (!battle) {
      return false;
    }
  }

  stepBattle(now, fighters);
  if (battle) {
    drawBattle(now, fighters);
  }
  return Boolean(battle);
}

// Keeps the fastest recent speed, fading over a quarter second, so a card
// that just charged still counts as the attacker when the hit is checked.
// A card moved fast enough to blur can drop out for a moment; when it comes
// back, the jump over that gap still counts as movement.
function trackMotion(fighters, now) {
  for (const track of fighters) {
    const name = track.card.name;
    const last = motion.get(name);
    if (!last) {
      motion.set(name, { x: track.center.x, y: track.center.y, t: now, speed: 0 });
      continue;
    }
    const dt = (now - last.t) / 1000;
    if (dt <= 0) {
      continue;
    }
    const moved = Math.hypot(track.center.x - last.x, track.center.y - last.y) / track.size;
    const speed = Math.max(moved / dt, last.speed * Math.exp(-dt / 0.25));
    motion.set(name, { x: track.center.x, y: track.center.y, t: now, speed });
  }
}

function startBattle(now) {
  battleArmed = false;
  battle = {
    phase: 'countdown',
    phaseAt: now,
    seenAt: now,
    hp: { 'HM-01': BATTLE.humanHp, 'MS-01': BATTLE.mouseHp, 'MS-02': BATTLE.mouseHp },
    // Per mouse: 'apart' once it has backed off, 'touching' after a hit.
    contact: new Map(),
    lastBite: new Map(),
    count: null,
    winner: null,
  };

  battleField.replaceChildren();
  for (const [name, { kind, icon }] of Object.entries(FIGHTERS)) {
    const element = document.createElement('div');
    element.className = `fighter ${kind}`;
    element.dataset.name = name;
    element.innerHTML = `<span class="icon">${icon}</span><span class="name">${name}</span>`;
    battleField.appendChild(element);
  }
  battleLayer.hidden = false;
  playSound('fight');
}

function stepBattle(now, fighters) {
  const elapsed = now - battle.phaseAt;
  if (fighters.length > 0) {
    battle.seenAt = now;
  } else if (now - battle.seenAt > BATTLE.lostMs && battle.phase !== 'result') {
    endBattle();
    return;
  }

  if (battle.phase === 'countdown') {
    const count = Math.ceil((BATTLE.countdownMs - elapsed) / 1000);
    if (count !== battle.count) {
      battle.count = count;
      if (count > 0) {
        setMessage(String(count), 'count');
        playSound('tick');
      }
    }
    if (elapsed >= BATTLE.countdownMs) {
      battle.phase = 'fight';
      battle.phaseAt = now;
      setMessage('FIGHT!', 'fight');
      playSound('fight');
    }
    return;
  }

  if (battle.phase === 'result') {
    if (elapsed >= BATTLE.resultMs) {
      endBattle();
    }
    return;
  }

  if (elapsed > 800) {
    setMessage('', '');
  }

  const human = fighters.find((t) => t.card.kind === 'human');
  if (human) {
    for (const mouse of fighters.filter((t) => t.card.kind === 'mouse')) {
      checkContact(now, human, mouse);
    }
  }

  const miceHp = battle.hp['MS-01'] + battle.hp['MS-02'];
  if (battle.hp['HM-01'] <= 0) {
    finish(now, 'mice');
  } else if (miceHp <= 0) {
    finish(now, 'human');
  } else if (elapsed >= BATTLE.durationMs) {
    const humanLeft = battle.hp['HM-01'] / BATTLE.humanHp;
    const miceLeft = miceHp / (BATTLE.mouseHp * 2);
    finish(now, miceLeft >= humanLeft ? 'mice' : 'human');
  }
}

function checkContact(now, human, mouse) {
  const name = mouse.card.name;
  if (battle.hp[name] <= 0) {
    return;
  }

  const distance = Math.hypot(human.center.x - mouse.center.x, human.center.y - mouse.center.y) /
    Math.max(human.size, mouse.size);
  // Cards that are already together when the fight starts must part first.
  const state = battle.contact.get(name) ?? 'touching';

  if (state === 'touching') {
    if (distance > BATTLE.apartDistance) {
      battle.contact.set(name, 'apart');
    }
    return;
  }
  if (distance >= BATTLE.hitDistance) {
    return;
  }

  battle.contact.set(name, 'touching');
  const mouseSpeed = motion.get(name)?.speed ?? 0;
  const humanSpeed = motion.get('HM-01')?.speed ?? 0;

  if (mouseSpeed >= humanSpeed) {
    damage('HM-01', BATTLE.biteDamage, 'BITE!');
    playSound('bite');
    battle.lastBite.set(name, now);
    const partner = name === 'MS-01' ? 'MS-02' : 'MS-01';
    if (now - (battle.lastBite.get(partner) ?? -Infinity) < BATTLE.comboWindowMs) {
      damage('HM-01', BATTLE.comboDamage, 'COMBO!');
      playSound('combo');
      battle.lastBite.delete(partner);
    }
  } else {
    damage(name, BATTLE.swatDamage, 'SWAT!');
    playSound('swat');
    if (battle.hp[name] <= 0) {
      popAt(name, 'K.O.', 'ko');
      playSound('ko');
    }
  }
}

function damage(name, amount, label) {
  battle.hp[name] = Math.max(0, battle.hp[name] - amount);
  popAt(name, `${label} -${amount}`, FIGHTERS[name].kind === 'human' ? 'bite' : 'swat');
  const element = fighterElement(name);
  element.classList.remove('hit');
  // Restart the shake animation.
  void element.offsetWidth;
  element.classList.add('hit');
}

function finish(now, winner) {
  battle.phase = 'result';
  battle.phaseAt = now;
  battle.winner = winner;
  setMessage(winner === 'mice' ? 'MICE WIN! 🧀' : 'HUMAN WINS! 🧹', `result ${winner}`);
  playSound(winner === 'mice' ? 'micewin' : 'humanwin');
}

function endBattle() {
  battle = null;
  battleLayer.hidden = true;
  setMessage('', '');
}

// Text for the map screen while the camera page shows the battle.
function battleSummary() {
  if (!battle) {
    return null;
  }
  if (battle.phase === 'result') {
    return battle.winner === 'mice' ? 'MICE WIN!' : 'HUMAN WINS!';
  }
  return 'MOUSE BATTLE!';
}

// ---------------------------------------------------------------------------
// Battle screen
// ---------------------------------------------------------------------------

function drawBattle(now, fighters) {
  for (const [name, hp] of Object.entries(battle.hp)) {
    const max = FIGHTERS[name].kind === 'human' ? BATTLE.humanHp : BATTLE.mouseHp;
    const bar = battleLayer.querySelector(`.hp-bar[data-name="${name}"]`);
    const fill = bar.querySelector('.fill');
    fill.style.width = `${(hp / max) * 100}%`;
    fill.classList.toggle('low', hp / max <= 0.3);
    bar.querySelector('.value').textContent = hp;
    fighterElement(name).classList.toggle('out', hp <= 0);
  }

  const left = battle.phase === 'fight'
    ? BATTLE.durationMs - (now - battle.phaseAt)
    : battle.phase === 'countdown' ? BATTLE.durationMs : 0;
  battleTimer.textContent = Math.max(0, Math.ceil(left / 1000));

  // The avatars follow the cards, placed where the cards show on screen.
  for (const name of Object.keys(FIGHTERS)) {
    const element = fighterElement(name);
    const track = fighters.find((t) => t.card.name === name);
    element.classList.toggle('missing', !track);
    if (track) {
      const { x, y } = frameToScreen(track.center);
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    }
  }
}

// The video fills the screen with object-fit: cover, so the frame is scaled
// up until it covers the screen and centred, with the overflow cropped.
// Avatars are kept on screen even when their card is in the cropped part
// (e.g. the sides of the picture on a phone held upright).
function frameToScreen({ x, y }) {
  const scale = Math.max(innerWidth / overlay.width, innerHeight / overlay.height);
  const margin = Math.min(innerWidth, innerHeight) * 0.09;
  const clamp = (value, max) => Math.min(Math.max(value, margin), max - margin);
  return {
    x: clamp((innerWidth - overlay.width * scale) / 2 + x * scale, innerWidth),
    y: clamp((innerHeight - overlay.height * scale) / 2 + y * scale, innerHeight),
  };
}

function fighterElement(name) {
  return battleField.querySelector(`.fighter[data-name="${name}"]`);
}

function popAt(name, text, kind) {
  const fighter = fighterElement(name);
  const pop = document.createElement('div');
  pop.className = `pop ${kind}`;
  pop.textContent = text;
  pop.style.left = fighter.style.left;
  pop.style.top = fighter.style.top;
  battleField.appendChild(pop);
  setTimeout(() => pop.remove(), 1000);
}

function setMessage(text, kind) {
  if (battleMessage.textContent === text) {
    return;
  }
  battleMessage.textContent = text;
  battleMessage.className = `battle-message ${kind}`;
}
