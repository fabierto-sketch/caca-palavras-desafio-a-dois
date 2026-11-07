'use strict';

/**
 * Salas privadas para dois jogadores.
 *
 * Fases:
 *   lobby     → sala de espera: o anfitrião escolhe modo, dificuldade, categoria, grelha e tempo
 *   playing   → partida a decorrer (tempo contado no servidor; pausa se alguém se desligar)
 *   finished  → resultados; nova partida, repetir a grelha ou voltar à sala de espera
 *
 * O estado da sala (incluindo a partida a meio) é guardado na base de dados
 * após cada alteração, para sobreviver a falhas de ligação e reinícios.
 */

const crypto = require('crypto');
const logger = require('./logger');
const { RateLimiter, cleanText, randomToken, socketIp } = require('./security');
const gen = require('./generator');
const G = require('./game');

const SEATS = ['X', 'O'];
const other = (s) => (s === 'X' ? 'O' : 'X');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 300);
const PID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const IDLE_UNLOAD_MS = 30 * 60_000;

const REACTIONS = {
  heart: { emoji: '❤️', label: 'Coração' },
  clap: { emoji: '👏', label: 'Aplausos' },
  fire: { emoji: '🔥', label: 'Em chamas' },
  laugh: { emoji: '😂', label: 'Gargalhada' },
  eyes: { emoji: '👀', label: 'Estou de olho' },
  think: { emoji: '🤔', label: 'Hum…' },
  wow: { emoji: '😮', label: 'Uau' },
  party: { emoji: '🎉', label: 'Celebrar' },
  kiss: { emoji: '😘', label: 'Beijinho' },
};

const ERRORS = {
  INVALID_CODE: 'Código de sala inválido. O código tem 6 caracteres.',
  ROOM_NOT_FOUND: 'Sala não encontrada. Confirma o código ou o convite.',
  ROOM_CLOSED: 'Esta sala foi encerrada.',
  ROOM_FULL: 'Esta sala já tem dois jogadores. Pede o convite à pessoa certa.',
  NAME_REQUIRED: 'Escreve o teu nome para entrar.',
  NOT_IN_ROOM: 'Não estás nesta sala.',
  NOT_HOST: 'Só o anfitrião da sala pode fazer isso.',
  WAITING_OPPONENT: 'Esperem pelo segundo jogador: o jogo é a dois!',
  OPPONENT_OFFLINE: 'O outro jogador está desligado. Esperem que volte.',
  NOT_PLAYING: 'A partida não está a decorrer.',
  PAUSED: 'A partida está em pausa.',
  WRONG_PHASE: 'Essa ação não está disponível agora.',
  BAD_SELECTION: 'Seleção inválida.',
  ALREADY_DONE: 'Já terminaste a tua parte desta partida.',
  ALREADY_FOUND: 'Essa palavra já foi encontrada.',
  HINT_USED: 'Já usaram essa pista para esta palavra.',
  NO_MORE_HINTS: 'Já não há mais pistas nesta partida.',
  NO_REQUEST: 'Não há nenhum pedido pendente.',
  NOT_FOUND: 'Não encontrado.',
  CATEGORY_NOT_FOUND: 'Categoria indisponível.',
  CHALLENGE_UNAVAILABLE: 'Esse desafio não está disponível agora.',
  GRID_FAILED: 'Não foi possível criar uma grelha com estas opções. Experimenta outra dimensão ou categoria.',
  INVALID_ACTION: 'Ação inválida.',
  INVALID_CONFIG: 'Opções inválidas.',
  DISABLED: 'Esta funcionalidade está desativada.',
  INVALID_MESSAGE: 'Mensagem inválida.',
  RATE_LIMITED: 'Calma! Demasiados pedidos seguidos.',
  NOT_ALLOWED: 'Não tens permissão para isso.',
  SERVER_ERROR: 'Ocorreu um erro inesperado. Tenta novamente.',
};

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const hashKey = (pid) => crypto.createHash('sha256').update(`cacapalavras-player:${pid}`).digest('hex').slice(0, 32);
const json = (v) => JSON.stringify(v);
const parse = (v, d) => {
  if (!v) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};
const newId = () => crypto.randomBytes(9).toString('base64url');
const normalizeCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : '');

function emptyStats() {
  return { matches: 0, coopWins: 0, coopLosses: 0, versus: 0, wins: { X: 0, O: 0 }, draws: 0, words: 0, hints: 0, bestCoop: null, playMs: 0 };
}
function defaultConfig() {
  return { mode: 'coop', difficulty: 'medio', size: 12, categoryId: 'mista', minutes: null, challengeId: null };
}
function freshState() {
  return { host: 'X', config: defaultConfig(), match: null, lastGrid: null, pkeys: {}, clearRequest: null, lastResult: null };
}
function phaseOf(state) {
  if (!state.match) return 'lobby';
  return state.match.status === 'finished' ? 'finished' : 'playing';
}

class RoomManager {
  constructor({ db, settings, words, challenges }) {
    this.db = db;
    this.settings = settings;
    this.words = words;
    this.challenges = challenges;
    this.rooms = new Map();
    this.loading = new Map();
    this.timers = new Map();
    this.io = null;
  }

  attach(io) {
    this.io = io;
  }

  /* ================================================================ */
  /* Persistência                                                      */
  /* ================================================================ */
  async getRoom(code) {
    if (this.rooms.has(code)) return this.rooms.get(code);
    if (this.loading.has(code)) return this.loading.get(code);
    const p = this.loadRoom(code).finally(() => this.loading.delete(code));
    this.loading.set(code, p);
    return p;
  }

  async loadRoom(code) {
    const row = await this.db.one('SELECT * FROM rooms WHERE code = $1', [code]);
    if (!row) return null;
    const players = await this.db.query('SELECT * FROM players WHERE room_code = $1 AND active = 1', [code]);
    const room = {
      code,
      label: row.label || '',
      status: row.status || 'open',
      createdAt: Number(row.created_at),
      lastActivity: Number(row.last_activity),
      state: { ...freshState(), ...parse(row.state, {}) },
      stats: { ...emptyStats(), ...parse(row.stats, {}) },
      seats: { X: null, O: null },
      lock: Promise.resolve(),
      lastReact: { X: 0, O: 0 },
    };
    room.state.config = { ...defaultConfig(), ...room.state.config };
    for (const p of players) room.seats[p.seat] = { tokenHash: p.token_hash, name: p.name, joinedAt: Number(p.joined_at), lastSeen: Number(p.last_seen), connected: false, socketId: null };
    // depois de um reinício ninguém está ligado: o relógio fica parado até os dois voltarem
    if (room.state.match) G.pause(room.state.match);
    this.rooms.set(code, room);
    return room;
  }

