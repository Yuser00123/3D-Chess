/* ============================================================
   Blade Chess 3D — game logic & UI wiring
   Modes: bot · room-code online · local 2 players
   ============================================================ */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const chess = new Chess();

  /* ---------------- state ---------------- */
  let mode = null;            // 'bot' | 'online' | 'local'
  let mySeat = null;          // 'w' | 'b' (null = both, local mode)
  let botSeat = null, botLevel = 2;
  let room = null;            // {code, pid}
  let pollTimer = null;
  let sanList = [];
  let selected = null, targets = [];
  let busy = false;           // animation lock
  let gameOver = false;
  let inLobby = false;
  let lastVersion = 0, gameId = 0;
  let lastVerbose = null;
  let pendingMove = null;
  let oppDisconnected = false;
  let rematchWanted = false;

  const BOT_NAMES = { 1: 'Squire Silas', 2: 'Sir Roland', 3: 'King Aldric' };
  const GLYPH = {
    w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
    b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
  };
  const ORDER = { q: 5, r: 4, b: 3, n: 2, p: 1 };

  /* ---------------- misc helpers ---------------- */
  function myName() {
    let n = localStorage.getItem('bc3d_name');
    if (!n) {
      const a = ['Swift', 'Bold', 'Iron', 'Shadow', 'Storm', 'Golden', 'Silent', 'Grim', 'Bright', 'Wild'];
      const b = ['Knight', 'Rook', 'Bishop', 'Pawn', 'King', 'Queen', 'Blade', 'Falcon', 'Wolf', 'Raven'];
      n = a[(Math.random() * a.length) | 0] + ' ' + b[(Math.random() * b.length) | 0];
      localStorage.setItem('bc3d_name', n);
    }
    return n;
  }

  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 450); }, 2400);
  }

  async function api(path, body) {
    const r = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    let j;
    try { j = await r.json(); } catch (e) { j = { ok: false, error: 'Network error' }; }
    if (!r.ok && !j.error) j.error = 'Error ' + r.status;
    return j;
  }
  async function apiGet(path) {
    const r = await fetch('/api/' + path);
    return r.json().catch(() => ({ ok: false, error: 'Network error' }));
  }

  function kingSquare(color) {
    const b = chess.board();
    for (let r = 0; r < 8; r++)
      for (let f = 0; f < 8; f++) {
        const s = b[r][f];
        if (s && s.type === 'k' && s.color === color) return s.square;
      }
    return null;
  }

  function computeCaptured() {
    const init = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
    const cnt = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
    const b = chess.board();
    for (const row of b) for (const s of row) if (s) cnt[s.color][s.type]++;
    const lost = { w: [], b: [] };
    for (const c of ['w', 'b'])
      for (const t of ['q', 'r', 'b', 'n', 'p'])
        for (let i = 0; i < init[t] - cnt[c][t]; i++) lost[c].push(t);
    return lost;
  }

  /* ---------------- engine (bot): Stockfish, with fallback to the built-in engine ---------------- */
  const EngineClient = (() => {
    /* Stockfish levels — Skill Level 0..20 is Stockfish's own handicap dial */
    const SF_LEVELS = {
      1: { skill: 1,  depth: 4,  movetime: 260 },
      2: { skill: 8,  depth: 10, movetime: 700 },
      3: { skill: 18, depth: 15, movetime: 1500 }
    };

    /* the original minimax engine — used only if Stockfish fails to load */
    const legacy = (() => {
      let worker = null, dead = false, pending = null;
      function ensure() {
        if (worker || dead) return;
        try {
          const code = `importScripts(${JSON.stringify(location.origin + '/vendor/chess.min.js')},${JSON.stringify(location.origin + '/js/engine.js')});`;
          const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          worker = new Worker(url);
          worker.onmessage = e => { const cb = pending; pending = null; if (cb) cb(e.data || {}); };
          worker.onerror = () => { worker = null; dead = true; };
        } catch (e) { dead = true; }
      }
      function request(fen, level, cb) {
        ensure();
        if (!worker) {
          setTimeout(() => {
            let mv = null;
            try { mv = window.ChessEngine.bestMove(fen, level); } catch (e) { /* noop */ }
            cb({ move: mv });
          }, 30);
          return;
        }
        pending = cb;
        worker.postMessage({ fen, level, id: 1 });
      }
      return { request };
    })();

    let sf = null;                 // the Stockfish worker
    let usingStockfish = null;     // null = unknown yet, true/false after boot
    let broken = false;
    let onBest = null;             // waiter for the current 'go'
    let readyResolve = null;
    const ready = new Promise(r => readyResolve = r);
    let chain = ready;             // serialize UCI conversations

    function boot() {
      if (sf || broken) return;
      try {
        sf = new Worker('/vendor/stockfish.js');
      } catch (e) { broken = true; usingStockfish = false; readyResolve(); return; }
      const giveUp = setTimeout(() => {
        if (usingStockfish === null) { broken = true; usingStockfish = false; readyResolve(); if (onBest) onBest(''); }
      }, 12000);
      sf.onmessage = e => {
        const s = typeof e.data === 'string' ? e.data : (e.data && e.data.line) || '';
        if (s.includes('uciok') && usingStockfish === null) {
          usingStockfish = true;
          clearTimeout(giveUp);
          readyResolve();
        }
        if (s.startsWith('bestmove')) {
          const cb = onBest; onBest = null;
          if (cb) cb(s.split(' ')[1] || '');
        }
      };
      sf.onerror = () => {
        broken = true;
        if (usingStockfish === null) { usingStockfish = false; readyResolve(); }
        if (onBest) onBest('');
      };
      sf.postMessage('uci');
    }

    /* one 'go' — resolves with a uci move like "e2e4" or "" on failure */
    function askBest(fen, level) {
      const lv = SF_LEVELS[level] || SF_LEVELS[2];
      return new Promise(resolve => {
        onBest = uci => {
          clearTimeout(hardStop); clearTimeout(giveUp);
          resolve(uci);
        };
        const hardStop = setTimeout(() => { if (onBest) sf.postMessage('stop'); }, lv.movetime + 6000);
        const giveUp = setTimeout(() => { if (onBest) { onBest = null; resolve(''); } }, lv.movetime + 10000);
        sf.postMessage(`setoption name Skill Level value ${lv.skill}`);
        sf.postMessage(`position fen ${fen}`);
        sf.postMessage(`go depth ${lv.depth} movetime ${lv.movetime}`);
      });
    }

    function request(fen, level, cb) {
      boot();
      chain = chain.then(async () => {
        if (broken || !usingStockfish) { legacy.request(fen, level, cb); return; }
        let uci = '';
        try { uci = await askBest(fen, level); } catch (e) { uci = ''; }
        if (!uci || uci === '(none)') {
          // engine stalled — fall back to the built-in engine for this move and after
          broken = true; usingStockfish = false;
          try { sf.terminate(); } catch (e) { /* noop */ }
          legacy.request(fen, level, cb);
          return;
        }
        cb({ move: { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: /[nbrq]/.test(uci[4] || '') ? uci[4] : undefined } });
      }).catch(() => legacy.request(fen, level, cb));
    }
    return { request, kind: () => (usingStockfish === true ? 'stockfish' : usingStockfish === false ? 'legacy' : 'booting') };
  })();

  function scheduleBot() {
    if (mode !== 'bot' || gameOver || chess.turn() !== botSeat) return;
    updateStatus('Bot is thinking…');
    const fen = chess.fen();
    setTimeout(() => {
      if (mode !== 'bot' || gameOver || chess.fen() !== fen) return;
      EngineClient.request(fen, botLevel, res => {
        if (mode !== 'bot' || gameOver || chess.fen() !== fen) return;
        if (res && res.move) performMove(res.move);
        else if (res && res.err) toast('Bot error: ' + res.err, 'warn');
      });
    }, 380 + Math.random() * 420);
  }

  /* ---------------- HUD ---------------- */
  function updateStatus(override) {
    const el = $('status-text');
    const pill = $('status-pill');
    let txt;
    if (override) txt = override;
    else if (gameOver) txt = 'Game over';
    else if (mode === 'bot') txt = chess.turn() === botSeat ? 'Bot is thinking…' : 'Your move';
    else if (mode === 'online') {
      if (inLobby) txt = 'Waiting…';
      else txt = chess.turn() === mySeat ? 'Your move' : 'Opponent\u2019s move…';
      if (oppDisconnected && !gameOver) txt = 'Opponent disconnected…';
    }
    else txt = (chess.turn() === 'w' ? 'White' : 'Black') + ' to move';
    if (!override && !gameOver && chess.in_check()) txt += ' — CHECK!';
    el.textContent = txt;
    pill.classList.toggle('check', !gameOver && chess.in_check());
    const dot = $('turn-dot');
    dot.classList.toggle('b', chess.turn() === 'b');
  }

  function updateHUD() {
    // movelist
    const ol = $('movelist');
    ol.innerHTML = '';
    for (let i = 0; i < sanList.length; i += 2) {
      const li = document.createElement('li');
      const n = document.createElement('span'); n.className = 'num'; n.textContent = (i / 2 + 1) + '.';
      const a = document.createElement('span'); a.className = 'mv'; a.textContent = sanList[i];
      li.appendChild(n); li.appendChild(a);
      if (sanList[i + 1]) {
        const b = document.createElement('span'); b.className = 'mv b'; b.textContent = sanList[i + 1];
        li.appendChild(b);
      }
      ol.appendChild(li);
    }
    ol.parentElement && (ol.scrollTop = ol.scrollHeight);

    // captured trays
    const lost = computeCaptured();
    const topSeat = mode === 'local' ? 'b' : (mySeat === 'w' ? 'b' : 'w');
    const bottomSeat = mode === 'local' ? 'w' : mySeat;
    const render = (types, ofColor) => types.sort((x, y) => ORDER[y] - ORDER[x]).map(t => `<span class="${ofColor}">${GLYPH[ofColor][t]}</span>`).join('');
    // top chip shows pieces the TOP player captured (= enemy pieces that died)
    $('tray-top').innerHTML = render(lost[oppColor(topSeat)], oppColor(topSeat));
    $('tray-bottom').innerHTML = render(lost[oppColor(bottomSeat)], oppColor(bottomSeat));
  }
  function oppColor(c) { return c === 'w' ? 'b' : 'w'; }
  function seatPlayer(st, seat) {
    return (st.players || []).find(p => p && p.seat === seat) || null;
  }

  function setChips() {
    const top = $('chip-top'), bottom = $('chip-bottom');
    const avT = $('av-top'), avB = $('av-bottom');
    if (mode === 'bot') {
      const botIsW = botSeat === 'w';
      $('name-top').textContent = BOT_NAMES[botLevel] + (botLevel === 3 ? ' 👑' : '');
      $('name-bottom').textContent = myName() + ' (you)';
      avT.textContent = botIsW ? '♔' : '♚';
      avT.classList.toggle('black', !botIsW);
      avB.textContent = botIsW ? '♚' : '♔';
      avB.classList.toggle('black', botIsW);
    } else if (mode === 'local') {
      $('name-top').textContent = 'Black';
      $('name-bottom').textContent = 'White';
      avT.textContent = '♚'; avT.classList.add('black');
      avB.textContent = '♔'; avB.classList.remove('black');
    } else if (mode === 'online') {
      const opp = oppColor(mySeat);
      $('name-top').textContent = (seatPlayer(roomStateCache, opp) ? seatPlayer(roomStateCache, opp).name : 'Opponent');
      $('name-bottom').textContent = myName() + ' (you)';
      avT.textContent = opp === 'w' ? '♔' : '♚';
      avT.classList.toggle('black', opp === 'b');
      avB.textContent = mySeat === 'w' ? '♔' : '♚';
      avB.classList.toggle('black', mySeat === 'b');
    }
  }

  let roomStateCache = { players: {} };

  /* ---------------- board interaction ---------------- */
  function controlsTurn() {
    if (!mode || gameOver) return false;
    if (mode === 'local') return true;
    return chess.turn() === mySeat;
  }

  C3D.onTap((x, y) => {
    SFX.unlock();
    if (!mode || inLobby || gameOver || busy || !controlsTurn()) return;
    const sq = C3D.pick(x, y);
    if (!sq) { deselect(); return; }

    if (selected) {
      if (sq === selected) { deselect(); return; }   // tap the piece again to put it down
      const t = targets.find(m => m.to === sq);
      if (t) {
        if (t.promotion) askPromotion(t);
        else playerMove({ from: t.from, to: t.to });
        return;
      }
    }
    const pc = chess.get(sq);
    if (pc && pc.color === chess.turn()) select(sq);
    else deselect();
  });

  let lastFrom = null, lastTo = null;
  function select(sq) {
    if (selected) deselect(); // put down any currently held piece first
    selected = sq;
    targets = chess.moves({ square: sq, verbose: true });
    C3D.showSelection(sq);
    C3D.showMoves(targets.map(m => ({ square: m.to, capture: !!m.captured })));
    if (targets.length) SFX.tick();
    else {
      // no legal moves (e.g. the king early game) — say so instead of looking dead
      const inCheck = chess.in_check();
      toast(inCheck
        ? 'King is in check — no legal moves from there!'
        : 'No legal moves for that piece', 'warn');
      setTimeout(() => { if (selected === sq) deselect(); }, 650);
    }
  }
  function deselect() {
    selected = null; targets = [];
    C3D.clearMoveHighlights();
    if (lastFrom && lastTo) C3D.showLastMove(lastFrom, lastTo);
    if (!gameOver && chess.in_check()) C3D.showCheck(kingSquare(chess.turn()));
  }

  async function resync() {
    if (mode !== 'online' || !room) return;
    try {
      const st = await apiGet(`state?code=${room.code}&pid=${room.pid}`);
      if (st && st.ok) handleState(st);
    } catch (e) { /* polling will retry */ }
  }

  let promoResolve = null;
  function askPromotion(moveObj) {
    const color = chess.turn();
    document.querySelectorAll('#promo-choices .pg').forEach(el => {
      const p = el.parentElement.dataset.p;
      el.textContent = GLYPH[color][p];
    });
    $('promo-modal').classList.remove('hidden');
    deselect();
    promoResolve = choice => {
      $('promo-modal').classList.add('hidden');
      promoResolve = null;
      if (choice) playerMove({ from: moveObj.from, to: moveObj.to, promotion: choice });
    };
  }
  document.querySelectorAll('#promo-choices button').forEach(btn => {
    btn.addEventListener('click', () => { if (promoResolve) promoResolve(btn.dataset.p); });
  });

  /* ---------------- making moves ---------------- */
  let inflight = null; // our move currently being POSTed (used to skip echo-apply via polling)

  async function playerMove(mv) {
    if (busy || gameOver) return;
    deselect();
    if (mode === 'online') {
      busy = true;
      inflight = mv;
      try {
        const r = await api('move', { code: room.code, pid: room.pid, from: mv.from, to: mv.to, promotion: mv.promotion });
        if (!r.ok) {
          busy = false; inflight = null;
          toast(r.error || 'Move rejected', 'warn');
          if (r.state) fullSync(r.state);
          return;
        }
        lastVersion = r.state.version;
      } catch (e) {
        busy = false; inflight = null;
        toast('Connection problem — try again', 'warn');
        return;
      }
      inflight = null;
      busy = false; // hand off — performMove re-acquires the lock synchronously
    }
    await performMove(mv);
  }

  async function performMove(mv) {
    if (busy && !pendingMove) { pendingMove = mv; return; }
    busy = true;
    const v = chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    if (!v) { busy = false; if (mode === 'online') resync(); return; }
    sanList.push(v.san);
    lastVerbose = { from: v.from, to: v.to, promotion: v.promotion };
    lastFrom = v.from; lastTo = v.to;
    C3D.clearMoveHighlights();
    try {
      await C3D.animateVerboseMove(v);
    } catch (e) { console.error(e); }
    C3D.showLastMove(v.from, v.to);
    busy = false;
    afterMove(v);
    if (pendingMove) { const m = pendingMove; pendingMove = null; performMove(m); }
  }

  function afterMove(v) {
    updateHUD();
    updateStatus();
    if (chess.game_over()) { endGameFromLocal(); return; }
    if (chess.in_check()) {
      C3D.showCheck(kingSquare(chess.turn()));
      SFX.check();
      toast('Check!', 'warn');
    } else {
      C3D.showCheck(null);
    }
    if (mode === 'bot') scheduleBot();
  }

  /* ---------------- game end ---------------- */
  function endGameFromLocal() {
    let type, winner;
    if (chess.in_checkmate()) { type = 'checkmate'; winner = chess.turn() === 'w' ? 'b' : 'w'; }
    else if (chess.in_stalemate()) { type = 'stalemate'; winner = null; }
    else { type = 'draw'; winner = null; }
    endGame(type, winner);
  }

  function endGame(type, winner) {
    if (gameOver) return;
    gameOver = true;
    deselect();
    C3D.showCheck(null);
    updateStatus();

    const icon = $('result-icon'), title = $('result-title'), sub = $('result-sub');
    const youWin = mode !== 'local' && winner === mySeat;
    const youLose = mode !== 'local' && winner && winner !== mySeat;

    if (type === 'checkmate') {
      icon.textContent = youLose ? '🗡️' : '🏆';
      title.textContent = 'Checkmate!';
      sub.textContent = mode === 'local'
        ? (winner === 'w' ? 'White wins by the sword' : 'Black wins by the sword')
        : youWin ? 'You win — the enemy king has fallen ⚔' : 'You lose — your king has fallen';
    } else if (type === 'resigned') {
      icon.textContent = '🏳️';
      title.textContent = 'Resignation';
      sub.textContent = mode === 'local'
        ? (winner === 'w' ? 'Black resigned — White wins' : 'White resigned — Black wins')
        : youWin ? 'Your opponent resigned — you win!'
        : (mode === 'bot' ? 'You resigned — the bot wins' : 'You resigned — opponent wins');
    } else if (type === 'stalemate') {
      icon.textContent = '🤝';
      title.textContent = 'Stalemate';
      sub.textContent = 'The battle ends in a draw';
    } else {
      icon.textContent = '🤝';
      title.textContent = 'Draw';
      sub.textContent = 'Neither side can force a win';
    }

    $('btn-result-rematch').classList.toggle('hidden', mode === null);
    $('rematch-waiting').classList.add('hidden');
    rematchWanted = false;
    $('result-modal').classList.remove('hidden');

    if (mode === 'local') { if (type === 'checkmate') SFX.win(); else SFX.draw(); }
    else if (youWin) SFX.win();
    else if (youLose) SFX.lose();
    else SFX.draw();
  }

  /* ---------------- start / reset ---------------- */
  function startGame(m, opts = {}) {
    mode = m;
    gameOver = false;
    inLobby = false;
    chess.reset();
    sanList = [];
    lastVerbose = null;
    lastFrom = lastTo = null;
    pendingMove = null;
    selected = null; targets = [];
    busy = false;
    oppDisconnected = false;
    rematchWanted = false;

    if (m === 'bot') {
      mySeat = opts.side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : opts.side;
      botSeat = oppColor(mySeat);
      botLevel = opts.level || 2;
    } else if (m === 'local') {
      mySeat = null; botSeat = null;
    } else if (m === 'online') {
      mySeat = opts.seat;
    }

    C3D.buildFromFen(chess.fen());
    C3D.clearMoveHighlights();
    C3D.showCheck(null);
    setChips();
    updateHUD();
    updateStatus();

    // controls visibility
    $('btn-undo').classList.toggle('hidden', !(m === 'bot' || m === 'local'));
    $('btn-resign').classList.toggle('hidden', !(m === 'online' || m === 'bot' || m === 'local'));
    $('btn-resign').classList.toggle('danger', true);

    hideAllMenuSections();
    $('menu').classList.add('hidden');
    $('result-modal').classList.add('hidden');
    $('hud').classList.remove('hidden');

    const viewSeat = (m === 'local') ? 'w' : (mySeat || 'w');
    C3D.setView(viewSeat, false);

    if (m === 'bot' && chess.turn() === botSeat) scheduleBot();
    if (m !== 'online') toast(m === 'bot' ? `You are ${mySeat === 'w' ? 'White' : 'Black'} — good luck! ⚔` : 'White moves first');
  }

  function resetToMenu() {
    stopPolling();
    if (room) {
      api('leave', { code: room.code, pid: room.pid });
      room = null;
    }
    try { sessionStorage.removeItem('bc3d_room'); } catch (e) { /* ignore */ }
    try { localStorage.removeItem('bc3d_room'); } catch (e) { /* ignore */ }
    mode = null; gameOver = false; inLobby = false;
    deselect();
    chess.reset();
    C3D.buildFromFen(chess.fen());
    C3D.clearMoveHighlights();
    C3D.showCheck(null);
    $('hud').classList.add('hidden');
    $('result-modal').classList.add('hidden');
    $('promo-modal').classList.add('hidden');
    showMenuSection('menu-home');
    $('menu').classList.remove('hidden');
    refreshRejoinChip();
    C3D.autoRotate(true); // slow cinematic drift behind the menu
  }

  /* ---------------- online: rooms ---------------- */
  function saveRoom() {
    if (!room) return;
    // sessionStorage = per-tab (survives refresh, not shared with other tabs);
    // localStorage = lets the menu offer a rejoin after the tab was closed
    try { sessionStorage.setItem('bc3d_room', JSON.stringify(room)); } catch (e) { /* ignore */ }
    try { localStorage.setItem('bc3d_room', JSON.stringify(room)); } catch (e) { /* ignore */ }
  }

  async function createRoom() {
    const r = await api('create', { name: myName() });
    if (!r.ok) { toast(r.error || 'Could not create room', 'warn'); return; }
    room = { code: r.code, pid: r.pid };
    saveRoom();
    enterLobby(r.state);
  }

  function enterLobby(state) {
    inLobby = true;
    gameOver = false; mode = 'online';
    mySeat = 'w';
    $('code-display').textContent = state ? state.code : room.code;
    showMenuSection('menu-lobby');
    startPolling();
  }

  async function joinRoom(code) {
    code = ('' + code).trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) { showJoinError('Enter the 5-character room code'); return; }
    // always take a FRESH seat on join (refresh recovery uses sessionStorage + the rejoin chip)
    const r = await api('join', { code, name: myName() });
    if (!r.ok) { showJoinError(r.error || 'Could not join'); return; }
    room = { code, pid: r.pid };
    saveRoom();
    inLobby = false;
    hideAllMenuSections();
    $('menu').classList.add('hidden');
    beginOnlineGame(r.state);
    toast('Joined room ' + code + ' — you are ' + (r.seat === 'w' ? 'White' : 'Black') + ' ⚔', 'good');
  }
  function showJoinError(msg) {
    const el = $('join-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function savedRoom() {
    try {
      const s = sessionStorage.getItem('bc3d_room');
      if (s) return JSON.parse(s);
    } catch (e) { /* ignore */ }
    try { return JSON.parse(localStorage.getItem('bc3d_room')); } catch (e) { return null; }
  }
  async function refreshRejoinChip() {
    const chip = $('rejoin-chip');
    const sr = savedRoom();
    if (!sr || !sr.code) { chip.classList.add('hidden'); return; }
    try {
      const st = await apiGet(`state?code=${sr.code}&pid=${sr.pid}`);
      if (st && st.ok && st.you) {
        chip.innerHTML = `↩ Rejoin room <b>${sr.code}</b> — game in progress`;
        chip.classList.remove('hidden');
        chip.onclick = async () => {
          room = { code: sr.code, pid: sr.pid };
          const st2 = await apiGet(`state?code=${sr.code}&pid=${sr.pid}`);
          if (st2 && st2.ok && st2.you) {
            inLobby = false;
            hideAllMenuSections();
            $('menu').classList.add('hidden');
            beginOnlineGame(st2);
          } else {
            toast('That room has ended', 'warn');
            localStorage.removeItem('bc3d_room');
            chip.classList.add('hidden');
          }
        };
      } else {
        chip.classList.add('hidden');
        localStorage.removeItem('bc3d_room');
      }
    } catch (e) { chip.classList.add('hidden'); }
  }

  function beginOnlineGame(state) {
    roomStateCache = state;
    gameId = state.gameId;
    lastVersion = state.version;
    startGame('online', { seat: state.you });
    fullSync(state);
    startPolling();
    if (state.status !== 'waiting' && state.status !== 'active') endGame(state.status, state.winner);
  }

  function fullSync(state) {
    roomStateCache = state;
    if (state.fen && state.fen !== chess.fen()) {
      chess.load(state.fen());
      sanList = [...(state.history || [])];
      C3D.buildFromFen(state.fen());
    }
    if (state.you) mySeat = state.you;
    setChips();
    updateHUD();
    updateStatus();
    if (state.lastMove) { lastFrom = state.lastMove.from; lastTo = state.lastMove.to; C3D.showLastMove(lastFrom, lastTo); }
    else { lastFrom = lastTo = null; }
    C3D.showCheck(state.inCheck ? kingSquare(chess.turn()) : null);
    if (state.status === 'active' || state.status === 'waiting') {
      gameOver = false;
      $('result-modal').classList.add('hidden');
    }
    const viewSeat = mySeat || 'w';
    C3D.setView(viewSeat, false);
  }

  /* ---------------- online: polling ---------------- */
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollTick, 950);
    pollTick();
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function pollTick() {
    if (!room) return;
    let st;
    try {
      st = await apiGet(`state?code=${room.code}&pid=${room.pid}`);
    } catch (e) { return; }
    if (!st || !st.ok) {
      if (st && st.error && /not found/i.test(st.error) && mode === 'online') {
        toast('Room closed', 'warn');
        resetToMenu();
      }
      return;
    }
    handleState(st);
  }

  function sameMove(a, b) {
    return a && b && a.from === b.from && a.to === b.to && (a.promotion || null) === (b.promotion || null);
  }

  function handleState(st) {
    roomStateCache = st;
    // lobby -> game starts when opponent joins
    if (inLobby) {
      if (st.status !== 'waiting') {
        inLobby = false;
        hideAllMenuSections();
        $('menu').classList.add('hidden');
        SFX.join();
        beginOnlineGame(st);
        toast('Your opponent has joined — battle! ⚔', 'good');
      }
      return;
    }
    if (mode !== 'online') return;

    // rematch / new game
    if (st.gameId !== gameId) {
      gameId = st.gameId;
      lastVersion = st.version;
      gameOver = false;
      rematchWanted = false;
      fullSync(st);
      $('result-modal').classList.add('hidden');
      toast('Rematch! You are now ' + (mySeat === 'w' ? 'White' : 'Black'), 'good');
      return;
    }

    // opponent move
    if (st.version > lastVersion) {
      lastVersion = st.version;
      const h = st.history || [];
      if (h.length === sanList.length && sameMove(st.lastMove, lastVerbose)) {
        /* our own move, already applied */
      } else if (h.length === sanList.length + 1 && st.lastMove) {
        if (inflight && sameMove(st.lastMove, inflight)) {
          /* our own in-flight move — the POST response applies it */
        } else {
          const mv = { from: st.lastMove.from, to: st.lastMove.to, promotion: st.lastMove.promotion };
          if (busy) pendingMove = mv;
          else performMove(mv);
        }
      } else if (h.length !== sanList.length) {
        fullSync(st);
      }
    }

    // terminal statuses arriving from the server (resign etc.)
    if (!gameOver && ['resigned', 'checkmate', 'stalemate', 'draw'].includes(st.status)) {
      endGame(st.status === 'resigned' ? 'resigned' : st.status, st.winner);
    }

    // rematch flags
    if (gameOver) {
      const opp = seatPlayer(st, oppColor(mySeat));
      const iWant = rematchWanted;
      const theyWant = opp && opp.rematch;
      if (iWant && theyWant) { /* server will bump gameId */ }
      else if (theyWant && !iWant) {
        $('rematch-waiting').textContent = '⚔ Your opponent wants a rematch!';
        $('rematch-waiting').classList.remove('hidden');
      } else if (iWant && !theyWant) {
        $('rematch-waiting').textContent = 'Waiting for opponent to accept…';
        $('rematch-waiting').classList.remove('hidden');
      }
    }

    // connection status
    const opp = seatPlayer(st, oppColor(mySeat));
    const disc = opp && !opp.connected;
    if (disc !== oppDisconnected) {
      oppDisconnected = disc;
      updateStatus();
      if (disc) toast('Opponent disconnected…', 'warn');
      else if (!gameOver) toast('Opponent reconnected', 'good');
    }
    $('conn-top').classList.toggle('hidden', !oppDisconnected);
  }

  /* ---------------- menu wiring ---------------- */
  function hideAllMenuSections() {
    ['menu-home', 'menu-bot', 'menu-code', 'menu-lobby'].forEach(id => $(id).classList.add('hidden'));
  }
  function showMenuSection(id) {
    hideAllMenuSections();
    $(id).classList.remove('hidden');
    $('join-error').classList.add('hidden');
  }

  document.querySelectorAll('.mode-card').forEach(btn => {
    btn.addEventListener('click', () => {
      SFX.unlock();
      const m = btn.dataset.mode;
      if (m === 'bot') showMenuSection('menu-bot');
      else if (m === 'code') showMenuSection('menu-code');
      else if (m === 'local') startGame('local', {});
    });
  });
  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => showMenuSection('menu-home'));
  });

  // segmented controls
  function wireSeg(id, initial, cb) {
    const seg = $(id);
    let val = initial;
    const upd = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === val));
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { val = b.dataset.v; upd(); if (cb) cb(val); }));
    upd();
    return () => val;
  }
  const getSide = wireSeg('seg-side', 'w');
  const getLevel = wireSeg('seg-level', '2');

  $('btn-start-bot').addEventListener('click', () => {
    SFX.unlock();
    startGame('bot', { side: getSide(), level: +getLevel() });
  });

  $('btn-create-room').addEventListener('click', async () => {
    SFX.unlock();
    showMenuSection('menu-lobby');
    $('code-display').textContent = '· · · · ·';
    await createRoom();
  });

  $('btn-join-room').addEventListener('click', () => { SFX.unlock(); joinRoom($('input-code').value); });
  $('input-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('input-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(e.target.value); });

  $('btn-copy-code').addEventListener('click', () => copyText(room ? room.code : '', 'Code copied!'));
  $('btn-copy-link').addEventListener('click', () => copyText(location.origin + '/?join=' + (room ? room.code : ''), 'Invite link copied!'));
  async function copyText(txt, msg) {
    try {
      await navigator.clipboard.writeText(txt);
      toast(msg, 'good');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(msg, 'good'); } catch (_) { toast('Copy failed — code: ' + txt); }
      ta.remove();
    }
  }

  $('btn-cancel-room').addEventListener('click', () => resetToMenu());

  /* ---------------- in-game controls ---------------- */
  $('btn-flip').addEventListener('click', () => C3D.flipView());
  $('btn-sound').addEventListener('click', () => {
    const on = !SFX.enabled;
    SFX.setEnabled(on);
    $('btn-sound').firstChild.textContent = on ? '🔊' : '🔇';
    if (on) SFX.tick();
  });
  $('btn-undo').addEventListener('click', () => {
    if (busy || gameOver || !mode) return;
    if (mode === 'bot') {
      if (sanList.length < 2 || chess.turn() !== mySeat) return;
      chess.undo(); chess.undo();
      sanList.pop(); sanList.pop();
    } else if (mode === 'local') {
      if (!sanList.length) return;
      chess.undo(); sanList.pop();
    }
    rebuildBoard();
  });
  $('btn-resign').addEventListener('click', async () => {
    if (gameOver || !mode) return;
    if (mode === 'online') {
      const r = await api('resign', { code: room.code, pid: room.pid });
      if (r && r.ok) endGame('resigned', oppColor(mySeat));
    } else if (mode === 'bot') {
      endGame('resigned', botSeat);
    } else {
      endGame('resigned', chess.turn() === 'w' ? 'b' : 'w');
    }
  });
  $('btn-menu').addEventListener('click', () => resetToMenu());

  $('btn-result-rematch').addEventListener('click', async () => {
    if (mode === 'online') {
      rematchWanted = true;
      $('rematch-waiting').textContent = 'Waiting for opponent to accept…';
      $('rematch-waiting').classList.remove('hidden');
      await api('rematch', { code: room.code, pid: room.pid });
    } else if (mode === 'bot') {
      startGame('bot', { side: mySeat, level: botLevel });
    } else if (mode === 'local') {
      startGame('local', {});
    }
  });
  $('btn-result-menu').addEventListener('click', () => resetToMenu());

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('promo-modal').classList.contains('hidden')) { if (promoResolve) promoResolve(null); }
      else deselect();
    }
  });

  function rebuildBoard() {
    deselect();
    C3D.buildFromFen(chess.fen());
    C3D.clearMoveHighlights();
    lastFrom = lastTo = null;
    C3D.showCheck(chess.in_check() ? kingSquare(chess.turn()) : null);
    updateHUD();
    updateStatus();
    if (mode === 'bot' && chess.turn() === botSeat) scheduleBot();
  }

  /* ---------------- boot ---------------- */
  // read-only debug hook (used by automated tests; handy for support too)
  window.BC3D_DEBUG = () => ({
    mode, mySeat, botSeat, botLevel, engine: EngineClient.kind(), busy, inLobby, gameOver,
    fen: chess.fen(), turn: chess.turn(), inCheck: chess.in_check(),
    sanList, selected, targets: targets.length,
    room: room ? room.code : null,
    lastVersion, gameId, oppDisconnected, pendingMove: !!pendingMove
  });

  function boot() {
    try {
      C3D.init($('scene-container'));
    } catch (e) {
      document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#eae5d8;font-family:Georgia,serif;text-align:center"><div><h1>⚔️ Blade Chess 3D</h1><p>WebGL is not available in this browser.</p></div></div>';
      return;
    }
    if (SFX.enabled === false) $('btn-sound').firstChild.textContent = '🔇';
    C3D.autoRotate(true);
    refreshRejoinChip();

    // ?join=CODE deep link
    const params = new URLSearchParams(location.search);
    const joinCode = params.get('join');
    if (joinCode) {
      showMenuSection('menu-code');
      $('input-code').value = joinCode.toUpperCase();
      history.replaceState(null, '', location.pathname);
      joinRoom(joinCode);
    }
  }
  boot();
})();
