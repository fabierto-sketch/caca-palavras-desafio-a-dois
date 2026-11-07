/* ==========================================================================
   Caça-Palavras Online – Desafio a Dois — aplicação do jogador.
   O navegador só mostra: a grelha, a lista de palavras e o que cada jogador
   pode ver. Validação, pontuação e vencedores são decididos no servidor.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.Charts.esc;
  const store = window.Sound.store;
  const sound = window.Sound;

  const DIR = { E: [0, 1], W: [0, -1], S: [1, 0], N: [-1, 0], SE: [1, 1], NE: [-1, 1], SW: [1, -1], NW: [-1, -1] };
  const HINT_ICONS = { letter: '🔤', direction: '🧭', zone: '🔍', text: '💬', reveal: '✨' };
  const HINT_DESC = {
    letter: 'Mostra onde começa a palavra.',
    direction: 'Diz em que direção está escrita.',
    zone: 'Ilumina, por uns segundos, a zona da grelha.',
    text: 'Uma pequena indicação por escrito.',
    reveal: 'Mostra a palavra inteira (não conta como encontrada por ti).',
  };
  const EMOJIS = '😀 😂 😍 🥰 😘 😉 😎 🤔 😅 😮 😱 🥳 😏 🙈 🙌 👏 💪 👀 🔥 ✨ ⭐ 🎉 🏆 ❤️ 💙 💛 💚 🇵🇹 🇧🇷 🌊 ☀️ 🌙'.split(' ');

  const S = {
    socket: null,
    info: null,
    state: null,
    seat: null,
    code: null,
    token: null,
    joined: false,
    screen: 'home',
    chat: [],
    chatOpen: false,
    lastMatchId: null,
    lastPhase: null,
    clock: null,
    lastTick: -1,
    pendingZone: null,
    hintWord: null,
    video: null,
  };
  window.CP = S; // útil para depuração

  /* ===================================================================== */
  /* Utilitários                                                            */
  /* ===================================================================== */
  function pid() {
    let p = store.get('pid', null);
    if (!p || !/^[A-Za-z0-9_-]{16,64}$/.test(p)) {
      const a = new Uint8Array(18);
      crypto.getRandomValues(a);
      p = btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      store.set('pid', p);
    }
    return p;
  }
  const tokens = () => store.get('tokens', {});
  function saveToken(code, token, name) {
    const t = tokens();
    t[code] = { token, name, at: Date.now() };
    const keep = Object.entries(t).sort((a, b) => b[1].at - a[1].at).slice(0, 8);
    store.set('tokens', Object.fromEntries(keep));
  }
  function dropToken(code) {
    const t = tokens();
    delete t[code];
    store.set('tokens', t);
  }

  function toast(text, { bad = false, good = false, duration = 3200 } = {}) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}${good ? ' good' : ''}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, duration);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }

  function emitAck(event, payload = {}, timeout = 10000) {
    return new Promise((resolve) => {
      if (!S.socket || !S.socket.connected) return resolve({ ok: false, error: 'OFFLINE', message: 'Sem ligação ao servidor. A tentar novamente…' });
      let done = false;
      const t = setTimeout(() => {
        if (!done) resolve({ ok: false, error: 'TIMEOUT', message: 'O servidor demorou a responder. Tenta outra vez.' });
        done = true;
      }, timeout);
      S.socket.emit(event, payload, (res) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(res || { ok: false });
      });
    });
  }

  function openModal(sel) {
    const m = typeof sel === 'string' ? $(sel) : sel;
    m.hidden = false;
    const f = m.querySelector('input, select, button:not(.modal-x)');
    if (f) setTimeout(() => f.focus(), 60);
  }
  function closeModal(sel) {
    const m = typeof sel === 'string' ? $(sel) : sel;
    if (m) m.hidden = true;
  }
  document.addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]');
    if (x) closeModal(x.closest('.modal'));
    else if (e.target.classList && e.target.classList.contains('modal') && e.target.id !== 'modal-name' && e.target.id !== 'modal-call') closeModal(e.target);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.modal').filter((m) => !m.hidden && m.id !== 'modal-name' && m.id !== 'modal-call');
    if (open.length) closeModal(open[open.length - 1]);
  });

  function confirmDialog(title, text, yes = 'Confirmar') {
    return new Promise((resolve) => {
      $('#confirm-title').textContent = title;
      $('#confirm-text').textContent = text;
      $('#confirm-yes').textContent = yes;
      openModal('#modal-confirm');
      const finish = (v) => {
        closeModal('#modal-confirm');
        $('#confirm-yes').onclick = null;
        $('#confirm-no').onclick = null;
        resolve(v);
      };
      $('#confirm-yes').onclick = () => finish(true);
      $('#confirm-no').onclick = () => finish(false);
    });
  }

  const fmtTime = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  const fmtDate = (t) => new Date(t).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const pick = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '');
  const other = (s) => (s === 'X' ? 'O' : 'X');
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const nameOf = (seat) => (S.state && S.state.seats[seat] ? S.state.seats[seat].name : seat === S.seat ? 'Tu' : 'O teu par');
  const setting = (k, d) => (S.info && S.info.settings && S.info.settings[k] !== undefined ? S.info.settings[k] : d);
  const isHost = () => S.state && S.state.host === S.seat;

  function avatar(seat, name, online) {
    const cls = seat ? seat.toLowerCase() : 'none';
    return `<span class="avatar ${cls}">${esc(initial(name))}${online === undefined ? '' : `<i class="st${online ? ' on' : ''}"></i>`}</span>`;
  }

  /* ===================================================================== */
  /* Tema, sons e fundo                                                     */
  /* ===================================================================== */
  function applyTheme(t) {
    document.body.dataset.theme = t;
    $('#btn-theme use').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
    document.querySelector('meta[name="theme-color"]').setAttribute('content', t === 'dark' ? '#0d1430' : '#f6efe2');
  }
  applyTheme(store.get('theme', window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('#btn-theme').addEventListener('click', () => {
    const t = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set('theme', t);
    applyTheme(t);
  });
  document.body.dataset.anim = store.get('anim', true) ? 'full' : 'off';

  function syncSoundUi() {
    $('#opt-sfx').checked = sound.prefs.sfx;
    $('#opt-volume').value = Math.round(sound.prefs.volume * 100);
    $('#opt-music').checked = sound.prefs.music;
    $('#opt-music-vol').value = Math.round(sound.prefs.musicVolume * 100);
    $('#opt-anim').checked = document.body.dataset.anim !== 'off';
    $('#btn-music').setAttribute('aria-pressed', String(sound.prefs.music));
    $('#btn-sound use').setAttribute('href', sound.prefs.sfx ? '#i-sound' : '#i-sound-off');
  }
  syncSoundUi();
  $('#btn-sound').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#sound-pop').hidden = !$('#sound-pop').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!$('#sound-pop').hidden && !e.target.closest('#sound-pop') && !e.target.closest('#btn-sound')) $('#sound-pop').hidden = true;
  });
  $('#opt-sfx').addEventListener('change', (e) => {
    sound.set('sfx', e.target.checked);
    syncSoundUi();
    sound.play('click');
  });
  $('#opt-volume').addEventListener('change', (e) => {
    sound.set('volume', Number(e.target.value) / 100);
    sound.play('pop');
  });
  $('#opt-music').addEventListener('change', (e) => {
    sound.set('music', e.target.checked);
    syncSoundUi();
  });
  $('#opt-music-vol').addEventListener('input', (e) => sound.set('musicVolume', Number(e.target.value) / 100));
  $('#opt-anim').addEventListener('change', (e) => {
    store.set('anim', e.target.checked);
    document.body.dataset.anim = e.target.checked ? 'full' : 'off';
  });
  $('#btn-music').addEventListener('click', () => {
    sound.set('music', !sound.prefs.music);
    syncSoundUi();
    toast(sound.prefs.music ? '🎵 Música ambiente ligada' : 'Música ambiente desligada', { duration: 1600 });
  });

  (function backgroundLetters() {
    const box = $('#bg-letters');
    const L = 'AAAEEEIOOUSRMNTLCDPBGVÇÃ';
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      s.textContent = L[Math.floor(Math.random() * L.length)];
      s.style.left = `${Math.random() * 100}%`;
      s.style.top = `${15 + Math.random() * 85}%`;
      s.style.fontSize = `${14 + Math.random() * 30}px`;
      s.style.setProperty('--rot', `${-25 + Math.random() * 50}deg`);
      s.style.setProperty('--op', (0.05 + Math.random() * 0.08).toFixed(2));
      s.style.animationDuration = `${14 + Math.random() * 16}s`;
      s.style.animationDelay = `${-Math.random() * 20}s`;
      box.appendChild(s);
    }
  })();

  /* ===================================================================== */
  /* Ecrãs                                                                  */
  /* ===================================================================== */
  function show(screen) {
    if (S.screen === screen) return;
    S.screen = screen;
    for (const el of $$('.screen')) el.hidden = el.dataset.screen !== screen;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ===================================================================== */
  /* Página inicial                                                         */
  /* ===================================================================== */
  function renderHome() {
    const st = S.info.settings;
    $('#home-dedication').textContent = st.dedication || '';
    $('#home-phrase').textContent = st.specialPhrase || '';
    $('#home-phrase').hidden = !st.specialPhrase;
    $('#home-cats').innerHTML = S.info.categories.map((c) => `<span class="${c.special ? 'special' : ''}">${esc(c.icon || '')} ${esc(c.name)}</span>`).join('');
    const ch = S.info.challenges || [];
    $('#home-challenges-wrap').hidden = !ch.length;
    $('#home-challenges').innerHTML = ch
      .map((c) => `<div class="challenge"><b>${esc(c.name)}</b><p>${esc(c.description || '')}</p><span class="pill ${c.available ? '' : 'soft'}">${c.available ? (c.seconds ? `⏱ ${fmtTime(c.seconds * 1000)}` : 'Disponível') : 'Disponível ao fim de semana'}</span></div>`)
      .join('');
    $('#card-create').hidden = st.playersCanCreateRooms === false;
    $('#create-pass-wrap').hidden = !st.createRoomNeedsPassword;
    $('#create-pass').required = !!st.createRoomNeedsPassword;
    if (st.createRoomNeedsPassword) $('#create-intro').textContent = 'Só quem sabe a palavra-passe cria salas. O teu par entra depois pelo convite, sem palavra-passe.';
    if (st.welcomeMessage) $('.tagline').textContent = st.welcomeMessage;
    const name = store.get('name', '');
    if (name) {
      $('#create-name').value = name;
      $('#join-name').value = name;
    }
    const mine = Object.entries(tokens()).sort((a, b) => b[1].at - a[1].at);
    $('#my-rooms').hidden = !mine.length;
    $('#my-rooms-list').innerHTML = mine.map(([code, v]) => `<button class="chip" data-room="${esc(code)}">🚪 ${esc(code)} <small>como ${esc(v.name || '')}</small></button>`).join('');
  }
  $('#my-rooms-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-room]');
    if (b) join(b.dataset.room, null);
  });

  $('#form-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#create-name').value.trim();
    const msg = $('#create-msg');
    msg.textContent = '';
    if (!name) return (msg.textContent = 'Escreve o teu nome.');
    const btn = e.submitter || $('#form-create button');
    btn.disabled = true;
    try {
      const password = $('#create-pass').value;
      const r = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = await r.json().catch(() => ({}));
      $('#create-pass').value = ''; // a palavra-passe nunca fica guardada no navegador
      if (!r.ok || !data.ok) {
        msg.textContent = data.message || 'Não foi possível criar a sala.';
        return;
      }
      store.set('name', name);
      await join(data.code, name);
    } catch {
      msg.textContent = 'Sem ligação ao servidor.';
    } finally {
      btn.disabled = false;
    }
  });

  let peekTimer = null;
  $('#join-code').addEventListener('input', (e) => {
    const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    e.target.value = v;
    clearTimeout(peekTimer);
    $('#join-peek').hidden = true;
    if (v.length === 6) peekTimer = setTimeout(() => peek(v), 250);
  });
  async function peek(code) {
    const t = tokens()[code];
    const r = await emitAck('room:lookup', { code, token: t && t.token });
    const box = $('#join-peek');
    if (!r.ok) {
      box.hidden = false;
      box.textContent = r.message;
      return r;
    }
    const people = ['X', 'O'].map((s) => r.seats[s]).filter(Boolean);
    box.hidden = false;
    box.innerHTML = r.mySeat
      ? `Já estás nesta sala como <b>${esc(r.seats[r.mySeat].name)}</b>.`
      : r.full
        ? 'Esta sala já tem dois jogadores.'
        : people.length
          ? `Na sala: ${people.map((p) => `<b>${esc(p.name)}</b> ${p.connected ? '🟢' : '⚪'}`).join(' e ')}`
          : 'Sala vazia — vais ser o anfitrião.';
    return r;
  }

  $('#form-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#join-code').value.trim().toUpperCase();
    const name = $('#join-name').value.trim();
    $('#join-msg').textContent = '';
    if (!/^[A-Z0-9]{6}$/.test(code)) return ($('#join-msg').textContent = 'O código tem 6 caracteres.');
    if (!name && !tokens()[code]) return ($('#join-msg').textContent = 'Escreve o teu nome.');
    if (name) store.set('name', name);
    const r = await join(code, name, $('#join-msg'));
    if (r && !r.ok) $('#join-msg').textContent = r.message;
  });

  /* ===================================================================== */
  /* Entrar na sala                                                         */
  /* ===================================================================== */
  async function join(code, name, msgEl) {
    const t = tokens()[code];
    const r = await emitAck('room:join', { code, name: name || (t && t.name) || store.get('name', ''), token: t && t.token, pid: pid() });
    if (!r.ok) {
      if (r.error === 'NAME_REQUIRED') {
        askName(code);
        return { ok: true };
      }
      if (['ROOM_NOT_FOUND', 'ROOM_CLOSED'].includes(r.error)) dropToken(code);
      if (msgEl) msgEl.textContent = r.message;
      else toast(r.message, { bad: true });
      if (S.screen !== 'home') goHome();
      return r;
    }
    S.code = code;
    S.seat = r.seat;
    S.token = r.token;
    S.joined = true;
    saveToken(code, r.token, r.name);
    if (history.replaceState) history.replaceState(null, '', `/?sala=${code}`);
    S.chat = r.chat || [];
    renderChat();
    closeModal('#modal-name');
    onState(r.state);
    setupRoomExtras();
    sound.play('join');
    return r;
  }

  function askName(code) {
    $('#name-room-info').textContent = `Sala ${code}`;
    $('#name-input').value = store.get('name', '');
    $('#name-msg').textContent = '';
    $('#form-name').dataset.code = code;
    openModal('#modal-name');
  }
  $('#form-name').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#name-input').value.trim();
    if (!name) return;
    store.set('name', name);
    const r = await join(e.target.dataset.code, name, $('#name-msg'));
    if (r && !r.ok) $('#name-msg').textContent = r.message;
  });

  function goHome() {
    S.code = null;
    S.seat = null;
    S.state = null;
    S.joined = false;
    S.lastPhase = null;
    if (S.video) S.video.hangup(true);
    if (history.replaceState) history.replaceState(null, '', '/');
    $('#top-room').hidden = true;
    $('#chat-fab').hidden = true;
    $('#chat').hidden = true;
    $('#video-panel').hidden = true;
    renderHome();
    show('home');
  }
  $('#brand-home').addEventListener('click', (e) => {
    if (!S.code) return;
    e.preventDefault();
    toast('Estás numa sala. Usa «Sair da sala» para a deixar.', { duration: 2500 });
  });

  $('#btn-leave').addEventListener('click', async () => {
    if (!(await confirmDialog('Sair da sala?', 'Deixas o teu lugar livre. Para voltar, terás de entrar outra vez com o código.', 'Sair'))) return;
    const code = S.code;
    const r = await emitAck('room:leave');
    if (!r.ok) return toast(r.message, { bad: true });
    dropToken(code);
    goHome();
  });

  /* ===================================================================== */
  /* Estado da sala                                                         */
  /* ===================================================================== */
  function onState(st) {
    const prev = S.state;
    S.state = st;
    renderTop();
    if (st.phase === 'lobby') {
      renderLobby();
      show('lobby');
    } else if (st.phase === 'playing') {
      renderGame(prev);
      show('game');
    } else {
      renderGame(prev);
      renderResults(S.lastPhase === 'playing');
      show('results');
    }
    S.lastPhase = st.phase;
  }

  function renderTop() {
    const st = S.state;
    $('#top-room').hidden = false;
    $('#top-code').textContent = st.code;
    $('#top-presence').innerHTML = ['X', 'O']
      .filter((s) => st.seats[s])
      .map((s) => `<span class="p ${st.seats[s].connected ? 'on' : ''}" title="${esc(st.seats[s].name)} ${st.seats[s].connected ? 'ligado(a)' : 'desligado(a)'}"><i></i><span>${esc(st.seats[s].name)}</span></span>`)
      .join('');
  }

  /* ---------------- Sala de espera ---------------- */
  function renderLobby() {
    const st = S.state;
    const cfg = st.config;
    const host = isHost();
    $('#lobby-code').textContent = st.code;
    $('#lobby-label').textContent = st.label || '';
    $('#lobby-players').innerHTML = ['X', 'O']
      .map((s) => {
        const p = st.seats[s];
        if (!p) return `<div class="player empty">${avatar(null, '?')}<div><div class="nm">À espera do teu par…</div><div class="sub">Envia o convite abaixo</div></div></div>`;
        return `<div class="player">${avatar(s, p.name, p.connected)}<div><div class="nm">${esc(p.name)} ${s === S.seat ? '<span class="you">tu</span>' : ''}</div><div class="sub">${p.connected ? 'Ligado(a)' : 'Desligado(a)'}${st.host === s ? ' · anfitrião' : ''}</div></div>${st.host === s ? '<svg class="ico crown"><use href="#i-crown"/></svg>' : ''}</div>`;
      })
      .join('');
    const link = `${location.origin}/sala/${st.code}`;
    $('#invite-link').value = link;
    $('#lobby-invite').hidden = !!(st.seats.X && st.seats.O);
    $('#btn-share').hidden = !navigator.share;
    $('#btn-pass-host').hidden = !(host && st.seats[other(S.seat)]);
    const s = st.stats || {};
    const nx = nameOf('X');
    const no = nameOf('O');
    $('#room-tally').innerHTML = s.matches
      ? `<div class="tally"><b>${s.matches}</b><span>partidas</span></div><div class="tally"><b>${s.coopWins || 0}</b><span>vitórias juntos</span></div><div class="tally"><b>${(s.wins && s.wins.X) || 0}–${(s.wins && s.wins.O) || 0}</b><span>${esc(initial(nx))} vs ${esc(initial(no))}</span></div>`
      : '';

    const wrap = $('.lobby-config');
    wrap.classList.toggle('readonly', !host);
    $('#cfg-who').textContent = host ? 'Tu escolhes' : `Quem escolhe: ${nameOf(st.host)}`;
    $$('#cfg-mode .mode-opt').forEach((b) => b.classList.toggle('on', b.dataset.mode === cfg.mode));

    const challenges = S.info.challenges || [];
    $('#cfg-challenge-block').hidden = !challenges.length;
    $('#cfg-challenges').innerHTML =
      `<button class="chip ${!cfg.challengeId ? 'on' : ''}" data-ch="">Partida livre</button>` +
      challenges.map((c) => `<button class="chip ${cfg.challengeId === c.id ? 'on' : ''}" data-ch="${esc(c.id)}" ${c.available ? '' : 'disabled'} title="${esc(c.description || '')}">${esc(c.name)} <small>${c.available ? (c.seconds ? fmtTime(c.seconds * 1000) : '') : 'fim de semana'}</small></button>`).join('');
    const ch = challenges.find((c) => c.id === cfg.challengeId);
    $('#cfg-normal').hidden = !!ch;

    const diffs = S.info.difficulties;
    $('#cfg-difficulty').innerHTML = diffs.map((d) => `<button data-diff="${d.id}" class="${cfg.difficulty === d.id ? 'on' : ''}">${esc(d.name)}</button>`).join('');
    const dd = diffs.find((d) => d.id === cfg.difficulty) || diffs[0];
    $('#cfg-diff-desc').textContent = `${dd.description || ''} Pistas: ${dd.maxHints}.`;
    $('#cfg-size').innerHTML = S.info.sizes.map((z) => `<button data-size="${z.size}" class="${cfg.size === z.size ? 'on' : ''}">${z.size}×${z.size}<small>${esc(z.label)}</small></button>`).join('');
    const opts = [['', `Predefinido (${dd.minutes ? `${dd.minutes} min` : 'sem limite'})`], ['0', 'Sem limite de tempo'], ...[1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60].map((m) => [String(m), `${m} min`])];
    $('#cfg-minutes').innerHTML = opts.map(([v, l]) => `<option value="${v}" ${String(cfg.minutes ?? '') === v ? 'selected' : ''}>${l}</option>`).join('');
    $('#cfg-minutes').disabled = !host;
    $('#cfg-category').innerHTML = S.info.categories
      .map((c) => `<button class="cat ${c.special ? 'special' : ''} ${cfg.categoryId === c.id ? 'on' : ''}" data-cat="${esc(c.id)}"><span class="ci">${esc(c.icon || '🔤')}</span><span>${esc(c.name)}<small>${c.special ? esc(c.description || '') : `${c.words} palavras`}</small></span></button>`)
      .join('');

    const both = st.seats.X && st.seats.O;
    const online = both && st.seats.X.connected && st.seats.O.connected;
    $('#btn-start').hidden = !host;
    $('#btn-start').disabled = !online;
    $('#btn-repeat').hidden = !(host && st.canRepeat);
    $('#btn-repeat').disabled = !online;
    $('#start-hint').textContent = !both ? 'O jogo é a dois: envia o convite ao teu par.' : !online ? `À espera que ${nameOf(st.seats.X.connected ? 'O' : 'X')} volte a ligar-se…` : host ? (ch ? `${ch.name}: ${ch.description || ''}` : 'Tudo pronto!') : `À espera que ${nameOf(st.host)} comece a partida…`;
  }

  async function setCfg(patch) {
    if (!isHost()) return;
    sound.play('click', { volume: 0.5 });
    const r = await emitAck('cfg:set', patch);
    if (!r.ok) toast(r.message, { bad: true });
  }
  $('#cfg-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setCfg({ mode: b.dataset.mode });
  });
  $('#cfg-challenges').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ch]');
    if (b && !b.disabled) setCfg({ challengeId: b.dataset.ch || null });
  });
  $('#cfg-difficulty').addEventListener('click', (e) => {
    const b = e.target.closest('[data-diff]');
    if (!b) return;
    const d = S.info.difficulties.find((x) => x.id === b.dataset.diff);
    const patch = { difficulty: b.dataset.diff };
    if (d && d.defaultSize && S.info.sizes.some((z) => z.size === d.defaultSize)) patch.size = d.defaultSize;
    setCfg(patch);
  });
  $('#cfg-size').addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (b) setCfg({ size: Number(b.dataset.size) });
  });
  $('#cfg-minutes').addEventListener('change', (e) => setCfg({ minutes: e.target.value === '' ? null : Number(e.target.value) }));
  $('#cfg-category').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) setCfg({ categoryId: b.dataset.cat });
  });
  $('#btn-copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#invite-link').value);
      toast('Link copiado! Envia-o ao teu par 💌', { good: true });
    } catch {
      $('#invite-link').select();
      toast('Seleciona e copia o link.');
    }
  });
  $('#btn-share').addEventListener('click', () => {
    navigator.share({ title: 'Caça-Palavras a Dois', text: `Vem jogar comigo! Código da sala: ${S.code}`, url: $('#invite-link').value }).catch(() => {});
  });
  $('#btn-pass-host').addEventListener('click', async () => {
    const r = await emitAck('room:host');
    if (!r.ok) toast(r.message, { bad: true });
  });
  async function startGame(repeat) {
    const btns = [$('#btn-start'), $('#btn-repeat'), $('#btn-res-new'), $('#btn-res-repeat')];
    btns.forEach((b) => (b.disabled = true));
    const r = await emitAck('game:start', { repeat: !!repeat }, 20000);
    btns.forEach((b) => (b.disabled = false));
    if (!r.ok) toast(r.message, { bad: true });
  }
  $('#btn-start').addEventListener('click', () => startGame(false));
  $('#btn-repeat').addEventListener('click', () => startGame(true));

  /* ===================================================================== */
  /* Jogo                                                                   */
  /* ===================================================================== */
  const board = window.WordGrid.create($('#board'), {
    onSelect: select,
    onCursor(cur, letter, anchor) {
      $('#board').setAttribute('aria-label', `Linha ${cur.r + 1}, coluna ${cur.c + 1}: ${letter}.${anchor ? ' Início marcado.' : ''}`);
    },
  });

  function markClassFor(w, m) {
    if (!w.cells) return null;
    if (w.found) {
      if (w.found.revealed) return 'sol';
      if (m.mode === 'coop') return w.found.by === 'O' ? 'o' : 'x';
      return S.seat === 'O' ? 'o' : 'x';
    }
    if (m.status === 'finished') {
      if (m.mode === 'versus' && w.foundBy && w.foundBy.length) {
        const f = w.foundBy.find((x) => !x.revealed);
        return f ? (f.seat === 'O' ? 'o' : 'x') : 'sol';
      }
      return 'missed';
    }
    return null;
  }

  function renderGame(prev) {
    const st = S.state;
    const m = st.match;
    if (!m) return;
    const isNew = S.lastMatchId !== m.id;
    if (isNew) {
      S.lastMatchId = m.id;
      board.reset();
      S.lastTick = -1;
    }
    board.setSeatClass(S.seat === 'O' ? 'o' : 'x');
    const playing = m.status === 'playing';
    const host = isHost();

    $('#g-cat').textContent = `${m.category.icon || ''} ${m.category.name}`;
    $('#g-mode').textContent = m.mode === 'coop' ? '🤝 Juntos' : '⚔️ Desafio';
    $('#g-mode').className = `pill ${m.mode === 'coop' ? 'o' : 'x'}`;
    $('#g-diff').textContent = m.challenge ? `${m.challenge.name}${m.challenge.multiplier && m.challenge.multiplier !== 1 ? ` · ×${m.challenge.multiplier}` : ''}` : `${m.difficultyName} · ${m.size}×${m.size}`;

    const pauseMode = setting('pauseMode', 'both');
    $('#btn-pause').hidden = pauseMode === 'off' || (pauseMode === 'host' && !host) || !playing;
    $('#btn-pause span').textContent = m.paused ? 'Retomar' : m.pauseReq === S.seat ? 'Pedido enviado' : 'Pausa';
    $('#btn-pause use').setAttribute('href', m.paused ? '#i-play' : '#i-pause');
    $('#btn-giveup').hidden = !(playing && m.mode === 'versus' && !m.me.done);
    $('#btn-abort').hidden = !(playing && host);

    // pontuações
    const team = m.team;
    const me = m.me;
    const opp = m.opp;
    const oSeat = other(S.seat);
    const scoreOf = (seat) => (seat === S.seat ? me.score : opp.score);
    const left = 'X';
    const right = 'O';
    const sbPlayer = (seat, side) => {
      const p = st.seats[seat];
      const found = m.mode === 'coop' ? team.by[seat] : seat === S.seat ? me.found : opp.found;
      const meta = m.mode === 'coop' ? `${found} palavra${found === 1 ? '' : 's'}` : `${found}/${m.total}${(seat === S.seat ? me.done : opp.done) ? ' · terminou' : ''}`;
      return `<div class="sb-player ${seat.toLowerCase()} ${side}">${avatar(seat, p ? p.name : '?', p ? p.connected : false)}<div><div class="sb-name">${esc(p ? p.name : '—')}${seat === S.seat ? ' <span class="you pill">tu</span>' : ''}</div><div class="sb-meta">${meta}</div></div><div class="sb-score" data-score="${seat}">${scoreOf(seat)}</div></div>`;
    };
    const center = m.mode === 'coop' ? `<div class="sb-center"><div class="sb-team" id="sb-team">${team.score}</div><div class="sb-label">pontos juntos</div></div>` : '<div class="sb-center"><div class="sb-vs">vs</div></div>';
    const prevScores = prev && prev.match && prev.match.id === m.id ? { [S.seat]: prev.match.me.score, [oSeat]: prev.match.opp.score, team: prev.match.team && prev.match.team.score } : null;
    $('#scorebar').innerHTML = sbPlayer(left, 'left') + center + sbPlayer(right, 'right');
    if (prevScores) {
      for (const s of ['X', 'O']) if (prevScores[s] !== scoreOf(s)) bump($(`[data-score="${s}"]`));
      if (m.mode === 'coop' && prevScores.team !== team.score) bump($('#sb-team'));
    }

    // progresso
    const foundTotal = m.mode === 'coop' ? team.found : me.found;
    $('#g-progress').style.width = `${(foundTotal / m.total) * 100}%`;
    $('#g-progress-opp').hidden = m.mode !== 'versus';
    if (m.mode === 'versus') $('#g-progress-opp').style.width = `${(opp.found / m.total) * 100}%`;

    // aviso
    const banner = $('#g-banner');
    banner.className = 'banner';
    banner.hidden = true;
    if (playing && m.pauseReq && m.pauseReq !== S.seat && !m.paused) {
      banner.hidden = false;
      banner.innerHTML = `<span class="grow">⏸️ ${esc(nameOf(m.pauseReq))} pediu uma pausa.</span><button class="btn btn-sm btn-soft" data-pause="accept">Aceitar</button><button class="btn btn-sm btn-ghost" data-pause="decline">Continuar a jogar</button>`;
    } else if (playing && m.pauseReq === S.seat && !m.paused) {
      banner.hidden = false;
      banner.innerHTML = `<span class="grow">⏳ À espera que ${esc(nameOf(oSeat))} aceite a pausa…</span>`;
    } else if (m.category.special && setting('specialGameMessage', '')) {
      banner.hidden = false;
      banner.className = 'banner special';
      banner.textContent = `🇵🇹 ${setting('specialGameMessage', '')} 🇧🇷`;
    }

    // capa (pausa, espera, já terminei)
    const cover = $('#board-cover');
    const oppOnline = st.seats[oSeat] && st.seats[oSeat].connected;
    let coverHtml = null;
    if (playing && m.paused) {
      const canResume = pauseMode !== 'host' || host;
      coverHtml = { t: '⏸️ Em pausa', p: 'As letras ficam escondidas até retomarem. Aproveitem para conversar!', a: canResume ? '<button class="btn btn-primary" data-pause="resume"><svg class="ico"><use href="#i-play"/></svg> Retomar</button>' : '' };
    } else if (playing && !oppOnline) {
      coverHtml = { t: '📡 À espera…', p: `${nameOf(oSeat)} perdeu a ligação. O tempo está parado até voltar.`, a: '' };
    } else if (playing && m.mode === 'versus' && me.done) {
      coverHtml = { t: me.gaveUp ? '🏳️ Terminaste a tua parte' : '🎉 Encontraste todas!', p: `Agora é a vez de ${nameOf(oSeat)}. Os resultados aparecem quando terminar.`, a: '' };
    }
    cover.hidden = !coverHtml;
    if (coverHtml) {
      $('#cover-title').textContent = coverHtml.t;
      $('#cover-text').textContent = coverHtml.p;
      $('#cover-actions').innerHTML = coverHtml.a;
    }
    board.setEnabled(playing && m.running && !(m.mode === 'versus' && me.done));

    // grelha e marcas
    const words = m.words.map((w) => ({ id: w.id, cells: w.cells, markClass: markClassFor(w, m), animate: playing }));
    board.render(m.rows, words);
    const letterHints = [];
    for (const w of m.words) if (!w.found) for (const h of w.hints) if (h.kind === 'letter') letterHints.push({ r: h.data.r, c: h.data.c });
    board.setHighlights(playing ? letterHints : []);
    if (S.pendingZone) {
      const w = m.words.find((x) => x.id === S.pendingZone);
      const z = w && w.hints.find((h) => h.kind === 'zone');
      if (z) board.showZone(z.data);
      S.pendingZone = null;
    }

    // lista de palavras
    const prevFound = new Set(prev && prev.match && prev.match.id === m.id ? prev.match.words.filter((w) => w.found).map((w) => w.id) : m.words.filter((w) => w.found).map((w) => w.id));
    $('#word-list').innerHTML = m.words
      .slice()
      .sort((a, b) => a.secret - b.secret)
      .map((w) => wordItem(w, m, playing && !prevFound.has(w.id) && w.found))
      .join('');
    $('#w-count').textContent = `${foundTotal}/${m.total}`;
    $('#hints-left').textContent = m.hintsLeft;
    $('#btn-hint').disabled = !playing || !m.hintsLeft || !m.running || (m.mode === 'versus' && me.done);
    const r = m.rules;
    $('#wp-foot').textContent = `${m.mode === 'versus' ? 'Cada um tem as suas pistas. ' : 'As pistas são partilhadas. '}${r.wrongPenalty ? `Seleção errada: −${r.wrongPenalty} pts.` : 'Sem penalização por erros.'}`;

    S.clock = { limit: m.timeLimitMs, leftMs: m.leftMs, elapsedMs: m.elapsedMs, running: m.running && playing, at: performance.now() };
    tick();
  }

  function wordItem(w, m, just) {
    const f = w.found;
    let cls = f ? 'found' : '';
    if (f) cls += m.mode === 'coop' ? ` by-${f.by.toLowerCase()}` : ' by-me';
    if (w.secret) cls += ' secret wide';
    else if (w.display && w.display.length > 11) cls += ' wide';
    if (just) cls += ' just';
    if (m.status === 'finished' && !f && !(w.foundBy && w.foundBy.length)) cls += ' missed';
    const who = f && m.mode === 'coop' ? `<span class="who ${f.by.toLowerCase()}" title="Encontrada por ${esc(nameOf(f.by))}"></span>` : '';
    const label = w.display ? esc(w.display) : `✦ Palavra secreta · ${w.len} letras`;
    const tags = [];
    let clue = w.secret && w.clue && !w.display ? w.clue : '';
    for (const h of w.hints) {
      if (h.kind === 'direction') tags.push(h.data.arrow);
      if (h.kind === 'letter') tags.push(`${h.data.letter}…`);
      if (h.kind === 'text') clue = clue ? `${clue} · ${h.data.text}` : h.data.text;
    }
    if (clue) cls += ' wide';
    const vsFound = m.status === 'finished' && m.mode === 'versus' && w.foundBy && w.foundBy.length ? w.foundBy.map((x) => `<span class="who ${x.seat.toLowerCase()}" title="${esc(nameOf(x.seat))}"></span>`).join('') : '';
    const tip = f ? `Encontrada${m.mode === 'coop' ? ` por ${nameOf(f.by)}` : ''} aos ${fmtTime(f.ms)}${f.revealed ? ' (revelada)' : ''}` : 'Toca para pedir uma pista';
    return `<li class="${cls}" data-word="${esc(w.id)}" title="${esc(tip)}">${who}${vsFound}<span class="wd">${label}${clue ? `<span class="clue">${esc(clue)}</span>` : ''}</span>${tags.length ? `<span class="hint-tag">${esc(tags.join(' '))}</span>` : ''}</li>`;
  }

  function bump(el) {
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  function floatMsg(text, cls = '', big = false) {
    if (!text) return;
    const el = document.createElement('div');
    el.className = `float-msg ${cls}${big ? ' big' : ''}`;
    el.textContent = text;
    $('#float-msgs').appendChild(el);
    setTimeout(() => el.remove(), 2900);
    while ($('#float-msgs').children.length > (innerWidth < 560 ? 1 : 3)) $('#float-msgs').firstChild.remove();
  }

  async function select(sel) {
    const r = await emitAck('game:select', sel);
    const m = S.state && S.state.match;
    if (!r.ok) {
      if (r.error !== 'RATE_LIMITED' || Math.random() < 0.3) toast(r.message, { bad: true, duration: 2000 });
      return 'error';
    }
    if (r.result === 'found') {
      sound.play('found');
      board.flash();
      if (m && m.mode === 'versus') floatMsg(`+${r.points}`, S.seat.toLowerCase());
      if (navigator.vibrate) navigator.vibrate(30);
      return 'found';
    }
    if (r.result === 'already') {
      toast('Essa palavra já foi encontrada.', { duration: 1800 });
      return 'already';
    }
    sound.play('wrong', { volume: 0.5 });
    if (r.penalty) floatMsg(`−${r.penalty}`, '', false);
    return 'wrong';
  }

  /* ---------------- relógio ---------------- */
  function tick() {
    const c = S.clock;
    if (!c || !S.state || S.state.phase !== 'playing') return;
    const dt = c.running ? performance.now() - c.at : 0;
    const el = $('#g-timer');
    if (c.limit) {
      const left = Math.max(0, c.leftMs - dt);
      $('#g-time').textContent = fmtTime(Math.ceil(left / 1000) * 1000);
      const low = left <= setting('lowTimeSeconds', 30) * 1000;
      el.classList.toggle('low', low && c.running);
      const sec = Math.ceil(left / 1000);
      if (c.running && low && sec !== S.lastTick && sec <= 10 && sec > 0) sound.play('tick', { volume: 0.6 });
      if (c.running && low && S.lastTick > 0 && sec !== S.lastTick && sec === Math.floor(setting('lowTimeSeconds', 30))) toast('⏰ O tempo está a acabar!', { duration: 1800 });
      S.lastTick = sec;
    } else {
      $('#g-time').textContent = fmtTime(c.elapsedMs + dt);
      el.classList.remove('low');
    }
    el.classList.toggle('paused', !c.running);
  }
  setInterval(tick, 250);

  /* ---------------- ações do jogo ---------------- */
  async function pauseAction(action) {
    const r = await emitAck('game:pause', { action });
    if (!r.ok) toast(r.message, { bad: true });
    else if (action === 'request' && r.pending) toast('Pedido de pausa enviado.', { duration: 1800 });
  }
  $('#btn-pause').addEventListener('click', () => {
    const m = S.state.match;
    if (m.paused) pauseAction('resume');
    else if (m.pauseReq && m.pauseReq !== S.seat) pauseAction('accept');
    else if (m.pauseReq !== S.seat) pauseAction('request');
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pause]');
    if (b) pauseAction(b.dataset.pause);
  });
  $('#btn-giveup').addEventListener('click', async () => {
    if (!(await confirmDialog('Terminar a tua parte?', 'As palavras que ainda não encontraste deixam de contar para ti. O teu par pode continuar até ao fim.', 'Terminar'))) return;
    const r = await emitAck('game:giveup');
    if (!r.ok) toast(r.message, { bad: true });
  });
  $('#btn-abort').addEventListener('click', async () => {
    if (!(await confirmDialog('Interromper a partida?', 'A partida fica registada como interrompida e voltam à sala de espera.', 'Interromper'))) return;
    const r = await emitAck('game:lobby');
    if (!r.ok) toast(r.message, { bad: true });
  });

  /* ---------------- pistas ---------------- */
  function openHint(wordId) {
    const m = S.state.match;
    if (!m || m.status !== 'playing') return;
    const pending = m.words.filter((w) => !w.found);
    if (!pending.length) return;
    if (!m.hintsLeft) return toast('Já não há pistas nesta partida.', { duration: 2000 });
    S.hintWord = wordId && pending.some((w) => w.id === wordId) ? wordId : pending[0].id;
    $('#hint-word').innerHTML = pending.map((w) => `<option value="${esc(w.id)}" ${w.id === S.hintWord ? 'selected' : ''}>${w.display ? esc(w.display) : `Palavra secreta (${w.len} letras)`}</option>`).join('');
    $('#hint-info').textContent = `${m.hintsLeft} pista${m.hintsLeft === 1 ? '' : 's'} disponível${m.hintsLeft === 1 ? '' : 'eis'}${m.mode === 'coop' ? ' (partilhadas pelos dois)' : ' só para ti'}. Cada pista custa pontos.`;
    $('#hint-msg').textContent = '';
    renderHintKinds();
    openModal('#modal-hint');
  }
  function renderHintKinds() {
    const m = S.state.match;
    const w = m.words.find((x) => x.id === S.hintWord);
    const used = new Set(w ? w.hints.map((h) => h.kind) : []);
    const kinds = ['letter', 'direction', 'zone', 'text'].concat(m.rules.allowReveal ? ['reveal'] : []);
    $('#hint-kinds').innerHTML = kinds
      .map((k) => `<button class="hint-kind" data-kind="${k}" ${used.has(k) ? 'disabled' : ''}><span class="hk-ico">${HINT_ICONS[k]}</span><span><b>${esc((S.info.hintNames || {})[k] || k)}</b><small>${used.has(k) ? 'Já usada nesta palavra.' : HINT_DESC[k]}</small></span><span class="cost">−${m.rules.costs[k] || 0}</span></button>`)
      .join('');
  }
  $('#hint-word').addEventListener('change', (e) => {
    S.hintWord = e.target.value;
    renderHintKinds();
  });
  $('#hint-kinds').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b || b.disabled) return;
    $$('#hint-kinds button').forEach((x) => (x.disabled = true));
    const r = await emitAck('game:hint', { wordId: S.hintWord, kind: b.dataset.kind });
    if (!r.ok) {
      $('#hint-msg').textContent = r.message;
      renderHintKinds();
      return;
    }
    closeModal('#modal-hint');
    sound.play('reveal', { volume: 0.7 });
    const h = r.hint;
    if (h.kind === 'zone') board.showZone(h.data);
    if (h.kind === 'direction') toast(`🧭 Direção: ${h.data.name} ${h.data.arrow}`, { duration: 4000 });
    if (h.kind === 'letter') toast(`🔤 A palavra começa no «${h.data.letter}» assinalado.`, { duration: 3500 });
    if (h.kind === 'text') toast(`💬 ${h.data.text}`, { duration: 5000 });
  });
  $('#btn-hint').addEventListener('click', () => openHint());
  $('#word-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-word]');
    if (li && !li.classList.contains('found')) openHint(li.dataset.word);
  });

  /* ---------------- acontecimentos ---------------- */
  function fill(text, name) {
    return String(text || '').replace(/\{nome\}/g, name || '');
  }
  function onGameEvents({ events }) {
    const m = S.state && S.state.match;
    for (const e of events) {
      switch (e.type) {
        case 'start':
          sound.play('chime');
          floatMsg(e.mode === 'coop' ? 'Boa sorte aos dois! 🍀' : 'Que vença o melhor! ⚔️', '', true);
          break;
        case 'found':
          if (e.secret) floatMsg(fill(pick(setting('msgSecret', [])), e.byName), (e.by || '').toLowerCase(), true);
          else if (m && m.mode === 'coop') {
            if (e.by !== S.seat) {
              sound.play('pop');
              floatMsg(`${e.byName} encontrou ${e.display}!`, (e.by || '').toLowerCase());
            } else floatMsg(pick(setting('msgFound', [])), (e.by || '').toLowerCase());
          }
          break;
        case 'opp-found':
          sound.play('pop', { volume: 0.5 });
          floatMsg(e.secret ? fill(pick(setting('msgSecret', [])), e.byName) : `${e.byName} encontrou uma palavra (+${e.points})`, (e.by || '').toLowerCase());
          break;
        case 'almost':
          floatMsg(pick(setting('msgAlmost', [])), '', true);
          break;
        case 'lead':
          floatMsg(fill(pick(setting('msgLead', [])), nameOf(e.seat)), e.seat.toLowerCase());
          { const el = $(`[data-score="${e.seat}"]`); if (el) el.classList.add('lead-glow'); }
          break;
        case 'player-done':
          if (e.seat !== S.seat) toast(`🏁 ${nameOf(e.seat)} já encontrou todas as palavras!`, { duration: 3000 });
          break;
        case 'hint':
          if (e.by !== S.seat) {
            toast(`💡 ${e.byName} pediu uma pista: ${(S.info.hintNames || {})[e.kind] || e.kind}`, { duration: 2600 });
            if (e.kind === 'zone') {
              const w = m && m.words.find((x) => x.id === e.wordId);
              const z = w && w.hints.find((h) => h.kind === 'zone');
              if (z) board.showZone(z.data);
              else S.pendingZone = e.wordId;
            }
          }
          break;
        case 'opp-hint':
          toast(`💡 ${e.byName} usou uma pista.`, { duration: 2000 });
          break;
        case 'timeout':
          sound.play('timeup');
          break;
        default:
          break;
      }
    }
  }

  function onRoomEvent(e) {
    switch (e.type) {
      case 'joined':
        sound.play('join');
        toast(`👋 ${e.name} entrou na sala!`, { good: true });
        break;
      case 'reconnected':
        toast(`${e.name} voltou 🟢`, { duration: 2000 });
        break;
      case 'disconnected':
        toast(`${e.name} perdeu a ligação…`, { duration: 2500 });
        break;
      case 'left':
        toast(`${e.name} saiu da sala.`);
        break;
      case 'pause-request':
        sound.play('notify');
        break;
      case 'clear-request':
        sound.play('notify');
        confirmDialog('Apagar o histórico?', `${e.name} quer apagar o histórico de partidas desta sala. Concordas?`, 'Apagar').then(async (yes) => {
          const r = await emitAck('history:clear-answer', { accept: yes });
          if (!r.ok) toast(r.message, { bad: true });
        });
        break;
      case 'clear-declined':
        toast(`${e.name} preferiu manter o histórico.`);
        break;
      default:
        break;
    }
  }

  /* ===================================================================== */
  /* Resultados                                                             */
  /* ===================================================================== */
  function renderResults(justFinished) {
    const st = S.state;
    const m = st.match;
    const res = m.result || {};
    const host = isHost();
    const nX = nameOf('X');
    const nO = nameOf('O');
    let emblem;
    let title;
    let sub;
    let celebrate = false;
    const special = m.category.special;
    if (res.mode === 'coop') {
      celebrate = res.complete;
      emblem = res.complete ? '🏆' : res.reason === 'abandoned' ? '🚪' : '⏳';
      title = res.complete ? (special ? setting('specialVictory', 'Conseguiram!') : 'Conseguiram! Encontraram todas!') : res.reason === 'abandoned' ? 'Partida interrompida' : 'O tempo acabou!';
      sub = `Encontraram ${res.found} de ${res.total} palavras em ${fmtTime(res.elapsedMs)}.${res.bonus ? ` Bónus: +${res.bonus}.` : ''}`;
      $('#res-scores').innerHTML = `<div class="res-score x">${avatar('X', nX)}<b>${res.contributions ? res.contributions.X : 0}</b><span class="muted small">${esc(nX)}</span></div><div class="res-score team"><span class="muted small">Pontuação conjunta</span><b data-count="${res.teamScore}">0</b></div><div class="res-score o">${avatar('O', nO)}<b>${res.contributions ? res.contributions.O : 0}</b><span class="muted small">${esc(nO)}</span></div>`;
    } else {
      const w = res.winner;
      celebrate = w === S.seat || w === 'draw';
      emblem = res.reason === 'abandoned' ? '🚪' : w === 'draw' ? '🤝' : w === S.seat ? '👑' : '🌟';
      title = res.reason === 'abandoned' ? 'Partida interrompida' : w === 'draw' ? 'Empate! Que equilíbrio!' : w === S.seat ? 'Ganhaste! 🎉' : `${nameOf(w)} ganhou!`;
      sub = w === 'draw' ? 'Os dois com a mesma pontuação.' : `Diferença de ${res.diff} ponto${res.diff === 1 ? '' : 's'}.${res.first ? ` ${nameOf(res.first)} terminou primeiro.` : ''}`;
      const box = (seat) => `<div class="res-score ${seat.toLowerCase()} ${w === seat ? 'win' : ''}">${w === seat ? '<svg class="ico crown-ico"><use href="#i-crown"/></svg>' : '<span class="crown-ico">&nbsp;</span>'}${avatar(seat, nameOf(seat))}<b data-count="${res.scores ? res.scores[seat] : 0}">0</b><span class="muted small">${esc(nameOf(seat))}</span></div>`;
      $('#res-scores').innerHTML = box('X') + box('O');
    }
    $('#res-emblem').textContent = emblem;
    $('#res-title').textContent = title;
    $('#res-sub').textContent = sub;

    const p = res.players || {};
    const row = (label, fn) => `<tr><th>${label}</th><td>${fn('X')}</td><td>${fn('O')}</td></tr>`;
    const acc = (s) => (p[s] && p[s].accuracy !== null && p[s].accuracy !== undefined ? `${p[s].accuracy}%` : '—');
    let rows = row('Palavras encontradas', (s) => (p[s] ? p[s].found : 0));
    rows += row('Seleções certas / erradas', (s) => (p[s] ? `${p[s].correct} / ${p[s].wrong}` : '—'));
    rows += row('Precisão da seleção', acc);
    rows += row('Pistas usadas', (s) => (p[s] ? p[s].hints : 0));
    if (res.mode === 'versus') {
      rows += row('Tempo usado', (s) => (p[s] ? fmtTime(p[s].timeMs) : '—'));
      rows += row('Bónus (conclusão, rapidez, 1.º)', (s) => (p[s] && p[s].bonus ? `+${p[s].bonus}` : '0'));
      rows += row('Pontuação final', (s) => `<b>${res.scores ? res.scores[s] : 0}</b>`);
    } else {
      rows += row('Pontos (palavras − pistas − erros)', (s) => (res.contributions ? res.contributions[s] : 0));
    }
    $('#res-table').innerHTML = `<thead><tr><th></th><th class="x-name" style="color:var(--x)">${esc(nX)}</th><th style="color:var(--o)">${esc(nO)}</th></tr></thead><tbody>${rows}</tbody>`;

    const sp = $('#res-special');
    sp.hidden = !special;
    if (special) sp.innerHTML = `${esc(res.mode === 'coop' && res.complete ? setting('specialGameMessage', '') : setting('specialVictory', ''))}<small>${esc(setting('specialSignature', ''))}</small>`;
    $('#res-closing').textContent = setting('closingMessage', '');

    $('#btn-res-new').hidden = !host;
    $('#btn-res-repeat').hidden = !host;
    $('#res-wait').hidden = host;
    $('#res-wait').textContent = `${nameOf(st.host)} pode começar uma nova partida.`;

    // contagem animada dos pontos
    for (const el of $$('[data-count]', $('#res-scores'))) countUp(el, Number(el.dataset.count), justFinished ? 1200 : 0);

    if (justFinished) {
      sound.play(celebrate ? 'fanfare' : 'chime');
      if (celebrate) confetti();
    }
  }

  function countUp(el, to, ms) {
    if (!ms || document.body.dataset.anim === 'off') {
      el.textContent = to;
      return;
    }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function confetti() {
    if (document.body.dataset.anim === 'off' || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const cv = $('#confetti');
    const ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr;
    cv.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.body);
    const colors = ['--x', '--o', '--gold', '--coral', '--verde'].map((v) => css.getPropertyValue(v).trim() || '#e04b74');
    const parts = Array.from({ length: 160 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 200,
      y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 14 - 4,
      s: 5 + Math.random() * 7,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      c: colors[Math.floor(Math.random() * colors.length)],
      heart: Math.random() < 0.18,
    }));
    const t0 = performance.now();
    const frame = (t) => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.32;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        if (p.heart) {
          ctx.font = `${p.s * 2}px serif`;
          ctx.fillText('❤', -p.s, p.s);
        } else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      }
      if (t - t0 < 4200) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    };
    requestAnimationFrame(frame);
  }

  $('#btn-res-new').addEventListener('click', () => startGame(false));
  $('#btn-res-repeat').addEventListener('click', () => startGame(true));
  $('#btn-res-lobby').addEventListener('click', async () => {
    const r = await emitAck('game:lobby');
    if (!r.ok) toast(r.message, { bad: true });
  });
  $('#btn-review').addEventListener('click', () => {
    const m = S.state.match;
    openReview({ title: `${m.category.icon || ''} ${m.category.name}`, sub: `${m.mode === 'coop' ? 'A jogar juntos' : 'Desafio'} · ${m.difficultyName} · ${m.size}×${m.size}`, rows: m.rows, words: m.words, mode: m.mode, live: true });
  });
  $('#btn-res-stats').addEventListener('click', () => openStats('room'));

  /* ---------------- rever uma grelha ---------------- */
  let reviewBoard = null;
  function openReview({ title, sub, rows, words, mode, live }) {
    $('#review-title').textContent = title;
    $('#review-sub').textContent = sub;
    openModal('#modal-review');
    if (!reviewBoard) reviewBoard = window.WordGrid.create($('#review-board'), { interactive: false });
    reviewBoard.reset();
    const marks = words.map((w) => {
      let cells = w.cells;
      if (!cells && w.dir && DIR[w.dir]) cells = Array.from({ length: w.len }, (_, i) => [w.r + DIR[w.dir][0] * i, w.c + DIR[w.dir][1] * i]);
      let cls = live ? 'missed' : 'sol';
      if (live) cls = markClassFor({ ...w, cells }, { mode, status: 'finished' }) || 'missed';
      else if (w.foundBy) cls = w.foundBy === 'O' ? 'o' : w.foundBy === 'X' ? 'x' : 'sol';
      return { id: w.id, cells, markClass: cls };
    });
    requestAnimationFrame(() => reviewBoard.render(rows, marks));
    $('#review-words').innerHTML = words.map((w) => `<li class="${w.secret ? 'secret' : ''}"><span class="wd">${esc(w.display || '')}${w.secret && w.hint ? `<span class="clue">${esc(w.hint)}</span>` : ''}</span></li>`).join('');
  }

  /* ===================================================================== */
  /* Estatísticas                                                           */
  /* ===================================================================== */
  let statsData = null;
  let statsTab = 'room';
  async function openStats(tab) {
    statsTab = S.code ? tab || 'room' : 'ranking';
    $$('#stats-tabs .tab').forEach((b) => (b.hidden = !S.code && b.dataset.tab !== 'ranking'));
    openModal('#modal-stats');
    statsData = null;
    if (S.code) {
      $('#stats-body').innerHTML = '<p class="muted">A carregar…</p>';
      const r = await emitAck('history:get');
      if (r.ok) statsData = r;
    }
    renderStats();
  }
  $('#btn-stats').addEventListener('click', () => openStats());
  $('#btn-records-home').addEventListener('click', () => openStats('ranking'));
  $('#stats-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    statsTab = b.dataset.tab;
    renderStats();
  });

  function statBlock(s, who) {
    const winsLabel = who === 'mine' ? `<div class="stat"><b>${s.winsIndividual}</b><span>vitórias individuais</span></div><div class="stat"><b>${s.losses}</b><span>derrotas</span></div>` : '';
    return `<div class="stat-grid">
      <div class="stat"><b>${s.matches}</b><span>partidas</span></div>
      <div class="stat"><b>${s.coopWins}</b><span>vitórias juntos (de ${s.coop})</span></div>
      ${winsLabel}
      <div class="stat"><b>${s.draws}</b><span>empates</span></div>
      <div class="stat"><b>${s.totalScore}</b><span>pontos no total</span></div>
      <div class="stat"><b>${s.bestScore}</b><span>melhor pontuação</span></div>
      <div class="stat"><b>${s.bestTimeMs !== null ? fmtTime(s.bestTimeMs) : '—'}</b><span>melhor tempo (juntos)</span></div>
      <div class="stat"><b>${s.wordsFound}</b><span>palavras encontradas</span></div>
      <div class="stat"><b>${s.accuracy !== null ? `${s.accuracy}%` : '—'}</b><span>precisão</span></div>
      <div class="stat"><b>${s.hints}</b><span>pistas usadas</span></div>
    </div>`;
  }

  function charts(s, roomStats) {
    const W = window.Charts;
    const diffNames = Object.fromEntries((S.info.difficulties || []).map((d) => [d.id, d.name]));
    let ringHtml = '';
    if (roomStats) {
      ringHtml = `<div class="chart-card"><h4>Desafios ganhos</h4>${W.ring([
        { label: nameOf('X'), value: (roomStats.wins && roomStats.wins.X) || 0, color: 'var(--x)' },
        { label: nameOf('O'), value: (roomStats.wins && roomStats.wins.O) || 0, color: 'var(--o)' },
        { label: 'Empates', value: roomStats.draws || 0, color: 'var(--gold)' },
      ])}</div>`;
    }
    return `<div class="chart-row">
      <div class="chart-card"><h4>Categorias favoritas</h4>${W.bars(Object.entries(s.categories).map(([label, value]) => ({ label, value })), { color: 'var(--azul)' })}</div>
      <div class="chart-card"><h4>Dificuldade</h4>${W.bars(Object.entries(s.difficulties).map(([k, value]) => ({ label: diffNames[k] || k, value })), { color: 'var(--coral)' })}</div>
      <div class="chart-card"><h4>Evolução da pontuação</h4>${W.line(s.timeline.map((t) => ({ value: t.score, label: fmtDate(t.at), color: t.mode === 'coop' ? 'var(--o)' : 'var(--x)' })))}</div>
      ${ringHtml}
    </div>`;
  }

  async function renderStats() {
    $$('#stats-tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === statsTab));
    const body = $('#stats-body');
    if (statsTab === 'ranking') return renderRanking('coop');
    if (!statsData) {
      body.innerHTML = '<p class="muted">Não foi possível carregar as estatísticas.</p>';
      return;
    }
    if (statsTab === 'room') {
      const s = statsData.room;
      body.innerHTML = s.matches
        ? `${statBlock(s, 'room')}${charts(s, statsData.stats)}${statsData.canClear ? '<p class="small" style="margin-top:18px"><button class="link-btn" id="btn-clear-hist"><svg class="ico"><use href="#i-trash"/></svg> Pedir para apagar o histórico da sala</button></p>' : ''}`
        : '<p class="muted">Ainda não terminaram nenhuma partida nesta sala. A primeira fica já registada! ✨</p>';
      const c = $('#btn-clear-hist');
      if (c)
        c.onclick = async () => {
          if (!(await confirmDialog('Apagar o histórico?', 'O teu par tem de concordar. As partidas e estatísticas desta sala são apagadas.', 'Pedir'))) return;
          const r = await emitAck('history:clear-request');
          toast(r.ok ? 'Pedido enviado ao teu par.' : r.message, { bad: !r.ok });
        };
    } else if (statsTab === 'mine') {
      const s = statsData.mine;
      body.innerHTML = s && s.matches
        ? `<p class="muted small">Todas as tuas partidas neste navegador, em qualquer sala.</p>${statBlock(s, 'mine')}${charts(s)}${Object.keys(s.opponents).length ? `<div class="chart-card" style="margin-top:14px"><h4>Adversários e parceiros</h4>${window.Charts.bars(Object.entries(s.opponents).map(([label, value]) => ({ label, value })), { color: 'var(--o)' })}</div>` : ''}`
        : '<p class="muted">Ainda não tens partidas terminadas neste navegador.</p>';
    } else if (statsTab === 'matches') {
      const list = statsData.room.recent || [];
      body.innerHTML = list.length
        ? `<div style="overflow-x:auto"><table class="list-table"><thead><tr><th>Quando</th><th>Modo</th><th>Categoria</th><th>Grelha</th><th>Resultado</th><th>Tempo</th></tr></thead><tbody>${list
            .map((m) => {
              const result = m.mode === 'coop' ? `${m.scores.team ?? 0} pts · ${m.status === 'complete' ? '✅ completa' : `${m.found.X + m.found.O}/${m.total}`}` : `${esc(m.names.X)} ${m.scores.X} – ${m.scores.O} ${esc(m.names.O)}${m.winner === 'draw' ? ' (empate)' : ''}`;
              return `<tr class="click" data-match="${esc(m.id)}"><td>${fmtDate(m.finishedAt)}</td><td>${m.mode === 'coop' ? '🤝' : '⚔️'}</td><td>${esc(m.category)}${m.challenge ? ` · ${esc(m.challenge)}` : ''}</td><td>${m.size}×${m.size}</td><td>${result}</td><td>${fmtTime(m.elapsedMs)}</td></tr>`;
            })
            .join('')}</tbody></table></div><p class="muted small">Toca numa partida para rever a grelha.</p>`
        : '<p class="muted">Ainda sem partidas.</p>';
    }
  }
  $('#stats-body').addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-match]');
    if (tr) {
      const r = await emitAck('history:match', { id: tr.dataset.match });
      if (!r.ok) return toast(r.message, { bad: true });
      const m = r.match;
      const res = m.result || {};
      const sub = m.mode === 'coop' ? `A jogar juntos · ${m.scores.team ?? 0} pontos · ${fmtTime(m.elapsedMs)}` : `Desafio · ${m.names.X} ${m.scores.X} – ${m.scores.O} ${m.names.O}`;
      openReview({ title: `${m.category} · ${fmtDate(m.finishedAt)}`, sub: `${sub}${res.reason === 'timeout' ? ' · tempo esgotado' : ''}`, rows: m.rows, words: m.words, mode: m.mode, live: false });
      return;
    }
    const rb = e.target.closest('[data-rank]');
    if (rb) renderRanking(rb.dataset.rank);
  });

  async function renderRanking(type) {
    const body = $('#stats-body');
    const tabs = [['coop', 'Juntos: pontos'], ['fast', 'Juntos: mais rápidos'], ['versus', 'Desafio: pontos'], ['daily', 'Desafio diário (hoje)']];
    body.innerHTML = `<div class="chips" style="margin-bottom:12px">${tabs.map(([k, l]) => `<button class="chip ${k === type ? 'on' : ''}" data-rank="${k}">${l}</button>`).join('')}</div><p class="muted">A carregar…</p>`;
    try {
      const r = await fetch(`/api/ranking?type=${type}`).then((x) => x.json());
      const rows = r.rows || [];
      const diffNames = Object.fromEntries((S.info.difficulties || []).map((d) => [d.id, d.name]));
      const table = rows.length
        ? `<div style="overflow-x:auto"><table class="list-table"><thead><tr><th>#</th><th>${type === 'versus' ? 'Vencedor' : 'Dupla'}</th><th>Pontos</th><th>Tempo</th><th>Categoria</th><th>Grelha</th><th>Data</th></tr></thead><tbody>${rows
            .map((x, i) => `<tr><td>${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td><td>${type === 'versus' ? `${esc(x.name)} <span class="muted small">vs ${esc(x.opponent)}</span>` : `${esc(x.x_name)} & ${esc(x.o_name)}`}</td><td><b>${x.score}</b></td><td>${fmtTime(x.elapsed_ms)}</td><td>${esc(x.category_name || '')}</td><td>${x.size}×${x.size} · ${esc(diffNames[x.difficulty] || x.difficulty)}</td><td>${fmtDate(x.finished_at)}</td></tr>`)
            .join('')}</tbody></table></div>`
        : '<p class="muted">Ainda não há recordes nesta lista. Sejam os primeiros! 🏆</p>';
      body.lastElementChild.outerHTML = table;
    } catch {
      body.lastElementChild.textContent = 'Não foi possível carregar os recordes.';
    }
  }

  /* ===================================================================== */
  /* Conversa e reações                                                     */
  /* ===================================================================== */
  function renderChat() {
    $('#chat-log').innerHTML = S.chat.map(msgHtml).join('');
    scrollChat();
  }
  function msgHtml(m) {
    if (m.kind === 'system') return `<li class="msg sys">${esc(m.text)}</li>`;
    const mine = m.seat === S.seat;
    const t = new Date(m.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
    return `<li class="msg ${(m.seat || '').toLowerCase()} ${mine ? 'me' : ''}"><span class="who">${esc(m.name)}</span>${esc(m.text)}<span class="t">${t}</span></li>`;
  }
  function scrollChat() {
    const log = $('#chat-log');
    log.scrollTop = log.scrollHeight;
  }
  function setChatOpen(v) {
    S.chatOpen = v;
    $('#chat').hidden = !v;
    if (v) {
      $('#chat-dot').hidden = true;
      scrollChat();
      if (matchMedia('(min-width: 700px)').matches) $('#chat-input').focus();
    }
  }
  $('#chat-fab').addEventListener('click', () => setChatOpen(!S.chatOpen));
  $('#chat-close').addEventListener('click', () => setChatOpen(false));
  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text) return;
    $('#chat-input').value = '';
    $('#emoji-pop').hidden = true;
    const r = await emitAck('chat:send', { text });
    if (!r.ok) {
      toast(r.message, { bad: true });
      $('#chat-input').value = text;
    } else sound.play('send', { volume: 0.5 });
  });
  let lastTyping = 0;
  $('#chat-input').addEventListener('input', () => {
    if (Date.now() - lastTyping > 1500 && S.socket) {
      lastTyping = Date.now();
      S.socket.emit('chat:typing');
    }
  });
  $('#emoji-pop').innerHTML = EMOJIS.map((x) => `<button type="button">${x}</button>`).join('');
  $('#emoji-btn').addEventListener('click', () => ($('#emoji-pop').hidden = !$('#emoji-pop').hidden));
  $('#emoji-pop').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = $('#chat-input');
    i.value += b.textContent;
    i.focus();
  });
  $('#quick').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const r = await emitAck('chat:send', { text: b.textContent });
    if (!r.ok) toast(r.message, { bad: true });
  });
  $('#reactions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-react]');
    if (!b) return;
    const r = await emitAck('react', { kind: b.dataset.react });
    if (!r.ok && r.error !== 'RATE_LIMITED') toast(r.message, { bad: true });
  });
  function flyReaction(r) {
    const el = document.createElement('div');
    el.className = 'react-fly';
    el.style.left = `${10 + Math.random() * 80}%`;
    el.innerHTML = `${esc(r.emoji)}<small style="color:var(--${(r.seat || 'x').toLowerCase()})">${esc(r.name)}</small>`;
    $('#reactions-layer').appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  /* ===================================================================== */
  /* Extras da sala: conversa, vídeo                                        */
  /* ===================================================================== */
  function setupRoomExtras() {
    const chatOn = setting('chatEnabled', true);
    const videoOn = setting('videoEnabled', true);
    const reactOn = setting('reactionsEnabled', true);
    $('#chat-fab').hidden = !(chatOn || videoOn || reactOn);
    $('#chat-form').hidden = !chatOn;
    $('#quick').hidden = !chatOn;
    $('#quick').innerHTML = (setting('quickMessages', []) || []).map((q) => `<button type="button">${esc(q)}</button>`).join('');
    $('#reactions').hidden = !reactOn;
    $('#reactions').innerHTML = Object.entries(S.info.reactions || {}).map(([k, v]) => `<button data-react="${k}" title="${esc(v.label)}">${v.emoji}</button>`).join('');
    $('#btn-video-open').hidden = !videoOn;
    if (videoOn && !S.video && window.CPVideo) {
      S.video = window.CPVideo.initVideo({ socket: S.socket, emitAck, toast, sound, app: S, openModal, closeModal });
    }
  }
  $('#btn-video-open').addEventListener('click', () => {
    $('#video-panel').hidden = !$('#video-panel').hidden;
    $('#video-panel').classList.remove('min');
  });
  $('#vp-min').addEventListener('click', () => $('#video-panel').classList.toggle('min'));
  $('#vp-close').addEventListener('click', () => {
    $('#video-panel').hidden = true;
    if (S.video && S.video.state !== 'idle') toast('A chamada continua. Abre-a de novo no botão 📹 da conversa.', { duration: 3500 });
  });
  (function draggableVideo() {
    const panel = $('#video-panel');
    const bar = $('#vp-bar');
    let d = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      d = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!d || d.id !== e.pointerId) return;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const x = Math.max(4, Math.min(innerWidth - w - 4, e.clientX - d.dx));
      const y = Math.max(4, Math.min(innerHeight - h - 4, e.clientY - d.dy));
      Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto', right: 'auto' });
    });
    bar.addEventListener('pointerup', () => (d = null));
  })();

  /* ===================================================================== */
  /* Ligação                                                                */
  /* ===================================================================== */
  async function boot() {
    const socket = io({ reconnectionDelayMax: 4000 });
    S.socket = socket;
    let firstConnect = true;
    socket.on('connect', async () => {
      $('#conn').hidden = true;
      if (firstConnect) {
        firstConnect = false;
        await start();
      } else if (S.code) {
        const t = tokens()[S.code];
        const r = await emitAck('room:join', { code: S.code, token: t && t.token, pid: pid() });
        if (r.ok) {
          S.chat = r.chat || [];
          renderChat();
          onState(r.state);
          toast('Ligação recuperada 🟢', { duration: 1600 });
        } else {
          toast(r.message, { bad: true });
          goHome();
        }
      }
    });
    socket.on('disconnect', () => {
      $('#conn').hidden = false;
      $('#conn').textContent = 'Ligação perdida — a tentar de novo…';
    });
    socket.on('connect_error', () => {
      $('#conn').hidden = false;
      $('#conn').textContent = 'Sem ligação ao servidor — a tentar de novo…';
    });
    socket.on('room:state', (st) => S.code && st.code === S.code && onState(st));
    socket.on('room:event', onRoomEvent);
    socket.on('game:events', onGameEvents);
    socket.on('chat:message', (m) => {
      S.chat.push(m);
      if (S.chat.length > 300) S.chat.shift();
      $('#chat-log').insertAdjacentHTML('beforeend', msgHtml(m));
      scrollChat();
      $('#typing').hidden = true;
      if (m.kind !== 'system' && m.seat !== S.seat) {
        sound.play('chat', { volume: 0.6 });
        if (!S.chatOpen) {
          $('#chat-dot').hidden = false;
          toast(`💬 ${m.name}: ${m.text.length > 60 ? m.text.slice(0, 60) + '…' : m.text}`, { duration: 2600 });
        }
      }
    });
    let typingTimer = null;
    socket.on('chat:typing', ({ seat }) => {
      $('#typing-name').textContent = `${nameOf(seat)} está a escrever…`;
      $('#typing').hidden = false;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => ($('#typing').hidden = true), 3000);
    });
    socket.on('react', (r) => {
      flyReaction(r);
      if (r.seat !== S.seat) sound.play('pop', { volume: 0.4 });
    });
    socket.on('history:cleared', () => {
      toast('O histórico da sala foi apagado.');
      if (!$('#modal-stats').hidden) openStats(statsTab);
    });
    socket.on('rtc:invite', () => {
      $('#video-panel').hidden = false;
      $('#video-panel').classList.remove('min');
    });
    socket.on('session:replaced', ({ message }) => {
      toast(message, { bad: true, duration: 6000 });
      S.code = null;
      goHome();
    });
    socket.on('room:closed', ({ message }) => {
      toast(message || 'A sala foi encerrada.', { bad: true, duration: 6000 });
      if (S.code) dropToken(S.code);
      goHome();
    });
  }

  async function start() {
    const r = await emitAck('app:info');
    if (!r.ok) {
      toast('Não foi possível carregar o jogo. Recarrega a página.', { bad: true, duration: 8000 });
      return;
    }
    S.info = r;
    renderHome();
    const params = new URLSearchParams(location.search);
    const code = (params.get('sala') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code.length === 6) {
      const t = tokens()[code];
      if (t) {
        await join(code, t.name);
        return;
      }
      $('#join-code').value = code;
      $('#join-intro').textContent = 'Foste convidado(a)! Escreve o teu nome para entrar.';
      $('#card-join').scrollIntoView({ block: 'center' });
      const pk = await peek(code);
      if (pk && pk.ok && pk.mySeat) await join(code, null);
      else setTimeout(() => $('#join-name').focus(), 300);
    }
  }

  boot();
})();
