'use strict';

/**
 * CAÇA-PALAVRAS ONLINE – DESAFIO A DOIS — servidor principal.
 * Express (site + API) · Socket.IO (tempo real + sinalização WebRTC) · PostgreSQL (SQLite só para testes locais)
 */

require('./server/env').load();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const logger = require('./server/logger');
const { securityHeaders, rateLimitMiddleware, RateLimiter, cleanText, safeEqual } = require('./server/security');
const { Database } = require('./server/database');
const { Settings } = require('./server/settings');
const { Words } = require('./server/words');
const { Challenges, lisbonDate } = require('./server/challenges');
const { RoomManager, registerRoomHandlers } = require('./server/rooms');
const { registerSignaling } = require('./server/webrtc');
const { createAdminRouter } = require('./server/admin');

async function start({ port = process.env.PORT || 3000, listen = true } = {}) {
  const startedAt = Date.now();
  const db = await Database.connect();
  const settings = await new Settings(db).load();
  const words = new Words(db);
  await words.seed();
  const challenges = new Challenges(db, words);
  await challenges.seed();
  const manager = new RoomManager({ db, settings, words, challenges });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  const server = http.createServer(app);
  const io = new Server(server, {
    pingInterval: 20_000,
    pingTimeout: 25_000,
    maxHttpBufferSize: 200_000,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: true },
  });
  manager.attach(io);
  const sweeper = setInterval(() => manager.sweep(), 10 * 60_000);
  sweeper.unref();

  // verificação de saúde antes de tudo (o Render chama-a por HTTP interno)
  const health = async (req, res) => {
    try {
      await db.one('SELECT 1 AS ok');
      res.json({ ok: true, database: db.kind, uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ ok: false, error: 'DATABASE_UNAVAILABLE' });
    }
  };
  app.get(['/health', '/healthz'], health);

  app.use(securityHeaders);
  app.use((req, res, next) => {
    if (process.env.FORCE_HTTPS === 'true' && req.get('x-forwarded-proto') === 'http') return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
    next();
  });

  app.use('/api/admin', createAdminRouter({ db, manager, settings, io, startedAt, words, challenges }));
  app.use('/api', rateLimitMiddleware({ windowMs: 60_000, max: 120 }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const invite = (req, code) => `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/sala/${code}`;

  /* ---------- Público ---------- */
  app.get('/api/categories', (req, res) => res.json({ ok: true, categories: words.list() }));
  app.get('/api/challenges', (req, res) => res.json({ ok: true, challenges: challenges.publicList() }));

  // criar sala (sem conta): o primeiro a entrar fica anfitrião
  const createLimiter = new RateLimiter({ windowMs: 60 * 60_000, max: Number(process.env.ROOMS_PER_HOUR || 12) });
  const createFailLimiter = new RateLimiter({ windowMs: 15 * 60_000, max: 8 });
  // palavra-passe para criar salas: ROOM_PASSWORD, ou a do painel (ADMIN_PASSWORD) se não houver outra
  const roomPassword = () => process.env.ROOM_PASSWORD || process.env.ADMIN_PASSWORD || '';
  app.post(
    '/api/rooms',
    express.json({ limit: '4kb' }),
    wrap(async (req, res) => {
      if (!settings.get('playersCanCreateRooms')) return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'De momento as salas só são criadas pelo administrador.' });
      if (settings.get('createRoomNeedsPassword')) {
        const given = req.body && typeof req.body.password === 'string' ? req.body.password : '';
        if (!roomPassword()) return res.status(503).json({ ok: false, error: 'NOT_CONFIGURED', message: 'A palavra-passe para criar salas não está configurada no servidor.' });
        if (!createFailLimiter.check(req.ip)) return res.status(429).json({ ok: false, error: 'RATE_LIMITED', message: 'Demasiadas tentativas erradas. Aguarda 15 minutos.' });
        if (!safeEqual(given, roomPassword())) {
          createFailLimiter.hit(req.ip);
          logger.warn(`Tentativa de criar sala com palavra-passe errada [${req.ip}]`);
          return res.status(401).json({ ok: false, error: 'INVALID_PASSWORD', message: 'Palavra-passe incorreta.' });
        }
      }
      if (!createLimiter.hit(req.ip)) return res.status(429).json({ ok: false, error: 'RATE_LIMITED', message: 'Criaste demasiadas salas. Tenta mais tarde.' });
      try {
        const r = await manager.createRoom({ label: cleanText((req.body && req.body.label) || '', 40), by: 'player' });
        res.status(201).json({ ok: true, code: r.code, inviteUrl: invite(req, r.code) });
      } catch (err) {
        if (err.code === 'MAX_ROOMS') return res.status(409).json({ ok: false, error: 'MAX_ROOMS', message: 'Limite de salas atingido. Tenta mais tarde.' });
        throw err;
      }
    })
  );

  /** Recordes: juntos (pontos), desafio (pontos), mais rápidos, desafio diário de hoje. */
  app.get(
    '/api/ranking',
    wrap(async (req, res) => {
      const type = ['coop', 'versus', 'fast', 'daily'].includes(req.query.type) ? req.query.type : 'coop';
      let rows;
      if (type === 'coop') rows = await db.query("SELECT x_name, o_name, category_name, size, difficulty, score_team AS score, elapsed_ms, finished_at FROM ws_matches WHERE mode = 'coop' AND status = 'complete' ORDER BY score_team DESC, elapsed_ms ASC LIMIT 20");
      else if (type === 'fast') rows = await db.query("SELECT x_name, o_name, category_name, size, difficulty, score_team AS score, elapsed_ms, finished_at FROM ws_matches WHERE mode = 'coop' AND status = 'complete' ORDER BY elapsed_ms * 1.0 / total_words ASC LIMIT 20");
      else if (type === 'versus') {
        const raw = await db.query("SELECT x_name, o_name, category_name, size, difficulty, score_x, score_o, winner, elapsed_ms, finished_at FROM ws_matches WHERE mode = 'versus' AND status = 'complete' ORDER BY finished_at DESC LIMIT 500");
        rows = raw
          .map((r) => ({ name: r.winner === 'O' ? r.o_name : r.x_name, opponent: r.winner === 'O' ? r.x_name : r.o_name, score: Math.max(Number(r.score_x), Number(r.score_o)), draw: r.winner === 'draw', category_name: r.category_name, size: Number(r.size), difficulty: r.difficulty, elapsed_ms: Number(r.elapsed_ms), finished_at: Number(r.finished_at) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);
      } else {
        const { date } = lisbonDate();
        const from = new Date(`${date}T00:00:00Z`).getTime() - 2 * 3_600_000;
        rows = await db.query("SELECT x_name, o_name, mode, category_name, size, difficulty, COALESCE(score_team, score_x + score_o) AS score, score_x, score_o, elapsed_ms, finished_at FROM ws_matches WHERE challenge_id = 'diario' AND status <> 'abandoned' AND finished_at >= $1 ORDER BY score DESC, elapsed_ms ASC LIMIT 20", [from]);
        rows = rows.filter((r) => lisbonDate(Number(r.finished_at)).date === date);
      }
      res.json({ ok: true, type, rows: rows.map((r) => ({ ...r, score: Number(r.score), elapsed_ms: Number(r.elapsed_ms), finished_at: Number(r.finished_at), size: Number(r.size) })) });
    })
  );

  app.use(
    express.static(path.join(__dirname, 'public'), {
      extensions: ['html'],
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
      setHeaders(res, file) {
        if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
  app.get(['/sala/:code', '/convite/:code'], (req, res) => res.redirect(302, `/?sala=${encodeURIComponent(req.params.code)}`));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND' }));
  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
    logger.error(`Erro em ${req.method} ${req.originalUrl}: ${err.message}`, { error: err.stack });
    res.status(500).json({ ok: false, error: 'SERVER_ERROR', message: 'Ocorreu um erro inesperado.' });
  });

  registerRoomHandlers(io, manager);
  registerSignaling(io, manager);
  io.engine.on('connection_error', (err) => logger.warn(`Erro de ligação Socket.IO: ${err.message}`));

  if (listen) {
    await new Promise((r) => server.listen(port, process.env.HOST || '0.0.0.0', r));
    logger.info(`Caça-Palavras Online a funcionar na porta ${server.address().port} (base de dados ${db.kind})`);
  }

  async function close() {
    clearInterval(sweeper);
    for (const t of manager.timers.values()) clearTimeout(t);
    io.close();
    await new Promise((r) => server.close(() => r()));
    await db.close();
  }
  return { app, server, io, db, manager, settings, words, challenges, close };
}

if (require.main === module) {
  start()
    .then((ctx) => {
      const stop = (sig) => {
        logger.info(`Sinal ${sig} recebido. A encerrar…`);
        ctx.io.emit('server:restarting', { message: 'O servidor vai reiniciar. A ligação volta automaticamente.' });
        ctx.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 6000).unref();
      };
      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('SIGINT', () => stop('SIGINT'));
    })
    .catch((err) => {
      logger.error(`Falha ao arrancar: ${err.message}`, { error: err.stack });
      process.exit(1);
    });
  process.on('unhandledRejection', (r) => logger.error(`Promessa rejeitada sem tratamento: ${r}`));
  process.on('uncaughtException', (e) => logger.error(`Exceção não tratada: ${e.message}`, { error: e.stack }));
}

module.exports = { start };
