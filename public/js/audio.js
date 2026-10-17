/* ============================================================
   Blade Chess 3D — synthesized sound effects (WebAudio)
   No audio assets needed: everything is generated on the fly.
   ============================================================ */
const SFX = (() => {
  'use strict';

  let ctx = null, master = null, noiseBuf = null;
  let enabled = (localStorage.getItem('bc3d_sound') ?? '1') === '1';

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      const len = ctx.sampleRate;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ type = 'sine', f0 = 440, f1, t = 0.2, a = 0.005, v = 0.3, delay = 0 }) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + t);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + t);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + t + 0.05);
  }

  function noise({ t = 0.2, f = 1200, f1, q = 1, v = 0.3, delay = 0, type = 'bandpass' }) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    const fl = c.createBiquadFilter();
    fl.type = type;
    fl.frequency.setValueAtTime(f, t0);
    if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t0 + t);
    fl.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + t);
    s.connect(fl); fl.connect(g); g.connect(master);
    s.start(t0); s.stop(t0 + t + 0.05);
  }

  return {
    unlock() { ac(); },
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      localStorage.setItem('bc3d_sound', on ? '1' : '0');
      if (on) ac();
    },
    tick()      { tone({ type: 'sine', f0: 880, t: 0.05, v: 0.07 }); },
    draw()      { noise({ t: 0.12, f: 2200, f1: 5600, v: 0.10, q: 3 }); tone({ type: 'triangle', f0: 1250, f1: 2500, t: 0.09, v: 0.06 }); },
    clash()     { tone({ type: 'triangle', f0: 1450, f1: 980, t: 0.13, v: 0.16 }); tone({ type: 'triangle', f0: 2160, f1: 1900, t: 0.09, v: 0.09 }); noise({ t: 0.06, f: 6500, v: 0.08, type: 'highpass' }); },
    move()      { tone({ type: 'sine', f0: 175, f1: 120, t: 0.09, v: 0.25 }); noise({ t: 0.06, f: 900, v: 0.07, type: 'lowpass' }); },
    castle()    { this.move(); tone({ type: 'sine', f0: 150, f1: 110, t: 0.09, v: 0.2, delay: 0.13 }); },
    whoosh()    { noise({ t: 0.17, f: 420, f1: 3400, v: 0.22, q: 2.2 }); },
    clang() {
      tone({ type: 'triangle', f0: 627, f1: 592, t: 0.30, v: 0.20 });
      tone({ type: 'triangle', f0: 941, f1: 905, t: 0.22, v: 0.11 });
      noise({ t: 0.10, f: 5200, v: 0.09, type: 'highpass' });
      tone({ type: 'sine', f0: 145, f1: 88, t: 0.17, v: 0.28 });
    },
    crack()     { noise({ t: 0.13, f: 850, f1: 280, v: 0.22, q: 1 }); },
    capture()   { this.whoosh(); this.clang(); this.crack(); },
    check()     { tone({ type: 'triangle', f0: 220, t: 0.32, v: 0.20 }); tone({ type: 'triangle', f0: 277, t: 0.36, v: 0.16, delay: 0.13 }); },
    promote()   { [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', f0: f, t: 0.18, v: 0.14, delay: i * 0.07 })); },
    win()       { [392, 494, 587, 784, 988].forEach((f, i) => tone({ type: 'triangle', f0: f, t: 0.36, v: 0.17, delay: i * 0.11 })); noise({ t: 0.6, f: 6000, v: 0.035, type: 'highpass', delay: 0.35 }); },
    lose()      { [392, 330, 262, 196].forEach((f, i) => tone({ type: 'triangle', f0: f, t: 0.42, v: 0.16, delay: i * 0.17 })); },
    draw()      { tone({ type: 'triangle', f0: 392, t: 0.3, v: 0.15 }); tone({ type: 'triangle', f0: 392, t: 0.3, v: 0.12, delay: 0.2 }); },
    join()      { tone({ type: 'sine', f0: 523, t: 0.12, v: 0.14 }); tone({ type: 'sine', f0: 784, t: 0.18, v: 0.14, delay: 0.1 }); }
  };
})();
