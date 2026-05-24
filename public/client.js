// The Office Trivia — client

const socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });

const state = {
  you: null,                   // player token (stable across reconnects)
  code: null,
  isChooser: false,
  isSolo: false,
  timerInterval: null,
  timerEndAt: null,
  hasLocked: false,
  connected: false,
};

const TOKEN_KEY = 'oft_player_token';
const SESSION_KEY = 'oft_active_session';

function getOrCreateToken() {
  try {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t || t.length < 8) {
      t = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
      localStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  } catch (e) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
const PLAYER_TOKEN = getOrCreateToken();

function saveSession(code, isSolo) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, isSolo, ts: Date.now() }));
  } catch (e) {}
}
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (Date.now() - s.ts > 1000 * 60 * 60 * 13) return null;
    return s;
  } catch (e) { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
}

// --- DOM helpers ---
const $ = (id) => document.getElementById(id);
const screens = ['landing', 'waiting', 'game', 'gameover'];
function showScreen(name) {
  screens.forEach(s => $(`screen-${s}`).classList.toggle('hidden', s !== name));
}
function showPhase(name) {
  ['tier-pick', 'question', 'reveal'].forEach(p => $(`phase-${p}`).classList.toggle('hidden', p !== name));
}
function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function setError(msg) {
  const el = $('landing-error');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function updateConnectionUI() {
  const dot = $('conn-dot');
  const label = $('conn-label');
  if (!dot || !label) return;
  if (state.connected) {
    dot.classList.remove('disconnected', 'waking');
    dot.classList.add('connected');
    label.textContent = 'Connected';
  } else {
    dot.classList.remove('connected');
    dot.classList.add('disconnected');
    label.textContent = 'Connecting…';
  }
  setActionButtonsEnabled(state.connected);
}
function setActionButtonsEnabled(on) {
  ['btn-create', 'btn-join', 'btn-solo'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = !on;
  });
}

// --- Socket lifecycle ---
socket.on('connect', () => {
  state.connected = true;
  updateConnectionUI();
  // Auto-rejoin if we have an active session
  const sess = loadSession();
  if (sess && sess.code && state.code !== sess.code) {
    socket.emit('rejoin-room', { code: sess.code, token: PLAYER_TOKEN }, (res) => {
      if (res && res.success) {
        state.code = res.code;
        state.you = res.you;
        state.isSolo = !!res.isSolo;
        if (state.isSolo) document.body.classList.add('solo-mode');
        $('room-code-display').textContent = state.isSolo ? 'SOLO' : res.code;
        $('room-indicator').classList.remove('hidden');
        // Server will follow up with a state snapshot
      } else {
        clearSession();
      }
    });
  } else if (state.code) {
    // We had a session in memory but disconnected briefly — re-emit rejoin
    socket.emit('rejoin-room', { code: state.code, token: PLAYER_TOKEN }, () => {});
  }
});
socket.on('disconnect', () => {
  state.connected = false;
  updateConnectionUI();
});
socket.io.on('reconnect_attempt', () => {
  state.connected = false;
  updateConnectionUI();
});

// --- Landing ---
$('btn-create').addEventListener('click', () => {
  if (!state.connected) { setError('Connecting to server… try again in a moment.'); return; }
  const name = $('name-input').value.trim() || 'Player';
  setError('');
  $('btn-create').disabled = true;
  socket.emit('create-room', { name, token: PLAYER_TOKEN }, (res) => {
    $('btn-create').disabled = false;
    if (!res || !res.success) { setError((res && res.error) || 'Could not create room'); return; }
    state.code = res.code;
    state.you = res.you;
    state.isSolo = false;
    saveSession(res.code, false);
    $('big-code').textContent = res.code;
    $('room-code-display').textContent = res.code;
    $('room-indicator').classList.remove('hidden');
    renderPlayersPreview(res.players);
    showScreen('waiting');
  });
});

$('btn-join').addEventListener('click', () => {
  if (!state.connected) { setError('Connecting to server… try again in a moment.'); return; }
  const name = $('name-input').value.trim() || 'Player';
  const code = $('join-code-input').value.trim().toUpperCase();
  if (code.length !== 4) { setError('Enter the 4-letter room code'); return; }
  setError('');
  $('btn-join').disabled = true;
  socket.emit('join-room', { name, code, token: PLAYER_TOKEN }, (res) => {
    $('btn-join').disabled = false;
    if (!res || !res.success) { setError((res && res.error) || 'Could not join'); return; }
    state.code = res.code;
    state.you = res.you;
    state.isSolo = false;
    saveSession(res.code, false);
    $('room-code-display').textContent = res.code;
    $('room-indicator').classList.remove('hidden');
  });
});