  async save(room) {
    room.lastActivity = Date.now();
    await this.db.run('UPDATE rooms SET state = $2, stats = $3, last_activity = $4, status = $5 WHERE code = $1', [room.code, json(room.state), json(room.stats), room.lastActivity, room.status]);
  }

  withLock(room, fn) {
    const run = room.lock.then(fn, fn);
    room.lock = run.catch(() => {});
    return run;
  }

  async systemMessage(room, text) {
    const msg = { id: newId(), seat: null, name: null, text, kind: 'system', at: Date.now() };
    await this.db.run('INSERT INTO chat_messages (id, room_code, seat, name, text, kind, at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [msg.id, room.code, null, null, text, 'system', msg.at]);
    if (this.io) this.io.to(room.code).emit('chat:message', msg);
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const live = SEATS.some((s) => room.seats[s] && room.seats[s].connected);
      if (!live && now - room.lastActivity > IDLE_UNLOAD_MS) {
        clearTimeout(this.timers.get(code));
        this.timers.delete(code);
        this.rooms.delete(code);
      }
    }
  }

  /* ================================================================ */
  /* Salas                                                             */
  /* ================================================================ */
  async createRoom({ label, by = 'admin', config } = {}) {
    const n = await this.db.one("SELECT COUNT(*) AS n FROM rooms WHERE status <> 'closed'");
    if (Number(n.n) >= MAX_ROOMS) {
      const e = new Error('Limite de salas atingido.');
      e.code = 'MAX_ROOMS';
      throw e;
    }
    let code;
    do code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    while (await this.db.one('SELECT code FROM rooms WHERE code = $1', [code]));
    const now = Date.now();
    const clean = cleanText(label || '', 40);
    const state = freshState();
    if (config) state.config = this.cleanConfig({ ...state.config, ...config }) || state.config;
    await this.db.run('INSERT INTO rooms (code, label, created_at, last_activity, status, state, stats) VALUES ($1, $2, $3, $3, $4, $5, $6)', [code, clean, now, 'open', json(state), json(emptyStats())]);
    const c = Number((await this.db.getMeta('rooms_created')) || 0) + 1;
    await this.db.setMeta('rooms_created', c);
    (by === 'admin' ? logger.admin : logger.game)(`Sala ${code} criada${by === 'admin' ? ' no painel' : ' na página inicial'}${clean ? ` (${clean})` : ''}`);
    return { code, label: clean };
  }

  async updateRoom(code, { label, config }) {
    const room = await this.getRoom(code);
    if (!room) return null;
    return this.withLock(room, async () => {
      if (label !== undefined) room.label = cleanText(label, 40);
      if (config) {
        const c = this.cleanConfig({ ...room.state.config, ...config });
        if (c) room.state.config = c;
      }
      await this.db.run('UPDATE rooms SET label = $2 WHERE code = $1', [code, room.label]);
      await this.save(room);
      this.broadcast(room);
      return { ok: true };
    });
  }

  kickAll(room, event, message) {
    if (!this.io) return;
    for (const seat of SEATS) {
      const s = this.socketOf(room, seat);
      if (s) {
        s.emit(event, { message });
        s.leave(room.code);
        s.data.code = null;
        s.data.seat = null;
      }
    }
  }

  async closeRoom(code) {
    const room = await this.getRoom(code);
    if (!room) return false;
    return this.withLock(room, async () => {
      this.kickAll(room, 'room:closed', 'A sala foi encerrada pelo administrador.');
      await this.db.run('UPDATE players SET active = 0 WHERE room_code = $1', [code]);
      room.seats = { X: null, O: null };
      room.status = 'closed';
      if (room.state.match && room.state.match.status === 'playing') await this.endMatch(room, 'abandoned');
      await this.save(room);
      logger.admin(`Sala ${code} encerrada`);
      return true;
    });
  }

  async reopenRoom(code) {
    const room = await this.getRoom(code);
    if (!room) return false;
    room.status = 'open';
    await this.save(room);
    logger.admin(`Sala ${code} reaberta`);
    return true;
  }

  async deleteRoom(code) {
    const exists = await this.db.one('SELECT code FROM rooms WHERE code = $1', [code]);
    if (!exists) return false;
    const room = this.rooms.get(code);
    if (room) this.kickAll(room, 'room:closed', 'A sala foi eliminada.');
    this.rooms.delete(code);
    clearTimeout(this.timers.get(code));
    await this.db.tx(async (q) => {
      for (const t of ['players', 'chat_messages']) await q(`DELETE FROM ${t} WHERE room_code = $1`, [code]);
      await q('DELETE FROM rooms WHERE code = $1', [code]);
    });
    logger.admin(`Sala ${code} eliminada (o histórico de partidas mantém-se)`);
    return true;
  }

  async clearHistory(room) {
    await this.db.tx(async (q) => {
      for (const t of ['chat_messages', 'ws_matches', 'word_log']) await q(`DELETE FROM ${t} WHERE room_code = $1`, [room.code]);
    });
    room.stats = emptyStats();
    room.state.clearRequest = null;
    room.state.lastResult = null;
    await this.save(room);
  }

  async listRooms() {
    const rows = await this.db.query('SELECT code, label, created_at, last_activity, status, state, stats FROM rooms ORDER BY last_activity DESC');
    const players = await this.db.query('SELECT room_code, seat, name, last_seen FROM players WHERE active = 1');
    return rows.map((r) => {
      const live = this.rooms.get(r.code);
      const state = live ? live.state : { ...freshState(), ...parse(r.state, {}) };
      const stats = live ? live.stats : { ...emptyStats(), ...parse(r.stats, {}) };
      const seats = {};
      for (const seat of SEATS) {
        const p = players.find((x) => x.room_code === r.code && x.seat === seat);
        const lp = live && live.seats[seat];
        seats[seat] = p ? { name: p.name, connected: !!(lp && lp.connected), lastSeen: Number(lp ? lp.lastSeen : p.last_seen) } : null;
      }
      const m = state.match;
      return {
        code: r.code,
        label: live ? live.label : r.label,
        status: live ? live.status : r.status,
        createdAt: Number(r.created_at),
        lastActivity: Number(live ? live.lastActivity : r.last_activity),
        phase: phaseOf(state),
        config: state.config,
        current: m ? { mode: m.mode, category: m.category.name, size: m.size, difficulty: m.difficulty, status: m.status, found: m.mode === 'coop' ? Object.keys(m.found).length : `${Object.keys(m.players.X.found).length}/${Object.keys(m.players.O.found).length}`, total: m.words.length, elapsedMs: G.elapsed(m) } : null,
        stats,
        seats,
        inviteUrl: null,
      };
    });
  }

