const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const QUESTIONS_PATH = path.join(__dirname, 'questions.json');

function loadQuestions() {
  const raw = fs.readFileSync(QUESTIONS_PATH, 'utf-8');
  const data = JSON.parse(raw);
  for (let t = 1; t <= 10; t++) {
    const key = `tier${t}`;
    if (!Array.isArray(data[key])) data[key] = [];
  }
  return data;
}
let QUESTIONS = loadQuestions();

const WIN_SCORE = 500;
const TIEBREAKER_STEP = 100;
const SPEED_BONUS = 5;
const ANSWER_TIMEOUT_MS = 30000;
const REVEAL_DURATION_MS = 5000;
const ROOM_TTL_MS = 1000 * 60 * 60 * 12;

const rooms = new Map();

function tierPoints(tier) { return tier * 10; }
function newToken() { return crypto.randomBytes(16).toString('hex'); }

function genCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  let tries = 0;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    tries++;
    if (tries > 50) throw new Error('Could not allocate room code');
  } while (rooms.has(code));
  return code;
}

function pickQuestion(room, tier) {
  const pool = QUESTIONS[`tier${tier}`] || [];
  if (pool.length === 0) return null;
  const unused = pool.filter(q => !room.usedIds.has(q.id));
  const choice = (unused.length > 0 ? unused : pool)[Math.floor(Math.random() * (unused.length > 0 ? unused.length : pool.length))];
  if (unused.length === 0) {
    pool.forEach(q => room.usedIds.delete(q.id));
  }
  return choice;
}

function publicScores(room) {
  return room.players.map(p => ({ token: p.token, name: p.name, score: p.score, connected: p.connected }));
}

function startNextRound(room) {
  const minPlayers = room.isSolo ? 1 : 2;
  if (room.players.length < minPlayers) return;
  room.roundNum += 1;
  room.lockedAnswers = {};
  room.currentQuestion = null;
  if (!room.isSolo && room.roundNum > 1) room.chooserIdx = 1 - room.chooserIdx;
  room.phase = 'tier-pick';
  io.to(room.code).emit('tier-pick-phase', {
    chooserToken: room.players[room.chooserIdx].token,
    chooserName: room.players[room.chooserIdx].name,
    roundNum: room.roundNum,
    scores: publicScores(room),
    isSolo: !!room.isSolo,
  });
}

function askQuestion(room, tier) {
  const q = pickQuestion(room, tier);
  if (!q) {
    io.to(room.code).emit('error-msg', { msg: `No questions available for tier ${tier}` });
    return;
  }
  room.usedIds.add(q.id);
  room.currentTier = tier;
  room.currentQuestion = q;
  room.questionStartTime = Date.now();
  room.lockedAnswers = {};
  room.phase = 'answering';
  io.to(room.code).emit('question', {
    tier,
    points: tierPoints(tier),
    question: q.q,
    choices: q.choices,
    timeoutMs: ANSWER_TIMEOUT_MS,
    roundNum: room.roundNum,
    scores: publicScores(room),
  });
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => reveal(room), ANSWER_TIMEOUT_MS);
}

function reveal(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.phase !== 'answering') return;
  room.phase = 'reveal';
  const q = room.currentQuestion;
  const points = tierPoints(room.currentTier);

  const correctLocks = room.players
    .map(p => ({ p, lock: room.lockedAnswers[p.token] }))
    .filter(({ lock }) => lock && lock.choice === q.correct)
    .sort((a, b) => a.lock.lockTime - b.lock.lockTime);

  const speedBonusToken = correctLocks.length > 0 ? correctLocks[0].p.token : null;

  const results = room.players.map(p => {
    const lock = room.lockedAnswers[p.token];
    const wasCorrect = !!(lock && lock.choice === q.correct);
    const getsSpeedBonus = !room.isSolo && wasCorrect && speedBonusToken === p.token;
    let earned = 0;
    if (wasCorrect) {
      earned += points;
      if (getsSpeedBonus) earned += SPEED_BONUS;
    }
    p.score += earned;
    return {
      token: p.token,
      name: p.name,
      choice: lock ? lock.choice : null,
      correct: wasCorrect,
      earned,
      newScore: p.score,
      speedBonus: getsSpeedBonus,
    };
  });

  io.to(room.code).emit('reveal', {
    correctIndex: q.correct,
    correctText: q.choices[q.correct],
    results,
    tier: room.currentTier,
    scores: publicScores(room),
    winThreshold: room.winThreshold,
  });

  // Winner = unique player with highest score >= current threshold.
  // If multiple players are tied AND at/over threshold, raise threshold by 100 and keep playing.
  const maxScore = Math.max(...room.players.map(p => p.score));
  if (maxScore >= room.winThreshold) {
    const leaders = room.players.filter(p => p.score === maxScore);
    if (leaders.length === 1) {
      const winner = leaders[0];
      room.phase = 'ended';
      setTimeout(() => {
        io.to(room.code).emit('game-over', {
          winnerToken: winner.token,
          winnerName: winner.name,
          scores: publicScores(room),
          finalThreshold: room.winThreshold,
        });
      }, REVEAL_DURATION_MS);
      return;
    }
    // Tied — extend the target
    room.winThreshold = Math.ceil((maxScore + 1) / TIEBREAKER_STEP) * TIEBREAKER_STEP;
    io.to(room.code).emit('tiebreaker', {
      tiedScore: maxScore,
      newThreshold: room.winThreshold,
    });
  }
  setTimeout(() => startNextRound(room), REVEAL_DURATION_MS);
}

function cleanupOldRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}
setInterval(cleanupOldRooms, 1000 * 60 * 30);

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerToken = null;

  socket.on('create-room', ({ name, token }, cb) => {
    try {
      const cleanName = String(name || 'Player').trim().slice(0, 24) || 'Player';
      const playerToken = (typeof token === 'string' && token.length >= 8) ? token : newToken();
      const code = genCode();
      const room = {
        code,
        players: [{ id: socket.id, token: playerToken, name: cleanName, score: 0, connected: true, disconnectedAt: null }],
        chooserIdx: 0,
        roundNum: 0,
        currentQuestion: null,
        currentTier: null,
        lockedAnswers: {},
        usedIds: new Set(),
        timer: null,
        phase: 'waiting',
        isSolo: false,
        winThreshold: WIN_SCORE,
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      currentRoom = room;
      currentPlayerToken = playerToken;
      socket.join(code);
      cb({ success: true, code, you: playerToken, token: playerToken, players: publicScores(room) });
    } catch (e) {
      cb({ success: false, error: e.message });
    }
  });

  socket.on('create-solo', ({ name, token }, cb) => {
    try {
      const cleanName = String(name || 'Player').trim().slice(0, 24) || 'Player';
      const playerToken = (typeof token === 'string' && token.length >= 8) ? token : newToken();
      const code = genCode();
      const room = {
        code,
        players: [{ id: socket.id, token: playerToken, name: cleanName, score: 0, connected: true, disconnectedAt: null }],
        chooserIdx: 0,
        roundNum: 0,
        currentQuestion: null,
        currentTier: null,
        lockedAnswers: {},
        usedIds: new Set(),
        timer: null,
        phase: 'waiting',
        isSolo: true,
        winThreshold: WIN_SCORE,
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      currentRoom = room;
      currentPlayerToken = playerToken;
      socket.join(code);
      cb({ success: true, code, you: playerToken, token: playerToken, players: publicScores(room), isSolo: true });
      setTimeout(() => startNextRound(room), 400);
    } catch (e) {
      cb({ success: false, error: e.message });
    }
  });

  socket.on('join-room', ({ name, code, token }, cb) => {
    try {
      const cleanName = String(name || 'Player').trim().slice(0, 24) || 'Player';
      const cleanCode = String(code || '').trim().toUpperCase();
      const room = rooms.get(cleanCode);
      if (!room) return cb({ success: false, error: 'Room not found or expired' });
      if (room.isSolo) return cb({ success: false, error: 'That room is solo-only' });

      const playerToken = (typeof token === 'string' && token.length >= 8) ? token : newToken();

      const existing = room.players.find(p => p.token === playerToken);
      if (existing) {
        existing.id = socket.id;
        existing.connected = true;
        existing.disconnectedAt = null;
        existing.name = cleanName;
        currentRoom = room;
        currentPlayerToken = playerToken;
        socket.join(cleanCode);
        cb({ success: true, code: cleanCode, you: playerToken, token: playerToken, players: publicScores(room), resumed: true, phase: room.phase, isSolo: !!room.isSolo });
        io.to(cleanCode).emit('players-update', { players: publicScores(room) });
        sendStateSnapshot(socket, room);
        return;
      }

      if (room.players.length >= 2) return cb({ success: false, error: 'Room is full' });
      if (room.phase !== 'waiting') return cb({ success: false, error: 'Game already in progress' });

      room.players.push({ id: socket.id, token: playerToken, name: cleanName, score: 0, connected: true, disconnectedAt: null });
      currentRoom = room;
      currentPlayerToken = playerToken;
      socket.join(cleanCode);
      cb({ success: true, code: cleanCode, you: playerToken, token: playerToken, players: publicScores(room) });
      io.to(cleanCode).emit('players-update', { players: publicScores(room) });
      setTimeout(() => startNextRound(room), 1500);
    } catch (e) {
      cb({ success: false, error: e.message });
    }
  });

  socket.on('rejoin-room', ({ code, token }, cb) => {
    try {
      const cleanCode = String(code || '').trim().toUpperCase();
      const room = rooms.get(cleanCode);
      if (!room) return cb({ success: false, error: 'Room not found or expired' });
      const player = room.players.find(p => p.token === token);
      if (!player) return cb({ success: false, error: 'You are not in this room' });

      player.id = socket.id;
      player.connected = true;
      player.disconnectedAt = null;
      currentRoom = room;
      currentPlayerToken = token;
      socket.join(cleanCode);

      cb({
        success: true,
        code: cleanCode,
        you: token,
        players: publicScores(room),
        phase: room.phase,
        isSolo: !!room.isSolo,
      });
      io.to(cleanCode).emit('players-update', { players: publicScores(room) });
      sendStateSnapshot(socket, room);
    } catch (e) {
      cb({ success: false, error: e.message });
    }
  });

  function sendStateSnapshot(sock, room) {
    if (room.phase === 'tier-pick') {
      sock.emit('tier-pick-phase', {
        chooserToken: room.players[room.chooserIdx].token,
        chooserName: room.players[room.chooserIdx].name,
        roundNum: room.roundNum,
        scores: publicScores(room),
        isSolo: !!room.isSolo,
      });
    } else if (room.phase === 'answering' && room.currentQuestion) {
      const elapsed = Date.now() - (room.questionStartTime || Date.now());
      const remaining = Math.max(1000, ANSWER_TIMEOUT_MS - elapsed);
      sock.emit('question', {
        tier: room.currentTier,
        points: tierPoints(room.currentTier),
        question: room.currentQuestion.q,
        choices: room.currentQuestion.choices,
        timeoutMs: remaining,
        roundNum: room.roundNum,
        scores: publicScores(room),
      });
    } else if (room.phase === 'reveal') {
      sock.emit('players-update', { players: publicScores(room) });
    } else if (room.phase === 'waiting') {
      sock.emit('players-update', { players: publicScores(room) });
    }
  }

  socket.on('choose-tier', ({ tier }) => {
    if (!currentRoom || currentRoom.phase !== 'tier-pick') return;
    if (currentRoom.players[currentRoom.chooserIdx].token !== currentPlayerToken) return;
    const t = parseInt(tier, 10);
    if (!(t >= 1 && t <= 10)) return;
    askQuestion(currentRoom, t);
  });

  socket.on('lock-answer', ({ choice }) => {
    if (!currentRoom || currentRoom.phase !== 'answering') return;
    if (currentRoom.lockedAnswers[currentPlayerToken]) return;
    const c = parseInt(choice, 10);
    if (!(c >= 0 && c <= 3)) return;
    currentRoom.lockedAnswers[currentPlayerToken] = { choice: c, lockTime: Date.now() };
    io.to(currentRoom.code).emit('player-locked', { playerToken: currentPlayerToken });
    const connectedCount = currentRoom.players.filter(p => p.connected).length;
    const lockedCount = Object.keys(currentRoom.lockedAnswers).length;
    if (lockedCount >= connectedCount || lockedCount >= currentRoom.players.length) {
      reveal(currentRoom);
    }
  });

  socket.on('play-again', () => {
    if (!currentRoom || currentRoom.phase !== 'ended') return;
    currentRoom.players.forEach(p => { p.score = 0; });
    currentRoom.roundNum = 0;
    currentRoom.chooserIdx = 0;
    currentRoom.usedIds = new Set();
    currentRoom.winThreshold = WIN_SCORE;
    io.to(currentRoom.code).emit('players-update', { players: publicScores(currentRoom) });
    setTimeout(() => startNextRound(currentRoom), 800);
  });

  socket.on('leave-room', () => {
    if (currentRoom && currentPlayerToken) {
      currentRoom.players = currentRoom.players.filter(p => p.token !== currentPlayerToken);
      io.to(currentRoom.code).emit('players-update', { players: publicScores(currentRoom) });
      if (currentRoom.players.length === 0) {
        if (currentRoom.timer) clearTimeout(currentRoom.timer);
        rooms.delete(currentRoom.code);
      }
      currentRoom = null;
      currentPlayerToken = null;
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && currentPlayerToken) {
      const player = currentRoom.players.find(p => p.token === currentPlayerToken);
      if (player) {
        player.connected = false;
        player.disconnectedAt = Date.now();
        io.to(currentRoom.code).emit('player-disconnected', { playerToken: currentPlayerToken });
        io.to(currentRoom.code).emit('players-update', { players: publicScores(currentRoom) });
      }
    }
    currentRoom = null;
    currentPlayerToken = null;
  });
});

server.listen(PORT, () => {
  const tierCounts = {};
  for (let t = 1; t <= 10; t++) tierCounts[`tier${t}`] = (QUESTIONS[`tier${t}`] || []).length;
  console.log(`Server listening on :${PORT}`);
  console.log('Loaded questions:', tierCounts);
});