$('btn-solo').addEventListener('click', () => {
  if (!state.connected) { setError('Connecting to server… try again in a moment.'); return; }
  const name = $('name-input').value.trim() || 'Player';
  setError('');
  $('btn-solo').disabled = true;
  socket.emit('create-solo', { name, token: PLAYER_TOKEN }, (res) => {
    $('btn-solo').disabled = false;
    if (!res || !res.success) { setError((res && res.error) || 'Could not start solo'); return; }
    state.code = res.code;
    state.you = res.you;
    state.isSolo = true;
    saveSession(res.code, true);
    $('room-code-display').textContent = 'SOLO';
    $('room-indicator').classList.remove('hidden');
    document.body.classList.add('solo-mode');
  });
});

function buildInviteText(code) {
  const url = `${location.origin}/?code=${code}`;
  return `Join my Office Trivia game! ${url}`;
}

$('btn-copy-code').addEventListener('click', () => {
  if (!state.code) return;
  navigator.clipboard.writeText(state.code).then(
    () => toast('Code copied'),
    () => toast('Copy failed')
  );
});

$('btn-copy-invite').addEventListener('click', () => {
  if (!state.code) return;
  const text = buildInviteText(state.code);
  navigator.clipboard.writeText(text).then(
    () => toast('Invite copied — paste it in a text'),
    () => toast('Copy failed')
  );
});

$('join-code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});

(function prefillCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (code.length === 4) {
    const input = $('join-code-input');
    if (input) {
      input.value = code;
      setTimeout(() => $('name-input').focus(), 100);
    }
  }
})();

function renderPlayersPreview(players) {
  const el = $('players-preview');
  if (!players) { el.innerHTML = ''; return; }
  el.innerHTML = players.map(p =>
    `<div class="pp-chip">${escapeHtml(p.name)}${p.token === state.you ? ' (you)' : ''}</div>`
  ).join('');
}

// --- Game phase handlers ---
socket.on('players-update', ({ players }) => {
  renderPlayersPreview(players);
  updateScoreLabels(players);
});

socket.on('tier-pick-phase', ({ chooserToken, chooserName, roundNum, scores, isSolo }) => {
  if (typeof isSolo === 'boolean') state.isSolo = isSolo;
  if (state.isSolo) document.body.classList.add('solo-mode');
  showScreen('game');
  showPhase('tier-pick');
  $('round-num').textContent = roundNum;
  state.isChooser = (chooserToken === state.you);
  state.hasLocked = false;
  updateScoreLabels(scores);
  $('score-you').classList.toggle('you-chooser', state.isChooser);
  $('score-opp').classList.toggle('you-chooser', !state.isChooser);

  $('tier-pick-you').classList.toggle('hidden', !state.isChooser);
  $('tier-pick-other').classList.toggle('hidden', state.isChooser);
  if (!state.isChooser) {
    $('chooser-name').textContent = chooserName;
  } else {
    document.querySelectorAll('.tier-btn').forEach(b => b.disabled = false);
  }
});

document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state.isChooser) return;
    const tier = parseInt(btn.dataset.tier, 10);
    document.querySelectorAll('.tier-btn').forEach(b => b.disabled = true);
    socket.emit('choose-tier', { tier });
  });
});

socket.on('question', ({ tier, points, question, choices, timeoutMs, roundNum, scores }) => {
  showScreen('game');
  showPhase('question');
  $('round-num').textContent = roundNum;
  updateScoreLabels(scores);
  $('q-tier-badge').textContent = `TIER ${tier} • ${points} PTS`;
  $('question-text').textContent = question;
  const labels = ['A', 'B', 'C', 'D'];
  const wrap = $('choices');
  wrap.innerHTML = '';
  choices.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'choice-btn';
    b.innerHTML = `<span class="letter">${labels[i]}</span><span>${escapeHtml(c)}</span>`;
    b.addEventListener('click', () => lockAnswer(i, b));
    wrap.appendChild(b);
  });
  $('lock-status').textContent = '';
  state.hasLocked = false;
  startTimer(timeoutMs);
});

function lockAnswer(choice, btn) {
  if (state.hasLocked) return;
  state.hasLocked = true;
  document.querySelectorAll('.choice-btn').forEach(b => {
    b.disabled = true;
    if (b !== btn) b.classList.remove('locked');
  });
  btn.classList.add('locked');
  $('lock-status').textContent = 'Locked in. Waiting for opponent…';
  socket.emit('lock-answer', { choice });
}

socket.on('player-locked', ({ playerToken }) => {
  if (state.isSolo) {
    $('lock-status').textContent = 'Revealing…';
    return;
  }
  if (playerToken !== state.you) {
    if (state.hasLocked) {
      $('lock-status').textContent = 'Both locked — revealing…';
    } else {
      $('lock-status').textContent = 'Opponent locked. Hurry!';
    }
  }
});