  liveStats() {
    let online = 0;
    let active = 0;
    let playing = 0;
    const rooms = [];
    for (const room of this.rooms.values()) {
      const n = SEATS.filter((s) => room.seats[s] && room.seats[s].connected).length;
      online += n;
      if (!n) continue;
      active++;
      const m = room.state.match;
      if (m && m.status === 'playing') playing++;
      const names = SEATS.filter((s) => room.seats[s] && room.seats[s].connected).map((s) => room.seats[s].name);
      rooms.push({ code: room.code, names: names.join(' e '), what: m && m.status === 'playing' ? `${m.mode === 'coop' ? 'A jogar juntos' : 'Desafio'} · ${m.category.name} · ${m.size}×${m.size}` : 'na sala de espera' });
    }
    return { online, active, playing, rooms };
  }

  /* ================================================================ */
  /* Estado público                                                    */
  /* ================================================================ */
  socketOf(room, seat) {
    const p = room.seats[seat];
    return (p && p.socketId && this.io && this.io.sockets.sockets.get(p.socketId)) || null;
  }
  names(room) {
    return { X: room.seats.X ? room.seats.X.name : 'Jogador 1', O: room.seats.O ? room.seats.O.name : 'Jogador 2' };
  }
  host(room) {
    const h = room.state.host || 'X';
    return room.seats[h] ? h : room.seats[other(h)] ? other(h) : h;
  }
  bothOnline(room) {
    return SEATS.every((s) => room.seats[s] && room.seats[s].connected);
  }
  keys(room) {
    return SEATS.map((s) => (room.state.pkeys || {})[s]).filter(Boolean);
  }

  publicState(room, seat) {
    const s = room.state;
    return {
      code: room.code,
      label: room.label,
      status: room.status,
      seats: Object.fromEntries(SEATS.map((st) => [st, room.seats[st] ? { name: room.seats[st].name, connected: room.seats[st].connected } : null])),
      host: this.host(room),
      phase: phaseOf(s),
      config: s.config,
      canRepeat: !!s.lastGrid,
      match: s.match ? G.view(s.match, seat) : null,
      lastResult: s.lastResult,
      clearRequest: s.clearRequest,
      stats: room.stats,
      serverTime: Date.now(),
    };
  }

  broadcast(room) {
    if (!this.io) return;
    for (const seat of SEATS) {
      const s = this.socketOf(room, seat);
      if (s) s.emit('room:state', this.publicState(room, seat));
    }
  }
  notify(room, event, exceptSeat) {
    for (const seat of SEATS) {
      if (seat === exceptSeat) continue;
      const s = this.socketOf(room, seat);
      if (s) s.emit('room:event', { ...event, at: Date.now() });
    }
  }
  /**
   * Acontecimentos para animações. No desafio, o adversário só fica a saber
   * que «encontrou uma palavra» — nunca qual.
   */
  gameEvents(room, events, by) {
    if (!this.io || !events || !events.length) return;
    const m = room.state.match;
    const names = this.names(room);
    for (const seat of SEATS) {
      const s = this.socketOf(room, seat);
      if (!s) continue;
      const list = events
        .map((e) => {
          const ev = { ...e, byName: e.by ? names[e.by] : e.seat ? names[e.seat] : null };
          if (m && m.mode === 'versus' && e.by && e.by !== seat) {
            if (e.type === 'found') return { type: 'opp-found', by: e.by, byName: ev.byName, points: e.points, secret: e.secret };
            if (e.type === 'hint') return { type: 'opp-hint', by: e.by, byName: ev.byName };
          }
          if (m && m.mode === 'versus' && e.type === 'almost' && e.seat !== seat) return null;
          return ev;
        })
        .filter(Boolean);
      if (list.length) s.emit('game:events', { events: list });
    }
  }

  async context(socket) {
    const { code, seat } = socket.data || {};
    if (!code || !seat) return null;
    const room = await this.getRoom(code);
    return this.validate(room, socket);
  }
  contextSync(socket) {
    const room = socket.data && socket.data.code && this.rooms.get(socket.data.code);
    return room ? this.validate(room, socket) : null;
  }
  validate(room, socket) {
    if (!room) return null;
    const { seat, tokenHash } = socket.data;
    const player = room.seats[seat];
    if (!player || player.tokenHash !== tokenHash || player.socketId !== socket.id) return null;
    return { room, seat, player };
  }

  /* ================================================================ */
  /* Opções e partidas                                                 */
  /* ================================================================ */
  allowedSizes() {
    return [...new Set([...gen.BASE_SIZES.map((x) => x.size), ...(this.settings.get('extraSizes') || [])])].sort((a, b) => a - b);
  }

  cleanConfig(c) {
    const out = {
      mode: c.mode === 'versus' ? 'versus' : 'coop',
      difficulty: gen.DIFFICULTIES[c.difficulty] ? c.difficulty : 'medio',
      size: Number(c.size),
      categoryId: String(c.categoryId || 'mista'),
      minutes: c.minutes === null || c.minutes === undefined || c.minutes === '' ? null : Number(c.minutes),
      challengeId: c.challengeId ? String(c.challengeId) : null,
    };
    if (!this.allowedSizes().includes(out.size)) return null;
    if (out.minutes !== null && !(Number.isInteger(out.minutes) && out.minutes >= 0 && out.minutes <= 120)) return null;
    const cat = this.words.get(out.categoryId);
    if (!cat || !cat.active) return null;
    if (out.challengeId && !this.challenges.get(out.challengeId)) return null;
    return out;
  }

  /** Liga o relógio só quando a partida decorre, não está em pausa e os dois estão ligados. */
  syncClock(room) {
    const m = room.state.match;
    clearTimeout(this.timers.get(room.code));
    this.timers.delete(room.code);
    if (!m || m.status !== 'playing') return;
    if (this.bothOnline(room) && !m.paused) G.resume(m);
    else G.pause(m);
    if (!m.timeLimitMs || !m.resumedAt) return;
    const left = G.timeLeft(m);
    const t = setTimeout(() => {
      this.withLock(room, async () => {
        if (room.state.match !== m || m.status !== 'playing') return;
        if (G.timeLeft(m) <= 0) {
          await this.endMatch(room, 'timeout');
          await this.save(room);
          this.gameEvents(room, [{ type: 'timeout' }], null);
          this.broadcast(room);
        } else this.syncClock(room);
      }).catch((err) => logger.error(`Temporizador da sala ${room.code}: ${err.message}`));
    }, Math.min(left + 40, 2 ** 31 - 1));
    this.timers.set(room.code, t);
  }

