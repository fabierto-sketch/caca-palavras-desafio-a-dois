/* ==========================================================================
   Sons discretos (ficheiros curtos) e música ambiente gerada no navegador.
   Tudo opcional e com volume próprio; as preferências ficam neste navegador.
   ========================================================================== */
(function () {
  'use strict';

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('cp_' + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('cp_' + k, JSON.stringify(v));
      } catch {
        /* armazenamento indisponível: fica só nesta sessão */
      }
    },
  };

  const FILES = {
    found: 'correct', wrong: 'wrong', click: 'click', pop: 'pop', chime: 'chime', win: 'win', fanfare: 'fanfare',
    tick: 'tick', timeup: 'timeup', join: 'join', chat: 'chat', send: 'send', ring: 'ring', notify: 'notify', reveal: 'reveal', whoosh: 'whoosh',
  };

  const prefs = {
    sfx: store.get('sfx', true),
    volume: store.get('volume', 0.7),
    music: store.get('music', false),
    musicVolume: store.get('musicVolume', 0.35),
  };
  const cache = {};

  function play(name, { volume = 1, rate = 1 } = {}) {
    if (!prefs.sfx || !FILES[name]) return;
    try {
      let base = cache[name];
      if (!base) {
        base = new Audio(`sounds/${FILES[name]}.wav`);
        base.preload = 'auto';
        cache[name] = base;
      }
      const a = base.cloneNode();
      a.volume = Math.max(0, Math.min(1, prefs.volume * volume));
      a.playbackRate = rate;
      a.play().catch(() => {});
    } catch {
      /* sem som neste navegador */
    }
  }

  /* ---------------- Música ambiente: acordes suaves em loop ---------------- */
  let ctx = null;
  let master = null;
  let timer = null;
  let step = 0;
  // progressão calma (Ré maior / Si menor / Sol / Lá), em Hz
  const CHORDS = [
    [146.83, 220.0, 293.66, 369.99],
    [123.47, 246.94, 293.66, 369.99],
    [98.0, 196.0, 293.66, 392.0],
    [110.0, 220.0, 277.18, 329.63],
  ];
  const MELODY = [587.33, 659.25, 739.99, 880.0, 739.99, 659.25, 587.33, 493.88];

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    master.connect(filter).connect(ctx.destination);
    return ctx;
  }

  function note(freq, start, dur, gain, type = 'sine') {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = (Math.random() - 0.5) * 8;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + Math.min(1.2, dur * 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(master);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  function bar() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.05;
    const chord = CHORDS[step % CHORDS.length];
    chord.forEach((f, i) => note(f, t + i * 0.04, 4.6, i === 0 ? 0.07 : 0.035, i === 0 ? 'triangle' : 'sine'));
    // pequena melodia tipo caixa de música, nem sempre
    if (step % 2 === 0) {
      for (let i = 0; i < 3; i++) {
        const f = MELODY[(step * 3 + i * 2) % MELODY.length];
        note(f, t + 0.6 + i * 1.1, 1.4, 0.018, 'sine');
      }
    }
    step++;
  }

  function startMusic() {
    if (!ensureCtx()) return;
    ctx.resume().catch(() => {});
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.linearRampToValueAtTime(prefs.musicVolume * 0.9, ctx.currentTime + 2);
    if (!timer) {
      bar();
      timer = setInterval(bar, 4000);
    }
  }
  function stopMusic() {
    if (!ctx) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
    clearInterval(timer);
    timer = null;
  }

  function set(key, value) {
    prefs[key] = value;
    store.set(key, value);
    if (key === 'music') value ? startMusic() : stopMusic();
    if (key === 'musicVolume' && ctx && prefs.music) master.gain.linearRampToValueAtTime(value * 0.9, ctx.currentTime + 0.3);
  }

  // o navegador só deixa tocar depois de um gesto do utilizador
  function unlock() {
    if (prefs.music) startMusic();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  window.Sound = { play, prefs, set, store };
})();