socket.on('reveal', ({ correctIndex, correctText, results, tier, scores }) => {
  stopTimer();
  showPhase('reveal');
  const youResult = results.find(r => r.token === state.you);
  const oppResult = results.find(r => r.token !== state.you);

  const buttons = document.querySelectorAll('.choice-btn');
  buttons.forEach((b, i) => {
    if (i === correctIndex) b.classList.add('correct');
    else if (youResult && youResult.choice === i) b.classList.add('incorrect');
  });

  const headline = youResult.correct
    ? (youResult.speedBonus ? 'Correct + Speed Bonus!' : 'Correct!')
    : (youResult.choice === null ? 'Time up.' : 'Wrong answer.');
  $('reveal-headline').textContent = headline;
  $('reveal-correct').textContent = `Correct answer: ${correctText}`;

  $('reveal-results').innerHTML = [youResult, oppResult].filter(Boolean).map(r => {
    const label = r.token === state.you ? `${escapeHtml(r.name)} (you)` : escapeHtml(r.name);
    const cls = r.correct ? 'correct' : 'incorrect';
    const ptsCls = r.earned === 0 ? 'zero' : '';
    const bonus = r.speedBonus && r.correct ? '<span class="bonus">SPEED +5</span>' : '';
    return `<div class="reveal-row ${cls}">
      <span class="name">${label}</span>
      <span><span class="pts ${ptsCls}">+${r.earned}</span>${bonus}</span>
    </div>`;
  }).join('');

  updateScoreLabels(scores);
});

socket.on('game-over', ({ winnerToken, winnerName, scores }) => {
  clearSession();
  showScreen('gameover');
  const youWin = winnerToken === state.you;
  if (state.isSolo) {
    $('gameover-headline').textContent = '🏆 500 reached!';
    $('gameover-tagline').textContent = "World's Best Boss material.";
  } else {
    $('gameover-headline').textContent = youWin ? '🏆 You Win!' : `${winnerName} wins`;
    $('gameover-tagline').textContent = youWin
      ? "World's Best Boss material."
      : "Identity theft is not a joke, Jim!";
  }
  $('final-scores').innerHTML = scores
    .slice()
    .sort((a, b) => b.score - a.score)
    .map(s => {
      const isWinner = s.token === winnerToken;
      const isYou = s.token === state.you;
      return `<div class="final-row ${isWinner ? 'winner' : ''}">
        <span>${escapeHtml(s.name)}${isYou ? ' (you)' : ''}${isWinner ? ' 🏆' : ''}</span>
        <span class="score">${s.score}</span>
      </div>`;
    }).join('');
});

socket.on('player-disconnected', ({ playerToken }) => {
  if (playerToken !== state.you) {
    toast('Opponent disconnected — game is paused, they can rejoin', 4000);
  }
});

socket.on('opponent-left', () => {
  // legacy path; ignore in new flow
});

socket.on('error-msg', ({ msg }) => toast(msg, 4000));

$('btn-play-again').addEventListener('click', () => {
  socket.emit('play-again');
});

$('btn-leave').addEventListener('click', () => {
  socket.emit('leave-room');
  clearSession();
  location.reload();
});

// --- Scoreboard ---
function updateScoreLabels(scores) {
  if (!scores || scores.length === 0) return;
  const you = scores.find(s => s.token === state.you);
  const opp = scores.find(s => s.token !== state.you);
  if (you) {
    $('score-you').querySelector('.score-name').textContent = state.isSolo ? you.name : `${you.name} (you)`;
    $('score-you').querySelector('.score-value').textContent = you.score;
  }
  if (state.isSolo) return;
  if (opp) {
    const offline = opp.connected === false ? ' ⏸' : '';
    $('score-opp').querySelector('.score-name').textContent = opp.name + offline;
    $('score-opp').querySelector('.score-value').textContent = opp.score;
  } else {
    $('score-opp').querySelector('.score-name').textContent = 'Waiting…';
    $('score-opp').querySelector('.score-value').textContent = '–';
  }
}

// --- Timer ---
function startTimer(ms) {
  stopTimer();
  state.timerEndAt = Date.now() + ms;
  const tick = () => {
    const remain = Math.max(0, state.timerEndAt - Date.now());
    const secs = Math.ceil(remain / 1000);
    const el = $('q-timer');
    el.textContent = secs;
    el.classList.toggle('urgent', secs <= 5);
    if (remain <= 0) stopTimer();
  };
  tick();
  state.timerInterval = setInterval(tick, 200);
}
function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Initial UI state — disable buttons until socket connects
setActionButtonsEnabled(false);
updateConnectionUI();