  /** Cria uma partida nova (ou repete a última grelha, se os jogadores pedirem). */
  async startMatch(room, { repeat = false } = {}) {
    const cfg = room.state.config;
    const challenge = cfg.challengeId ? this.challenges.get(cfg.challengeId) : null;
    if (challenge && !this.challenges.available(challenge)) return { error: 'CHALLENGE_UNAVAILABLE' };
    let grid;
    let category;
    let timeLimitMs;
    if (repeat) {
      const last = room.state.lastGrid;
      if (!last) return { error: 'WRONG_PHASE' };
      grid = last.grid;
      category = last.category;
      timeLimitMs = last.timeLimitMs;
    } else {
      const size = challenge ? challenge.config.size : cfg.size;
      const difficulty = challenge ? challenge.config.difficulty : cfg.difficulty;
      const fixedSeed = challenge ? this.challenges.fixedSeed(challenge) : null;
      const seed = fixedSeed || gen.newSeed();
      const rng = gen.rngFrom(seed);
      if (challenge) {
        category = this.challenges.categoryFor(challenge);
        if (category.id === 'aleatoria') {
          const pool = this.words.list().filter((x) => x.id !== 'mista' && !x.special && x.words >= 20);
          category = this.words.get(pool[rng.int(pool.length)].id);
        }
      } else category = this.words.get(cfg.categoryId);
      if (!category || category.active === false) return { error: 'CATEGORY_NOT_FOUND' };
      const seen = fixedSeed ? new Map() : await this.words.seenMap(room.code, this.keys(room));
      const candidates = this.words.candidates({ categoryId: category.id, size, difficulty, rng, seen, ignoreSeen: !!fixedSeed });
      try {
        grid = gen.generate({ seed, size, difficulty, words: candidates, count: challenge && challenge.config.words ? challenge.config.words : undefined, avoid: this.words.avoidList(category.id), secretLabel: category.name });
      } catch (err) {
        logger.warn(`Sala ${room.code}: ${err.message} (${category.id}, ${size}, ${difficulty})`);
        return { error: 'GRID_FAILED' };
      }
      const v = gen.verify(grid);
      if (!v.ok) {
        logger.error(`Sala ${room.code}: grelha inválida — ${v.errors.join('; ')}`);
        return { error: 'GRID_FAILED' };
      }
      category = { id: category.id, name: category.name, icon: category.icon, special: !!category.special };
      timeLimitMs = challenge ? challenge.config.seconds * 1000 : (cfg.minutes ?? this.settings.defaultMinutes(difficulty)) * 60_000;
      await this.words.log(room.code, this.keys(room), grid.words.map((w) => w.norm), grid.signature);
    }
    const m = G.newMatch({ grid, mode: cfg.mode, category, challenge, timeLimitMs, settings: this.settings.all(), repeatOf: repeat ? room.state.lastGrid.matchId : null });
    room.state.match = m;
    room.state.lastGrid = { grid, category, timeLimitMs, matchId: m.id };
    this.syncClock(room);
    logger.game(`Sala ${room.code}: partida ${m.mode === 'coop' ? 'a jogar juntos' : 'desafio'} — ${category.name}, ${grid.size}×${grid.size}, ${m.difficulty}${repeat ? ' (repetida)' : ''}`);
    return { ok: true, match: m };
  }

