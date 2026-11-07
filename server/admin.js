'use strict';

/**
 * API do painel de administração.
 * - Palavra-passe exclusivamente em ADMIN_PASSWORD (nunca no navegador).
 * - Sessões no servidor/base de dados (só o hash do token), cookie HttpOnly + SameSite=Strict.
 * - Todas as rotas (exceto login/sessão) exigem sessão; alterações exigem X-Requested-With.
 */

const express = require('express');
const crypto = require('crypto');
const { randomToken, safeEqual, rateLimitMiddleware, RateLimiter } = require('./security');
const { normalizeCode, CODE_REGEX, statsFor, rowToMatch } = require('./rooms');
const gen = require('./generator');
const { hasTurn } = require('./webrtc');
const logger = require('./logger');

const COOKIE = 'cp_admin';
const TTL = Number(process.env.ADMIN_SESSION_HOURS || 12) * 3_600_000;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function cookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAdminRouter({ db, manager, settings, io, startedAt, words, challenges }) {
  const router = express.Router();
  const failed = new RateLimiter({ windowMs: 15 * 60_000, max: 8 });
  const configured = () => typeof process.env.ADMIN_PASSWORD === 'string' && process.env.ADMIN_PASSWORD.length >= 6;
  if (!configured()) logger.warn('ADMIN_PASSWORD não está definida (mínimo 6 caracteres). A administração está desativada.');
  setInterval(() => db.run('DELETE FROM admin_sessions WHERE expires_at < $1', [Date.now()]).catch(() => {}), 30 * 60_000).unref();

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const setCookie = (req, res, v, ms) =>
    res.setHeader('Set-Cookie', [`${COOKIE}=${v}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(ms / 1000)}`, ...(req.secure ? ['Secure'] : [])].join('; '));

  async function session(req) {
    const token = cookies(req.headers.cookie)[COOKIE];
    if (!token || token.length > 100) return null;
    const row = await db.one('SELECT token_hash, expires_at FROM admin_sessions WHERE token_hash = $1', [hash(token)]);
    return row && Number(row.expires_at) > Date.now() ? { tokenHash: row.token_hash } : null;
  }

  const requireAdmin = wrap(async (req, res, next) => {
    const s = await session(req);
    if (!s) {
      logger.warn(`Acesso administrativo negado: ${req.method} ${req.originalUrl} [${req.ip}]`);
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Acesso reservado ao administrador.' });
    }
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'caca-palavras') return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    req.adminSession = s;
    next();
  });

  const invite = (req, code) => `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/sala/${code}`;
  const roomCode = (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!CODE_REGEX.test(code)) {
      res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND', message: 'Sala não encontrada.' });
      return null;
    }
    return code;
  };
  const notFound = (res) => res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND', message: 'Sala não encontrada.' });

  router.use(express.json({ limit: '8mb' }));
  router.use(rateLimitMiddleware({ windowMs: 60_000, max: 300 }));

  router.get('/session', wrap(async (req, res) => res.json({ ok: true, configured: configured(), authenticated: !!(await session(req)) })));

  router.post(
    '/login',
    wrap(async (req, res) => {
      if (!configured()) return res.status(503).json({ ok: false, error: 'NOT_CONFIGURED', message: 'Defina ADMIN_PASSWORD no servidor.' });
      if (!failed.hit(req.ip)) {
        logger.warn(`Login de administrador bloqueado temporariamente [${req.ip}]`);
        return res.status(429).json({ ok: false, error: 'RATE_LIMITED', message: 'Demasiadas tentativas. Aguarde 15 minutos.' });
      }
      const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
      if (!safeEqual(password, process.env.ADMIN_PASSWORD)) {
        logger.warn(`Tentativa de login de administrador falhada [${req.ip}]`);
        return res.status(401).json({ ok: false, error: 'INVALID_PASSWORD', message: 'Palavra-passe incorreta.' });
      }
      failed.reset(req.ip);
      const token = randomToken(32);
      const now = Date.now();
      await db.run('INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip) VALUES ($1, $2, $3, $4)', [hash(token), now, now + TTL, req.ip]);
      setCookie(req, res, token, TTL);
      logger.admin(`Administrador autenticado [${req.ip}]`);
      res.json({ ok: true });
    })
  );

  router.post(
    '/logout',
    wrap(async (req, res) => {
      const s = await session(req);
      if (s) await db.run('DELETE FROM admin_sessions WHERE token_hash = $1', [s.tokenHash]);
      setCookie(req, res, '', 0);
      res.json({ ok: true });
    })
  );

  router.post(
    '/sessions/logout-all',
    requireAdmin,
    wrap(async (req, res) => {
      const n = await db.run('DELETE FROM admin_sessions');
      setCookie(req, res, '', 0);
      logger.admin(`Todas as sessões de administrador terminadas (${n})`);
      res.json({ ok: true, count: n });
    })
  );

  /* ---------- Salas ---------- */
  router.get(
    '/rooms',
    requireAdmin,
    wrap(async (req, res) => {
      const rooms = await manager.listRooms();
      res.json({ ok: true, rooms: rooms.map((r) => ({ ...r, inviteUrl: invite(req, r.code) })) });
    })
  );

  router.post(
    '/rooms',
    requireAdmin,
    wrap(async (req, res) => {
      try {
        const body = req.body || {};
        const r = await manager.createRoom({ label: body.label, by: 'admin', config: body.config });
        res.status(201).json({ ok: true, room: { ...r, inviteUrl: invite(req, r.code) } });
      } catch (err) {
        if (err.code === 'MAX_ROOMS') return res.status(409).json({ ok: false, error: 'MAX_ROOMS', message: err.message });
        throw err;
      }
    })
  );

  router.put(
    '/rooms/:code',
    requireAdmin,
    wrap(async (req, res) => {
      const code = roomCode(req, res);
      if (!code) return;
      const r = await manager.updateRoom(code, { label: req.body.label, config: req.body.config });
      if (!r) return notFound(res);
      res.json({ ok: true });
    })
  );

  for (const [path, fn, msg] of [
    ['close', 'closeRoom', 'Sala encerrada.'],
    ['reopen', 'reopenRoom', 'Sala reaberta.'],
  ]) {
    router.post(
      `/rooms/:code/${path}`,
      requireAdmin,
      wrap(async (req, res) => {
        const code = roomCode(req, res);
        if (!code) return;
        if (!(await manager[fn](code))) return notFound(res);
        res.json({ ok: true, message: msg });
      })
    );
  }

  router.post(
    '/rooms/:code/clear-history',
    requireAdmin,
    wrap(async (req, res) => {
      const code = roomCode(req, res);
      if (!code) return;
      const room = await manager.getRoom(code);
      if (!room) return notFound(res);
      await manager.withLock(room, () => manager.clearHistory(room));
      manager.broadcast(room);
      logger.admin(`Histórico da sala ${code} apagado`);
      res.json({ ok: true, message: 'Histórico apagado.' });
    })
  );

  router.delete(
    '/rooms/:code',
    requireAdmin,
    wrap(async (req, res) => {
      const code = roomCode(req, res);
      if (!code) return;
      if (!(await manager.deleteRoom(code))) return notFound(res);
      res.json({ ok: true, message: 'Sala eliminada.' });
    })
  );

  /* ---------- Categorias e palavras ---------- */
  router.get('/categories', requireAdmin, (req, res) => res.json({ ok: true, categories: words.adminList() }));

  router.post(
    '/categories',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await words.createCategory(req.body || {});
      if (!r.ok) return res.status(400).json(r);
      if (req.body.words) await words.addWords(r.id, req.body.words);
      res.status(201).json(r);
    })
  );

  router.put(
    '/categories/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await words.updateCategory(req.params.id, req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    })
  );

  router.delete(
    '/categories/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await words.deleteCategory(req.params.id);
      res.status(r.ok ? 200 : 404).json(r);
    })
  );

  router.get('/categories/:id/words', requireAdmin, (req, res) => {
    const list = words.wordsOf(req.params.id);
    if (!list) return res.status(404).json({ ok: false, message: 'Categoria não encontrada.' });
    res.json({ ok: true, words: list });
  });

  router.post(
    '/categories/:id/words',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await words.addWords(req.params.id, req.body.words || req.body.text || '');
      res.status(r.ok ? 200 : 400).json(r);
    })
  );

  router.put(
    '/words/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await words.updateWord(req.params.id, req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    })
  );

  router.delete(
    '/words/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await words.deleteWords([req.params.id]);
      res.status(r.deleted ? 200 : 404).json(r);
    })
  );

  router.post(
    '/words/delete',
    requireAdmin,
    wrap(async (req, res) => res.json(await words.deleteWords(Array.isArray(req.body.ids) ? req.body.ids : [])))
  );

  router.get('/duplicates', requireAdmin, (req, res) => res.json({ ok: true, duplicates: words.duplicates() }));

  router.post(
    '/duplicates/remove',
    requireAdmin,
    wrap(async (req, res) => {
      if (req.body.confirm !== 'ELIMINAR') return res.status(400).json({ ok: false, message: 'Confirmação em falta.' });
      res.json(await words.removeDuplicates({ keepCategory: req.body.keepCategory }));
    })
  );

  /** Pré-visualizar uma grelha (para testar uma categoria). */
  router.post(
    '/preview',
    requireAdmin,
    wrap(async (req, res) => {
      const b = req.body || {};
      const size = Number(b.size) || 12;
      const difficulty = gen.DIFFICULTIES[b.difficulty] ? b.difficulty : 'medio';
      const cat = words.get(b.categoryId || 'mista');
      if (!cat) return res.status(404).json({ ok: false, message: 'Categoria não encontrada.' });
      const seed = gen.newSeed();
      try {
        const grid = gen.generate({ seed, size, difficulty, words: words.candidates({ categoryId: cat.id, size, difficulty, rng: gen.rngFrom(seed), ignoreSeen: true }), avoid: words.avoidList(cat.id), secretLabel: cat.name });
        res.json({ ok: true, grid, verify: gen.verify(grid) });
      } catch (err) {
        res.status(400).json({ ok: false, message: err.message });
      }
    })
  );

  /* ---------- Desafios ---------- */
  router.get('/challenges', requireAdmin, (req, res) => res.json({ ok: true, challenges: challenges.list }));
  router.post(
    '/challenges',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await challenges.save(req.body || {});
      res.status(r.ok ? 201 : 400).json(r);
    })
  );
  router.put(
    '/challenges/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await challenges.save(req.body || {}, req.params.id);
      res.status(r.ok ? 200 : 400).json(r);
    })
  );
  router.post(
    '/challenges/:id/active',
    requireAdmin,
    wrap(async (req, res) => res.json(await challenges.setActive(req.params.id, !!req.body.active)))
  );
  router.delete(
    '/challenges/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await challenges.remove(req.params.id);
      res.status(r.ok ? 200 : 404).json(r);
    })
  );

  /* ---------- Partidas, jogadores, estatísticas ---------- */
  router.get(
    '/matches',
    requireAdmin,
    wrap(async (req, res) => {
      const where = [];
      const params = [];
      if (req.query.room) {
        params.push(normalizeCode(String(req.query.room)));
        where.push(`room_code = $${params.length}`);
      }
      if (req.query.mode === 'coop' || req.query.mode === 'versus') {
        params.push(req.query.mode);
        where.push(`mode = $${params.length}`);
      }
      const rows = await db.query(`SELECT * FROM ws_matches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY finished_at DESC LIMIT 300`, params);
      res.json({ ok: true, matches: rows.map(rowToMatch) });
    })
  );

  router.get(
    '/matches/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await db.one('SELECT * FROM ws_matches WHERE id = $1', [req.params.id]);
      if (!r) return res.status(404).json({ ok: false, message: 'Partida não encontrada.' });
      const placements = JSON.parse(r.placements || '[]');
      const game = { size: Number(r.size), rows: JSON.parse(r.grid || '[]'), words: JSON.parse(r.words || '[]').map((w, i) => ({ ...w, ...placements[i], len: placements[i].len })) };
      res.json({ ok: true, match: { ...rowToMatch(r), seed: r.seed, signature: r.signature, rows: game.rows, words: game.words, result: JSON.parse(r.result || '{}') }, audit: gen.verify(game) });
    })
  );

  router.get(
    '/players',
    requireAdmin,
    wrap(async (req, res) => {
      const players = await db.query('SELECT player_key, name, created_at, last_seen FROM ws_players ORDER BY last_seen DESC LIMIT 300');
      const out = [];
      for (const p of players) {
        const s = await statsFor(db, { playerKey: p.player_key });
        out.push({ name: p.name, since: Number(p.created_at), lastSeen: Number(p.last_seen), matches: s.matches, winsIndividual: s.winsIndividual, coopWins: s.coopWins, draws: s.draws, words: s.wordsFound, best: s.bestScore, accuracy: s.accuracy });
      }
      res.json({ ok: true, players: out });
    })
  );

  router.get(
    '/stats',
    requireAdmin,
    wrap(async (req, res) => {
      const all = await db.query("SELECT mode, status, winner, category_name, difficulty, size, score_team, score_x, score_o, elapsed_ms, hints, found_x, found_o, finished_at FROM ws_matches WHERE status <> 'abandoned'");
      const rooms = await db.one('SELECT COUNT(*) AS n FROM rooms');
      const open = await db.one("SELECT COUNT(*) AS n FROM rooms WHERE status = 'open'");
      const players = await db.one('SELECT COUNT(*) AS n FROM ws_players');
      const nWords = await db.one('SELECT COUNT(*) AS n FROM words');
      const perDay = {};
      const today = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
        perDay[d] = 0;
      }
      const t = { matches: all.length, coop: 0, versus: 0, coopWins: 0, draws: 0, words: 0, hints: 0, bestScore: 0, avgMs: 0 };
      const cats = {};
      const diffs = {};
      let msSum = 0;
      for (const r of all) {
        const d = new Date(Number(r.finished_at)).toISOString().slice(0, 10);
        if (d in perDay) perDay[d]++;
        t[r.mode]++;
        if (r.mode === 'coop' && r.status === 'complete') t.coopWins++;
        if (r.winner === 'draw') t.draws++;
        t.words += Number(r.found_x) + Number(r.found_o);
        t.hints += Number(r.hints);
        t.bestScore = Math.max(t.bestScore, Number(r.score_team) || 0, Number(r.score_x) || 0, Number(r.score_o) || 0);
        msSum += Number(r.elapsed_ms);
        cats[r.category_name] = (cats[r.category_name] || 0) + 1;
        diffs[r.difficulty] = (diffs[r.difficulty] || 0) + 1;
      }
      t.avgMs = all.length ? Math.round(msSum / all.length) : 0;
      const recent = (await db.query('SELECT * FROM ws_matches ORDER BY finished_at DESC LIMIT 10')).map(rowToMatch);
      res.json({ ok: true, totals: t, rooms: Number(rooms.n), openRooms: Number(open.n), players: Number(players.n), words: Number(nWords.n), categories: words.adminList().length, perDay, byCategory: cats, byDifficulty: diffs, live: manager.liveStats(), recent });
    })
  );

  /* ---------- Definições ---------- */
  router.get('/settings', requireAdmin, (req, res) => res.json({ ok: true, settings: settings.all(), schema: settings.schema() }));

  router.put(
    '/settings',
    requireAdmin,
    wrap(async (req, res) => {
      const r = await settings.update(req.body || {});
      if (!r.ok) return res.status(400).json({ ok: false, errors: r.errors, message: r.errors.join(' ') });
      logger.admin(`Definições alteradas: ${Object.keys(req.body || {}).join(', ')}`);
      res.json(r);
    })
  );

  router.post(
    '/settings/reset',
    requireAdmin,
    wrap(async (req, res) => {
      const s = await settings.reset(Array.isArray(req.body.keys) ? req.body.keys : null);
      logger.admin('Definições repostas');
      res.json({ ok: true, settings: s });
    })
  );

  /* ---------- Manutenção ---------- */
  router.post(
    '/clear-test-data',
    requireAdmin,
    wrap(async (req, res) => {
      if (req.body.confirm !== 'APAGAR') return res.status(400).json({ ok: false, message: 'Para confirmar, escreva APAGAR.' });
      const scope = req.body.scope === 'all' ? 'all' : 'history';
      await db.tx(async (q) => {
        for (const t of ['ws_matches', 'word_log', 'chat_messages', 'ws_players']) await q(`DELETE FROM ${t}`);
      });
      if (scope === 'all') {
        for (const code of [...manager.rooms.keys()]) {
          const room = manager.rooms.get(code);
          manager.kickAll(room, 'room:closed', 'A sala foi eliminada pelo administrador.');
          clearTimeout(manager.timers.get(code));
        }
        manager.rooms.clear();
        await db.tx(async (q) => {
          await q('DELETE FROM players');
          await q('DELETE FROM rooms');
        });
      } else {
        for (const room of manager.rooms.values()) {
          room.stats = require('./rooms').emptyStats();
          room.state.lastResult = null;
          await manager.save(room);
          manager.broadcast(room);
        }
        await db.run("UPDATE rooms SET stats = '{}'");
      }
      logger.admin(`Dados de teste apagados (${scope === 'all' ? 'histórico, jogadores e salas' : 'histórico e jogadores'})`);
      res.json({ ok: true });
    })
  );

  router.get(
    '/activity',
    requireAdmin,
    wrap(async (req, res) => {
      res.json({
        ok: true,
        log: logger.recent(300),
        server: { database: db.kind, uptimeSec: Math.round((Date.now() - startedAt) / 1000), sockets: io.engine.clientsCount, memoryMb: Math.round(process.memoryUsage().rss / 1048576), turnConfigured: hasTurn(), node: process.version, errors: logger.recent(300).filter((l) => l.type === 'error').length },
      });
    })
  );

  router.use((err, req, res, _next) => {
    void _next;
    logger.error(`Erro no painel: ${err.message}`, { error: err.stack });
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Ocorreu um erro no servidor.' });
  });

  return router;
}

module.exports = { createAdminRouter };
