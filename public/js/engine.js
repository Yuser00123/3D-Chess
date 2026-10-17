/* ============================================================
   Blade Chess 3D — bot engine
   Minimax + alpha-beta + quiescence search with piece-square
   tables. Runs inside a Web Worker (importScripts'd) or on the
   main thread as a fallback (window.ChessEngine).
   ============================================================ */
(function (root) {
  'use strict';

  const ChessCtor = root.Chess;

  const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

  /* Piece-square tables (white perspective, row 0 = rank 8).
     Classic "simplified evaluation" values. */
  const PST = {
    p: [
       0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0
    ],
    n: [
      -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50
    ],
    b: [
      -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20
    ],
    r: [
        0,  0,  0,  0,  0,  0,  0,  0,
        5, 10, 10, 10, 10, 10, 10,  5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
        0,  0,  0,  5,  5,  0,  0,  0
    ],
    q: [
      -20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20
    ],
    k: [
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20
    ]
  };

  /* white-positive evaluation */
  function evalBoard(game) {
    const board = game.board();
    let score = 0, wb = 0, bb = 0;
    for (let r = 0; r < 8; r++) {
      const row = board[r];
      for (let f = 0; f < 8; f++) {
        const sq = row[f];
        if (!sq) continue;
        const idx = sq.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
        const v = VAL[sq.type] + PST[sq.type][idx];
        score += sq.color === 'w' ? v : -v;
        if (sq.type === 'b') { if (sq.color === 'w') wb++; else bb++; }
      }
    }
    if (wb >= 2) score += 30;
    if (bb >= 2) score -= 30;
    return score;
  }

  function orderMoves(ms) {
    for (const m of ms) {
      let s = 0;
      if (m.captured) s += 10 * VAL[m.captured] - VAL[m.piece];
      if (m.promotion) s += 800;
      if (m.san && (m.san.includes('+') || m.san.includes('#'))) s += 60;
      m._s = s;
    }
    ms.sort((a, b) => b._s - a._s);
    return ms;
  }

  function quiesce(game, alpha, beta, qdepth, counter) {
    const sign = game.turn() === 'w' ? 1 : -1;
    const stand = sign * evalBoard(game);
    if (qdepth === 0) return stand;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    const caps = orderMoves(game.moves({ verbose: true })
      .filter(m => m.flags && (m.flags.includes('c') || m.flags.includes('e') || m.flags.includes('p'))));
    for (const m of caps) {
      counter.n++;
      if (counter.n > 300000) break;
      game.move(m);
      const sc = -quiesce(game, -beta, -alpha, qdepth - 1, counter);
      game.undo();
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }

  function search(game, depth, alpha, beta, ply, useQ, counter) {
    counter.n++;
    if (depth === 0) {
      return useQ ? quiesce(game, alpha, beta, 4, counter)
                  : (game.turn() === 'w' ? 1 : -1) * evalBoard(game);
    }
    const moves = orderMoves(game.moves({ verbose: true }));
    if (moves.length === 0) {
      return game.in_check() ? -100000 + ply : 0;
    }
    for (const m of moves) {
      if (counter.n > 300000) break;
      game.move(m);
      const sc = -search(game, depth - 1, -beta, -alpha, ply + 1, useQ, counter);
      game.undo();
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }

  /* tiny opening book so games don't all start identically */
  const BOOK = {
    1: ['e2e4', 'd2d4', 'g1f3', 'c2c4'],
    2: { e2e4: ['e7e5', 'c7c5', 'e7e6', 'c7c6'], d2d4: ['d7d5', 'g8f6', 'e7e6'], g1f3: ['d7d5', 'g8f6'], c2c4: ['e7e5', 'g8f6'] }
  };

  function bestMove(fen, level) {
    const game = new ChessCtor(fen);
    if (game.game_over()) return null;
    const moves = orderMoves(game.moves({ verbose: true }));
    if (moves.length === 0) return null;
    if (moves.length === 1) return { from: moves[0].from, to: moves[0].to, promotion: moves[0].promotion };

    // compute real ply from the FEN (history is empty when loading a position)
    const parts = fen.split(' ');
    const fullmove = parseInt(parts[5], 10) || 1;
    const ply = (fullmove - 1) * 2 + (game.turn() === 'b' ? 1 : 0);
    if (ply <= 3) {
      // opening book — first white move, or the black reply
      let opts = null;
      if (ply === 0) opts = BOOK[1];
      else {
        // find what the first white move was by diffing against the start position
        const start = new ChessCtor();
        const startCounts = {};
        for (const row of start.board()) for (const s of row)
          if (s && s.color === 'w') startCounts[s.type + s.square] = true;
        const cur = game.board();
        const fromSq = {}, toSq = {};
        let moved = null;
        for (const row of cur) for (const s of row) {
          if (!s || s.color !== 'w') continue;
          if (!startCounts[s.type + s.square]) moved = s; // piece not on its start square
        }
        if (moved) {
          const map = { p: 'e2e4-ish', n: 'g1f3', b: 'f1c4', q: 'd1d4-ish', k: null };
          // infer: pawn on e4/d4/c4 -> that push; knight on f3 -> Nf3; bishop c4 -> c2c4
          if (moved.type === 'p' && moved.square === 'e4') opts = BOOK[2]['e2e4'];
          else if (moved.type === 'p' && moved.square === 'd4') opts = BOOK[2]['d2d4'];
          else if (moved.type === 'p' && moved.square === 'c4') opts = BOOK[2]['c2c4'];
          else if (moved.type === 'n' && moved.square === 'f3') opts = BOOK[2]['g1f3'];
        }
        opts = opts || BOOK[1];
      }
      if (opts) {
        const legal = opts.map(uc => moves.find(mv => mv.from + mv.to === uc)).filter(Boolean);
        if (legal.length) {
          const pick = legal[(Math.random() * legal.length) | 0];
          return { from: pick.from, to: pick.to, promotion: pick.promotion };
        }
      }
    }

    const cfg = level >= 3 ? { depth: 3, noise: 0, useQ: true }
              : level === 2 ? { depth: 2, noise: 22, useQ: true }
              : { depth: 1, noise: 70, useQ: false };
    const counter = { n: 0 };
    const scored = [];

    if (cfg.noise > 0) {
      // full-window root scores so we can pick randomly among near-best moves
      for (const m of moves) {
        counter.n++;
        game.move(m);
        const sc = -search(game, cfg.depth - 1, -Infinity, Infinity, 1, cfg.useQ, counter);
        game.undo();
        scored.push({ m, sc });
      }
      scored.sort((a, b) => b.sc - a.sc);
      const best = scored[0].sc;
      const pool = scored.filter(s => s.sc >= best - cfg.noise);
      const pick = pool[(Math.random() * pool.length) | 0];
      return { from: pick.m.from, to: pick.m.to, promotion: pick.m.promotion || undefined };
    }

    // strong mode: pure alpha-beta at the root
    let alpha = -Infinity, best = null;
    for (const m of moves) {
      counter.n++;
      game.move(m);
      const sc = -search(game, cfg.depth - 1, -Infinity, -alpha, 1, cfg.useQ, counter);
      game.undo();
      if (sc > alpha) { alpha = sc; best = m; }
    }
    best = best || moves[0];
    return { from: best.from, to: best.to, promotion: best.promotion || undefined };
  }

  const api = { bestMove };

  /* worker mode */
  if (typeof importScripts === 'function' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = (e) => {
      const { fen, level, id } = e.data || {};
      let move = null, err = null;
      try { move = bestMove(fen, level); } catch (ex) { err = '' + ex; }
      self.postMessage({ id, move, err });
    };
  }

  root.ChessEngine = api;
})(typeof self !== 'undefined' ? self : this);