  /** Termina a partida e guarda o resultado. */
  async endMatch(room, reason) {
    const m = room.state.match;
    if (!m || m.status !== 'playing') return null;
    clearTimeout(this.timers.get(room.code));
    const result = G.finish(m, reason);
    const names = this.names(room);
    const keys = room.state.pkeys || {};
    const st = room.stats;
    const abandoned = reason === 'abandoned';
    const winner = m.mode === 'coop' ? (result.complete ? 'team' : 'none') : result.winner;
    await this.db.run(
      `INSERT INTO ws_matches (id, room_code, mode, difficulty, category_id, category_name, size, seed, challenge_id, challenge_name, time_limit_ms, signature,
        words, grid, placements, status, result, winner, x_name, o_name, x_key, o_key, score_x, score_o, score_team, found_x, found_o, total_words, hints, elapsed_ms, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [
        m.id,
        room.code,
        m.mode,
        m.difficulty,
        m.category.id,
        m.category.name,
        m.size,
        m.seed,
        m.challenge ? m.challenge.id : null,
        m.challenge ? m.challenge.name : null,
        m.timeLimitMs,
        m.signature,
        json(m.words.map((w) => ({ id: w.id, display: w.display, norm: w.norm, secret: w.secret }))),
        json(m.rows),
        json(m.words.map((w) => ({ id: w.id, r: w.r, c: w.c, dir: w.dir, len: w.len }))),
        abandoned ? 'abandoned' : m.mode === 'coop' ? (result.complete ? 'complete' : 'timeout') : 'complete',
        json({ ...result, found: m.mode === 'coop' ? m.found : undefined, foundX: m.mode === 'versus' ? m.players.X.found : undefined, foundO: m.mode === 'versus' ? m.players.O.found : undefined }),
        winner,
        names.X,
        names.O,
        keys.X || null,
        keys.O || null,
        m.mode === 'coop' ? m.players.X.score : result.scores.X,
        m.mode === 'coop' ? m.players.O.score : result.scores.O,
        m.mode === 'coop' ? result.teamScore : null,
        result.players.X.found,
        result.players.O.found,
        m.words.length,
        m.players.X.hints + m.players.O.hints,
        m.elapsedMs,
        m.startedAt,
        Date.now(),
      ]
    );
    if (!abandoned) {
      st.matches++;
      st.words += result.players.X.found + result.players.O.found;
      st.hints += m.players.X.hints + m.players.O.hints;
      st.playMs += m.elapsedMs;
      if (m.mode === 'coop') {
        if (result.complete) {
          st.coopWins++;
          if (!st.bestCoop || result.teamScore > st.bestCoop.score) st.bestCoop = { score: result.teamScore, ms: m.elapsedMs, size: m.size, at: Date.now() };
        } else st.coopLosses++;
      } else {
        st.versus++;
        if (result.winner === 'draw') st.draws++;
        else st.wins[result.winner]++;
      }
    }
    room.state.lastResult = { mode: m.mode, category: m.category.name, size: m.size, result, names, at: Date.now() };
    const msg =
      reason === 'abandoned'
        ? 'A partida foi interrompida.'
        : m.mode === 'coop'
          ? result.complete
            ? `🎉 Encontraram todas as palavras! ${result.teamScore} pontos em equipa.`
            : `⏰ O tempo acabou: encontraram ${result.found} de ${result.total} palavras.`
          : result.winner === 'draw'
            ? `🤝 Empate! ${result.scores.X} pontos para cada lado.`
            : `🏆 ${names[result.winner]} venceu o desafio por ${result.diff} pontos!`;
    await this.systemMessage(room, msg);
    logger.game(`Sala ${room.code}: partida terminada (${reason})`);
    return result;
  }

  async touchPlayer(pid, name) {
    const key = hashKey(pid);
    const now = Date.now();
    await this.db.run('INSERT INTO ws_players (player_key, name, created_at, last_seen) VALUES ($1, $2, $3, $3) ON CONFLICT (player_key) DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen', [key, name, now]);
    return key;
  }
}

/* ==================================================================== */
/* Estatísticas (sala e jogador)                                         */
/* ==================================================================== */
function rowToMatch(r) {
  return {
    id: r.id,
    room: r.room_code,
    mode: r.mode,
    difficulty: r.difficulty,
    category: r.category_name,
    categoryId: r.category_id,
    size: Number(r.size),
    challenge: r.challenge_name,
    status: r.status,
    winner: r.winner,
    names: { X: r.x_name, O: r.o_name },
    scores: { X: Number(r.score_x), O: Number(r.score_o), team: r.score_team === null ? null : Number(r.score_team) },
    found: { X: Number(r.found_x), O: Number(r.found_o) },
    total: Number(r.total_words),
    hints: Number(r.hints),
    elapsedMs: Number(r.elapsed_ms),
    finishedAt: Number(r.finished_at),
  };
}

async function statsFor(db, { roomCode, playerKey }) {
  const rows = roomCode
    ? await db.query("SELECT * FROM ws_matches WHERE room_code = $1 AND status <> 'abandoned' ORDER BY finished_at DESC LIMIT 500", [roomCode])
    : await db.query("SELECT * FROM ws_matches WHERE (x_key = $1 OR o_key = $1) AND status <> 'abandoned' ORDER BY finished_at DESC LIMIT 500", [playerKey]);
  const s = { matches: rows.length, coop: 0, coopWins: 0, versus: 0, winsIndividual: 0, draws: 0, losses: 0, totalScore: 0, wordsFound: 0, hints: 0, bestTimeMs: null, bestScore: 0, correct: 0, categories: {}, difficulties: {}, opponents: {}, timeline: [] };
  for (const r of rows) {
    const res = parse(r.result, {});
    const mySeat = playerKey ? (r.x_key === playerKey ? 'X' : 'O') : null;
    s.categories[r.category_name] = (s.categories[r.category_name] || 0) + 1;
    s.difficulties[r.difficulty] = (s.difficulties[r.difficulty] || 0) + 1;
    s.hints += Number(r.hints);
    if (r.mode === 'coop') {
      s.coop++;
      if (r.status === 'complete') {
        s.coopWins++;
        if (s.bestTimeMs === null || Number(r.elapsed_ms) < s.bestTimeMs) s.bestTimeMs = Number(r.elapsed_ms);
      }
      const sc = Number(r.score_team) || 0;
      s.totalScore += sc;
      s.bestScore = Math.max(s.bestScore, sc);
      s.wordsFound += mySeat ? Number(mySeat === 'X' ? r.found_x : r.found_o) : Number(r.found_x) + Number(r.found_o);
    } else {
      s.versus++;
      if (r.winner === 'draw') s.draws++;
      else if (mySeat && r.winner === mySeat) s.winsIndividual++;
      else if (mySeat) s.losses++;
      const sc = mySeat ? Number(mySeat === 'X' ? r.score_x : r.score_o) : Math.max(Number(r.score_x), Number(r.score_o));
      s.totalScore += sc;
      s.bestScore = Math.max(s.bestScore, sc);
      s.wordsFound += mySeat ? Number(mySeat === 'X' ? r.found_x : r.found_o) : Number(r.found_x) + Number(r.found_o);
    }
    const ps = res.players || {};
    for (const seat of mySeat ? [mySeat] : ['X', 'O']) if (ps[seat]) s.correct += ps[seat].correct || 0;
    if (mySeat) {
      const opp = mySeat === 'X' ? r.o_name : r.x_name;
      s.opponents[opp] = (s.opponents[opp] || 0) + 1;
    }
    s.timeline.push({ at: Number(r.finished_at), score: r.mode === 'coop' ? Number(r.score_team) : mySeat ? Number(mySeat === 'X' ? r.score_x : r.score_o) : Math.max(Number(r.score_x), Number(r.score_o)), mode: r.mode });
  }
  let wrong = 0;
  for (const r of rows) {
    const ps = parse(r.result, {}).players || {};
    const mySeat = playerKey ? (r.x_key === playerKey ? 'X' : 'O') : null;
    for (const seat of mySeat ? [mySeat] : ['X', 'O']) if (ps[seat]) wrong += ps[seat].wrong || 0;
  }
  s.accuracy = s.correct + wrong ? Math.round((s.correct / (s.correct + wrong)) * 100) : null;
  s.timeline = s.timeline.reverse().slice(-30);
  s.recent = rows.slice(0, 50).map(rowToMatch);
  return s;
}

/* ==================================================================== */
/* Eventos Socket.IO                                                     */
/* ==================================================================== */
function registerRoomHandlers(io, manager) {
  const { db, settings, words, challenges } = manager;
  const joinLimiter = new RateLimiter({ windowMs: 60_000, max: Number(process.env.JOIN_RATE_MAX || 25) });
  const lookupLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });
  const chatLimiter = new RateLimiter({ windowMs: 10_000, max: 15 });
  const reply = (ack) => (typeof ack === 'function' ? ack : () => {});
  const fail = (ack, error) => ack({ ok: false, error, message: ERRORS[error] || error });

  io.on('connection', (socket) => {
    const ip = socketIp(socket);
    const limiter = new RateLimiter({ windowMs: 5_000, max: Number(process.env.SOCKET_RATE_MAX || 120) });
    const selectLimiter = new RateLimiter({ windowMs: 2_000, max: Number(process.env.SELECT_RATE_MAX || 12) });
    socket.use((packet, next) => {
      if (String(packet[0]).startsWith('rtc:') || limiter.hit(socket.id)) return next();
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack({ ok: false, error: 'RATE_LIMITED', message: ERRORS.RATE_LIMITED });
    });
    socket.on('error', () => {});

    function handle(event, fn, { needCtx = true } = {}) {
      socket.on(event, async (payload, ack) => {
        ack = reply(ack);
        try {
          if (!needCtx) return await fn(payload && typeof payload === 'object' ? payload : {}, ack);
          const ctx = await manager.context(socket);
          if (!ctx) return fail(ack, 'NOT_IN_ROOM');
          await manager.withLock(ctx.room, async () => {
            const fresh = manager.contextSync(socket);
            if (!fresh) return fail(ack, 'NOT_IN_ROOM');
            await fn(payload && typeof payload === 'object' ? payload : {}, ack, fresh);
          });
        } catch (err) {
          logger.error(`Erro em ${event}: ${err.message}`, { error: err.stack });
          fail(ack, 'SERVER_ERROR');
        }
      });
    }

    // eventos desconhecidos são recusados (as salas criam-se pela página inicial ou pelo painel, por HTTP)
    socket.onAny((event, ...args) => {
      if (socket.listeners(event).length) return;
      const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (/creat|criar|admin|score|ponto/i.test(event)) logger.warn(`Evento recusado por Socket.IO («${String(event).slice(0, 40)}») [${ip}]`);
      if (ack) ack({ ok: false, error: 'NOT_ALLOWED', message: ERRORS.NOT_ALLOWED });
    });

    socket.on('net:ping', (_p, ack) => reply(ack)({ t: Date.now() }));

    socket.on('app:info', (_p, ack) => {
      reply(ack)({
        ok: true,
        settings: settings.public(),
        categories: words.list(),
        challenges: challenges.publicList(),
        difficulties: Object.values(gen.DIFFICULTIES).map((d) => ({ id: d.id, name: d.name, description: d.description, sizes: d.sizes, defaultSize: d.defaultSize, minutes: settings.defaultMinutes(d.id), maxHints: settings.maxHints(d.id) })),
        sizes: manager.allowedSizes().map((n) => ({ size: n, label: (gen.BASE_SIZES.find((b) => b.size === n) || {}).label || 'Personalizada' })),
        reactions: settings.get('reactionsEnabled') ? REACTIONS : {},
        hintNames: G.HINT_NAMES,
      });
    });

    handle(
      'room:lookup',
      async (p, ack) => {
        if (!lookupLimiter.hit(ip)) return fail(ack, 'RATE_LIMITED');
        const code = normalizeCode(p.code);
        if (!CODE_REGEX.test(code)) return fail(ack, 'INVALID_CODE');
        const room = await manager.getRoom(code);
        if (!room) return fail(ack, 'ROOM_NOT_FOUND');
        if (room.status === 'closed') return fail(ack, 'ROOM_CLOSED');
        const tokenHash = typeof p.token === 'string' && p.token.length <= 64 ? hashToken(p.token) : null;
        const mySeat = tokenHash ? SEATS.find((s) => room.seats[s] && room.seats[s].tokenHash === tokenHash) || null : null;
        ack({ ok: true, code, label: room.label, seats: Object.fromEntries(SEATS.map((s) => [s, room.seats[s] ? { name: room.seats[s].name, connected: room.seats[s].connected } : null])), mySeat, full: !mySeat && !!room.seats.X && !!room.seats.O });
      },
      { needCtx: false }
    );

    handle(
      'room:join',
      async (p, ack) => {
        if (!joinLimiter.hit(ip)) return fail(ack, 'RATE_LIMITED');
        const code = normalizeCode(p.code);
        if (!CODE_REGEX.test(code)) return fail(ack, 'INVALID_CODE');
        const room = await manager.getRoom(code);
        if (!room) return fail(ack, 'ROOM_NOT_FOUND');
        await manager.withLock(room, async () => {
          if (room.status === 'closed') return fail(ack, 'ROOM_CLOSED');
          if (socket.data.code && socket.data.code !== code) socket.leave(socket.data.code);
          const token = typeof p.token === 'string' && p.token.length <= 64 ? p.token : null;
          const tokenHash = token ? hashToken(token) : null;
          let seat = tokenHash ? SEATS.find((s) => room.seats[s] && room.seats[s].tokenHash === tokenHash) : null;
          let newToken = null;
          const reconnected = !!seat;
          const now = Date.now();
          if (seat) {
            const player = room.seats[seat];
            if (player.socketId && player.socketId !== socket.id) {
              const old = io.sockets.sockets.get(player.socketId);
              if (old) {
                old.emit('session:replaced', { message: 'Abriste esta sala noutra janela ou dispositivo.' });
                old.leave(code);
                old.data.code = null;
                old.data.seat = null;
              }
            }
            const name = cleanText(p.name, 20);
            if (name) player.name = name;
          } else {
            const name = cleanText(p.name, 20);
            if (!name) return fail(ack, 'NAME_REQUIRED');
            seat = SEATS.find((s) => !room.seats[s]);
            if (!seat) {
              logger.warn(`Sala ${code}: entrada recusada (sala cheia) para ${name} [${ip}]`);
              return fail(ack, 'ROOM_FULL');
            }
            newToken = randomToken(24);
            room.seats[seat] = { tokenHash: hashToken(newToken), name, joinedAt: now, lastSeen: now, connected: false, socketId: null };
            await db.run('INSERT INTO players (token_hash, room_code, seat, name, joined_at, last_seen, active) VALUES ($1, $2, $3, $4, $5, $5, 1)', [room.seats[seat].tokenHash, code, seat, name, now]);
            if (!room.seats[other(seat)]) room.state.host = seat; // o primeiro a entrar é o anfitrião
            logger.game(`Sala ${code}: ${name} entrou como ${seat}`);
          }
          const player = room.seats[seat];
          if (typeof p.pid === 'string' && PID_RE.test(p.pid)) room.state.pkeys = { ...(room.state.pkeys || {}), [seat]: await manager.touchPlayer(p.pid, player.name) };
          player.socketId = socket.id;
          player.connected = true;
          player.lastSeen = now;
          await db.run('UPDATE players SET name = $2, last_seen = $3 WHERE token_hash = $1', [player.tokenHash, player.name, now]);
          Object.assign(socket.data, { code, seat, tokenHash: player.tokenHash });
          socket.join(code);
          const chat = await db.query('SELECT id, seat, name, text, kind, at FROM chat_messages WHERE room_code = $1 ORDER BY at DESC LIMIT 100', [code]);
          manager.syncClock(room);
          ack({ ok: true, token: newToken || token, seat, name: player.name, state: manager.publicState(room, seat), chat: chat.reverse().map((m) => ({ ...m, at: Number(m.at) })) });
          manager.notify(room, { type: reconnected ? 'reconnected' : 'joined', seat, name: player.name }, seat);
          if (!reconnected) await manager.systemMessage(room, `${player.name} entrou na sala.`);
          await manager.save(room);
          manager.broadcast(room);
        });
      },
      { needCtx: false }
    );

    handle('room:leave', async (_p, ack, { room, seat, player }) => {
      room.seats[seat] = null;
      await db.run('UPDATE players SET active = 0 WHERE token_hash = $1', [player.tokenHash]);
      if (room.state.match && room.state.match.status === 'playing') await manager.endMatch(room, 'abandoned');
      if (room.state.pkeys) delete room.state.pkeys[seat];
      if (room.state.host === seat && room.seats[other(seat)]) room.state.host = other(seat);
      room.state.clearRequest = null;
      manager.syncClock(room);
      await manager.save(room);
      socket.leave(room.code);
      socket.data.code = null;
      socket.data.seat = null;
      manager.notify(room, { type: 'left', seat, name: player.name });
      await manager.systemMessage(room, `${player.name} saiu da sala.`);
      manager.broadcast(room);
      ack({ ok: true });
    });

    /* ---------------- Sala de espera ---------------- */
    handle('cfg:set', async (p, ack, { room, seat }) => {
      if (seat !== manager.host(room)) return fail(ack, 'NOT_HOST');
      if (room.state.match && room.state.match.status === 'playing') return fail(ack, 'WRONG_PHASE');
      const c = manager.cleanConfig({ ...room.state.config, ...p });
      if (!c) return fail(ack, 'INVALID_CONFIG');
      room.state.config = c;
      await manager.save(room);
      manager.broadcast(room);
      ack({ ok: true, config: c });
    });

    handle('room:host', async (_p, ack, { room, seat }) => {
      if (seat !== manager.host(room) || !room.seats[other(seat)]) return fail(ack, 'NOT_HOST');
      room.state.host = other(seat);
      await manager.save(room);
      manager.broadcast(room);
      ack({ ok: true });
    });

    /* ---------------- Partida ---------------- */
    handle('game:start', async (p, ack, { room, seat }) => {
      if (seat !== manager.host(room)) return fail(ack, 'NOT_HOST');
      if (!room.seats.X || !room.seats.O) return fail(ack, 'WAITING_OPPONENT');
      if (!manager.bothOnline(room)) return fail(ack, 'OPPONENT_OFFLINE');
      if (room.state.match && room.state.match.status === 'playing') return fail(ack, 'WRONG_PHASE');
      const r = await manager.startMatch(room, { repeat: !!p.repeat });
      if (r.error) return fail(ack, r.error);
      await manager.save(room);
      manager.broadcast(room);
      manager.gameEvents(room, [{ type: 'start', mode: r.match.mode, special: r.match.category.special }], null);
      const m = r.match;
      await manager.systemMessage(room, `${m.mode === 'coop' ? '🤝 A jogar juntos' : '⚔️ Desafio um contra o outro'}: ${m.category.icon || ''} ${m.category.name}, ${m.size}×${m.size}, ${m.words.length} palavras${m.timeLimitMs ? `, ${Math.round(m.timeLimitMs / 1000)} s` : ', sem limite de tempo'}.`);
      ack({ ok: true });
    });

    handle('game:select', async (p, ack, { room, seat }) => {
      if (!selectLimiter.hit(socket.id)) return fail(ack, 'RATE_LIMITED');
      const m = room.state.match;
      if (!m) return fail(ack, 'NOT_PLAYING');
      const r = G.select(m, seat, { r1: p.r1, c1: p.c1, r2: p.r2, c2: p.c2 });
      if (!r.ok) return fail(ack, r.error);
      if (r.end) await manager.endMatch(room, 'all-found');
      if (r.result !== 'already') await manager.save(room);
      manager.broadcast(room);
      if (r.result === 'found') manager.gameEvents(room, r.events, seat);
      if (r.end) manager.gameEvents(room, [{ type: 'end' }], null);
      ack({ ok: true, result: r.result, wordId: r.result === 'found' || r.result === 'already' ? r.wordId : undefined, points: r.points, penalty: r.penalty });
    });

    handle('game:hint', async (p, ack, { room, seat }) => {
      const m = room.state.match;
      if (!m) return fail(ack, 'NOT_PLAYING');
      const r = G.hint(m, seat, { wordId: String(p.wordId || ''), kind: String(p.kind || '') });
      if (!r.ok) return fail(ack, r.error);
      if (r.end) await manager.endMatch(room, 'all-found');
      await manager.save(room);
      manager.broadcast(room);
      manager.gameEvents(room, r.events, seat);
      ack({ ok: true, hint: r.hint });
    });

    handle('game:giveup', async (_p, ack, { room, seat, player }) => {
      const m = room.state.match;
      if (!m) return fail(ack, 'NOT_PLAYING');
      const r = G.giveUp(m, seat);
      if (!r.ok) return fail(ack, r.error);
      if (r.end) await manager.endMatch(room, 'all-done');
      else await manager.systemMessage(room, `${player.name} terminou a sua parte. ${manager.names(room)[other(seat)]} pode continuar.`);
      await manager.save(room);
      manager.broadcast(room);
      if (r.end) manager.gameEvents(room, [{ type: 'end' }], null);
      ack({ ok: true });
    });

    /** Pausa: os dois concordam, ou só o anfitrião (conforme as definições). */
    handle('game:pause', async (p, ack, { room, seat, player }) => {
      const m = room.state.match;
      if (!m || m.status !== 'playing') return fail(ack, 'NOT_PLAYING');
      const mode = settings.get('pauseMode');
      if (mode === 'off') return fail(ack, 'DISABLED');
      const action = String(p.action || '');
      const isHost = seat === manager.host(room);
      if (action === 'request') {
        if (m.paused) return fail(ack, 'WRONG_PHASE');
        if (mode === 'host') {
          if (!isHost) return fail(ack, 'NOT_HOST');
          m.paused = true;
          m.pauseReq = null;
        } else {
          if (m.pauseReq && m.pauseReq !== seat) {
            m.paused = true;
            m.pauseReq = null;
          } else m.pauseReq = seat;
        }
      } else if (action === 'accept') {
        if (!m.pauseReq || m.pauseReq === seat) return fail(ack, 'NO_REQUEST');
        m.paused = true;
        m.pauseReq = null;
      } else if (action === 'decline') {
        if (!m.pauseReq || m.pauseReq === seat) return fail(ack, 'NO_REQUEST');
        m.pauseReq = null;
      } else if (action === 'resume') {
        if (!m.paused) return fail(ack, 'WRONG_PHASE');
        if (mode === 'host' && !isHost) return fail(ack, 'NOT_HOST');
        m.paused = false;
      } else return fail(ack, 'INVALID_ACTION');
      manager.syncClock(room);
      await manager.save(room);
      manager.broadcast(room);
      if (action === 'request' && m.pauseReq) manager.notify(room, { type: 'pause-request', name: player.name }, seat);
      if (m.paused && (action === 'accept' || action === 'request')) await manager.systemMessage(room, '⏸️ Partida em pausa.');
      if (action === 'resume') await manager.systemMessage(room, `▶️ ${player.name} retomou a partida.`);
      ack({ ok: true, paused: m.paused, pending: !!m.pauseReq });
    });

    /** Interromper a partida (anfitrião) ou voltar à sala de espera depois dos resultados. */
    handle('game:lobby', async (_p, ack, { room, seat, player }) => {
      const m = room.state.match;
      if (!m) return fail(ack, 'WRONG_PHASE');
      if (m.status === 'playing') {
        if (seat !== manager.host(room)) return fail(ack, 'NOT_HOST');
        await manager.endMatch(room, 'abandoned');
        await manager.systemMessage(room, `${player.name} interrompeu a partida.`);
      }
      room.state.match = null;
      manager.syncClock(room);
      await manager.save(room);
      manager.broadcast(room);
      ack({ ok: true });
    });

    /* ---------------- Histórico e estatísticas ---------------- */
    handle('history:get', async (_p, ack, { room }) => {
      const roomStats = await statsFor(db, { roomCode: room.code });
      const key = (room.state.pkeys || {})[socket.data.seat];
      const mine = key ? await statsFor(db, { playerKey: key }) : null;
      ack({ ok: true, stats: room.stats, room: roomStats, mine, canClear: settings.get('playersCanClearHistory') });
    });

    handle('history:match', async (p, ack, { room }) => {
      const r = await db.one('SELECT * FROM ws_matches WHERE id = $1 AND room_code = $2', [String(p.id || ''), room.code]);
      if (!r) return fail(ack, 'NOT_FOUND');
      const res = parse(r.result, {});
      ack({ ok: true, match: { ...rowToMatch(r), rows: parse(r.grid, []), words: parse(r.words, []).map((w, i) => ({ ...w, ...parse(r.placements, [])[i] })), result: res, seed: r.seed } });
    });

    handle('history:clear-request', async (_p, ack, { room, seat, player }) => {
      if (!settings.get('playersCanClearHistory')) return fail(ack, 'DISABLED');
      room.state.clearRequest = seat;
      await manager.save(room);
      manager.notify(room, { type: 'clear-request', seat, name: player.name }, seat);
      manager.broadcast(room);
      ack({ ok: true });
    });

    handle('history:clear-answer', async (p, ack, { room, seat, player }) => {
      if (!room.state.clearRequest || room.state.clearRequest === seat) return fail(ack, 'NO_REQUEST');
      if (!p.accept) {
        room.state.clearRequest = null;
        await manager.save(room);
        manager.notify(room, { type: 'clear-declined', name: player.name }, seat);
        manager.broadcast(room);
        return ack({ ok: true, cleared: false });
      }
      await manager.clearHistory(room);
      io.to(room.code).emit('history:cleared');
      await manager.systemMessage(room, 'O histórico da sala foi apagado com o acordo dos dois.');
      manager.broadcast(room);
      ack({ ok: true, cleared: true });
    });

    if (process.env.WS_TEST_HOOKS === '1') {
      // apenas para os testes automáticos: posições das palavras e relógio
      handle('test:solution', async (_p, ack, { room }) => {
        const m = room.state.match;
        if (!m) return fail(ack, 'NOT_FOUND');
        ack({ ok: true, words: m.words.map((w) => ({ id: w.id, r: w.r, c: w.c, dir: w.dir, len: w.len, norm: w.norm })) });
      });
      handle('test:time', async (p, ack, { room }) => {
        const m = room.state.match;
        if (!m || !m.timeLimitMs) return fail(ack, 'NOT_FOUND');
        m.elapsedMs = Math.max(0, m.timeLimitMs - Number(p.leftMs || 0));
        if (m.resumedAt) m.resumedAt = Date.now();
        manager.syncClock(room);
        await manager.save(room);
        manager.broadcast(room);
        ack({ ok: true });
      });
    }

    /* ---------------- Convívio ---------------- */
    handle('react', async (p, ack, { room, seat, player }) => {
      if (!settings.get('reactionsEnabled')) return fail(ack, 'DISABLED');
      const r = REACTIONS[p.kind];
      if (!r) return fail(ack, 'INVALID_MESSAGE');
      const now = Date.now();
      if (now - room.lastReact[seat] < 500) return fail(ack, 'RATE_LIMITED');
      room.lastReact[seat] = now;
      io.to(room.code).emit('react', { kind: p.kind, emoji: r.emoji, label: r.label, seat, name: player.name, at: now });
      ack({ ok: true });
    });

    handle('chat:send', async (p, ack, { room, seat, player }) => {
      if (!settings.get('chatEnabled')) return fail(ack, 'DISABLED');
      if (!chatLimiter.hit(socket.id)) return fail(ack, 'RATE_LIMITED');
      const text = cleanText(p.text, 500);
      if (!text) return fail(ack, 'INVALID_MESSAGE');
      const msg = { id: newId(), seat, name: player.name, text, kind: 'user', at: Date.now() };
      await db.run('INSERT INTO chat_messages (id, room_code, seat, name, text, kind, at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [msg.id, room.code, seat, msg.name, text, 'user', msg.at]);
      io.to(room.code).emit('chat:message', msg);
      ack({ ok: true });
    });

    socket.on('chat:typing', () => {
      const ctx = manager.contextSync(socket);
      const o = ctx && manager.socketOf(ctx.room, other(ctx.seat));
      if (o) o.emit('chat:typing', { seat: ctx.seat });
    });

    socket.on('disconnect', () => {
      const ctx = manager.contextSync(socket);
      if (!ctx) return;
      const { room, seat, player } = ctx;
      player.connected = false;
      player.lastSeen = Date.now();
      manager.notify(room, { type: 'disconnected', seat, name: player.name }, seat);
      manager
        .withLock(room, async () => {
          manager.syncClock(room); // pausa o relógio
          await manager.save(room);
          manager.broadcast(room);
        })
        .catch(() => {});
      db.run('UPDATE players SET last_seen = $2 WHERE token_hash = $1', [player.tokenHash, player.lastSeen]).catch(() => {});
    });
  });
}

module.exports = { RoomManager, registerRoomHandlers, statsFor, rowToMatch, REACTIONS, ERRORS, CODE_REGEX, normalizeCode, emptyStats, hashKey, other };
