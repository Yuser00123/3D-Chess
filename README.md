# ⚔️ Blade Chess 3D

A smooth 3D chess website with **real sculpted pieces** (King, Queen, Rook, Bishop, Knight, Pawns built as true 3D models), **silky move animations**, and **Harry-Potter-style sword duels** — when a piece captures another, both pieces draw their swords, the blades clash, the defender is disarmed, and the attacker cuts it in two.

![game](screenshots/shot-game.png)

## Play

- **🤖 Play vs Bot** — three **Stockfish** difficulty levels: *Squire* (easy, skill 1), *Knight* (medium, skill 8), *King* (hard, skill 18). Pick your side.
- **🛡️ Play with a Code** — create a room, share the 5-letter code (or invite link) with a friend, and duel online. Includes rematch (colors swap), resign, reconnect and refresh recovery.
- **👥 Local 2 Players** — pass & play on one screen.

## Controls

| Action | How |
|---|---|
| Move a piece | Click your piece, then click a highlighted square |
| Orbit camera | Drag |
| Zoom | Scroll / pinch |
| Flip camera | ⇅ button |
| Undo (bot / local) | ↩ button |
| Resign | 🏳 button |

Extras: move hints (dots = moves, red rings = captures), last-move highlight, pulsing check warning, captured-piece trays, move history in algebraic notation, promotion picker, synthesized sound effects (toggle with 🔊).

Add `?fx=low` to the URL for a lighter mode on weak devices (no shadows/dust). Add `?join=CODE` to jump straight into a room.

## Run it

Zero dependencies — plain Node.js:

```bash
node server.js          # → http://localhost:3000
PORT=8080 node server.js
```

To play a code game with a friend, keep the server reachable and share your URL + room code.

## Tech

- **Three.js (r128)** — procedural pieces: lathe-turned bodies, extruded knight heads, gold crown/cross details; ACES tone mapping, soft shadows, fog, dust motes.
- **Sword-duel captures** — the attacker closes in and draws its sword; the defender raises its own in guard. The blades **clash** (sparks, flash, camera shake), the defender's sword is **knocked flying**, and the attacker's blade sweeps through: the victim is duplicated and split with per-material **clipping planes**, the top half tumbling away with gravity while the bottom tips over.
- **chess.js** — full rule correctness (castling, en passant, promotion, threefold repetition, 50-move, stalemate…), on both client and server.
- **Bot engine** — real **Stockfish** (single-file asm.js build) running in a Web Worker, one skill/depth/time profile per difficulty level; the UI never stutters. If the Stockfish worker can't load, the game silently falls back to a built-in negamax engine with quiescence search.
- **Server** — zero-dependency Node `http` server: static files + room-code multiplayer API with server-side move validation, heartbeats, rematch and idle-room cleanup.
- **Sound** — all effects synthesized live with WebAudio (no audio files).

## Project layout

```
server.js               Node server (static + /api rooms)
public/
  index.html            UI shell (menu, HUD, modals)
  style.css             dark & gold theme
  js/
    scene.js            Three.js scene, pieces, animations, sword duels
    game.js             game logic, modes, HUD, online sync
    engine.js           fallback bot engine (negamax + quiescence)
    audio.js            WebAudio sound effects
  vendor/               three.min.js, chess.min.js, stockfish.js
screenshots/            captured in-game shots
```

## Deploying

### Render (recommended — free tier works)

The repo ships with a [`render.yaml`](render.yaml) blueprint, so deployment is nearly one click:

1. Push this repo to your GitHub.
2. Go to [render.com](https://render.com) → **New → Blueprint**, and pick the repo.
3. It creates a free **Web Service** (`npm start` → `node server.js`, health check on `/`). No build step, no environment variables needed.
4. Your app goes live at `https://<your-service>.onrender.com` — share the link, and room codes work anywhere.

Manual alternative: **New → Web Service** → connect the repo → Runtime **Node** → Build Command `npm install` → Start Command `npm start`.

Notes:

- Choose **Web Service**, *not* Static Site — the room-code multiplayer needs the server API.
- Free-tier services spin down after ~15 minutes without traffic; the next request then takes ~30–60 s to wake. Rooms live in memory, so a spin-down or redeploy clears active rooms — normal play generates polling traffic and keeps the service awake.
- **Keep-awake ping:** a `GET /health` endpoint returns `{ok:true, uptime, rooms, ts}` — point an uptime monitor at it to prevent spin-down. On [cronjob.org](https://cronjob.org) (free), create a job with URL `https://<your-service>.onrender.com/health` running **every 10 minutes** (safe margin under the 15-min sleep window), execution time 5 min, and it will never sleep.
- The server reads `process.env.PORT` (local fallback `3000`), so it also runs as-is on Railway, Fly.io, Heroku-style dynos, or any container.

### Anywhere else

```bash
npm start        # or: node server.js  → http://localhost:3000
```
