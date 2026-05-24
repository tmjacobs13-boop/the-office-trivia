// The Office Trivia — client

const socket = io();

const state = {
  you: null,
  opponent: null,
  code: null,
  scores: { you: 0, opp: 0 },
  isChooser: false,
  timerInterval: null,
  timerEndAt: null,
  hasLocked: false,
};

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

// --- Landing ---
$('btn-create').addEventListener('click', () => {
  const name = $('name-input').value.trim() || 'Player';
  setError('');
  socket.emit('create-room', { name }, (res) => {
    if (!res.success) { setError(res.error || 'Could not create room'); return; }
    state.code = res.code;
    state.you = res.you;
    $('big-code').textContent = res.code;
    $('room-code-display').textContent = res.code;
    $('room-indicator').classList.remove('hidden');
    renderPlayersPreview(res.players);
    showScreen('waiting');
  });
});

$('btn-join').addEventListener('click', () => {
  const name = $('name-input').value.trim() || 'Player';
  const code = $('join-code-input').value.trim().toUpperCase();
  if (code.length !== 4) { setError('Enter the 4-letter room code'); return; }
  setError('');
  socket.emit('join-room', { name, code }, (res) => {
    if (!res.success) { setError(res.error || 'Could not join'); return; }
    state.code = res.code;
    state.you = res.you;
    $('room-code-display').textContent = res.code;
    $('room-indicator').classList.remove('hidden');
    // Game starts in 1.5s via server
  });
});

$('btn-copy-code').addEventListener('click', () => {
  if (!state.code) return;
  navigator.clipboard.writeText(state.code).then(
    () => toast('Code copied'),
    () => toast('Copy failed')
  );
});

$('join-code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});

function renderPlayersPreview(players) {
  const el = $('players-preview');
  if (!players) { el.innerHTML = ''; return; }
  el.innerHTML = players.map(p =>
    `<div class="pp-chip">${escapeHtml(p.name)}${p.id === state.you ? ' (you)' : ''}</div>`
  ).join('');
}

// --- Game phase handlers ---
socket.on('players-update', ({ players }) => {
  renderPlayersPreview(players);
  updateScoreLabels(players);
});

socket.on('tier-pick-phase', ({ chooserId, chooserName, roundNum, scores }) => {
  showScreen('game');
  showPhase('tier-pick');
  $('round-num').textContent = roundNum;
  state.isChooser = (chooserId === state.you);
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

socket.on('player-locked', ({ playerId }) => {
  if (playerId !== state.you) {
    const cur = $('lock-status').textContent;
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
  const youResult = results.find(r => r.id === state.you);
  const oppResult = results.find(r => r.id !== state.you);

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
    const label = r.id === state.you ? `${escapeHtml(r.name)} (you)` : escapeHtml(r.name);
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

socket.on('game-over', ({ winnerId, winnerName, scores }) => {
  showScreen('gameover');
  const youWin = winnerId === state.you;
  $('gameover-headline').textContent = youWin ? '🏆 You Win!' : `${winnerName} wins`;
  $('gameover-tagline').textContent = youWin
    ? "World's Best Boss material."
    : "Identity theft is not a joke, Jim!";
  $('final-scores').innerHTML = scores
    .slice()
    .sort((a, b) => b.score - a.score)
    .map(s => {
      const isWinner = s.id === winnerId;
      const isYou = s.id === state.you;
      return `<div class="final-row ${isWinner ? 'winner' : ''}">
        <span>${escapeHtml(s.name)}${isYou ? ' (you)' : ''}${isWinner ? ' 🏆' : ''}</span>
        <span class="score">${s.score}</span>
      </div>`;
    }).join('');
});

socket.on('opponent-left', () => {
  toast('Opponent disconnected');
  setTimeout(() => location.reload(), 2000);
});

socket.on('error-msg', ({ msg }) => toast(msg, 4000));

$('btn-play-again').addEventListener('click', () => {
  socket.emit('play-again');
});

$('btn-leave').addEventListener('click', () => location.reload());

// --- Scoreboard ---
function updateScoreLabels(scores) {
  if (!scores || scores.length === 0) return;
  const you = scores.find(s => s.id === state.you);
  const opp = scores.find(s => s.id !== state.you);
  if (you) {
    $('score-you').querySelector('.score-name').textContent = `${you.name} (you)`;
    $('score-you').querySelector('.score-value').textContent = you.score;
  }
  if (opp) {
    $('score-opp').querySelector('.score-name').textContent = opp.name;
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
