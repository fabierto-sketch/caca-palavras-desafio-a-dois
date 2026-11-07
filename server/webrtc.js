'use strict';

/**
 * Sinalização WebRTC através do Socket.IO.
 *
 * O vídeo e o áudio viajam diretamente entre os dois navegadores (peer-to-peer).
 * O servidor apenas reencaminha as mensagens de negociação (SDP e candidatos ICE)
 * entre os dois jogadores da mesma sala — nunca para terceiros.
 *
 * Servidores ICE configuráveis por variáveis de ambiente:
 *   STUN_URLS        (opcional) lista separada por vírgulas
 *   TURN_URLS        (opcional) ex.: turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp
 *   TURN_USERNAME    (opcional)
 *   TURN_CREDENTIAL  (opcional)
 * Um servidor TURN é fortemente recomendado para ligações entre redes móveis
 * ou routers restritivos (ex.: Portugal ↔ Brasil em 4G/5G).
 */

const { RateLimiter } = require('./security');
const logger = require('./logger');

const MAX_SIGNAL_SIZE = 64 * 1024;

function splitList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function iceServers() {
  const stun = splitList(process.env.STUN_URLS);
  const servers = [
    { urls: stun.length ? stun : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  const turn = splitList((process.env.TURN_URLS || process.env.TURN_URL));
  if (turn.length) {
    servers.push({
      urls: turn,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

function hasTurn() {
  return splitList((process.env.TURN_URLS || process.env.TURN_URL)).length > 0;
}

function registerSignaling(io, manager) {
  io.on('connection', (socket) => {
    const limiter = new RateLimiter({ windowMs: 10_000, max: 400 });

    /** Reencaminha um evento apenas para o adversário da mesma mesa. */
    function relay(event, payload, ack) {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!limiter.hit(socket.id)) return reply({ ok: false, error: 'RATE_LIMITED' });
      const ctx = manager.contextSync(socket);
      if (!ctx) return reply({ ok: false, error: 'NOT_IN_ROOM' });
      const target = manager.socketOf(ctx.room, ctx.seat === 'X' ? 'O' : 'X');
      if (!target) return reply({ ok: false, error: 'PARTNER_OFFLINE' });
      target.emit(event, { ...(payload || {}), from: ctx.seat, name: ctx.player.name });
      reply({ ok: true });
      return ctx;
    }

    socket.on('rtc:config', (_p, ack) => {
      if (typeof ack !== 'function') return;
      if (!manager.contextSync(socket)) return ack({ ok: false, error: 'NOT_IN_ROOM' });
      ack({ ok: true, iceServers: iceServers(), turn: hasTurn() });
    });

    socket.on('rtc:invite', (_p, ack) => {
      const ctx = relay('rtc:invite', {}, ack);
      if (ctx) logger.game(`Sala ${ctx.room.code}: ${ctx.player.name} iniciou uma videochamada`);
    });
    socket.on('rtc:accept', (_p, ack) => relay('rtc:accept', {}, ack));
    socket.on('rtc:decline', (_p, ack) => relay('rtc:decline', {}, ack));
    socket.on('rtc:hangup', (_p, ack) => relay('rtc:hangup', {}, ack));

    socket.on('rtc:media', (payload, ack) => {
      relay('rtc:media', { mic: !!(payload && payload.mic), cam: !!(payload && payload.cam) }, ack);
    });

    socket.on('rtc:signal', (payload, ack) => {
      if (!payload || typeof payload !== 'object') return typeof ack === 'function' && ack({ ok: false });
      let size = 0;
      try {
        size = JSON.stringify(payload).length;
      } catch {
        return;
      }
      if (size > MAX_SIGNAL_SIZE) return typeof ack === 'function' && ack({ ok: false, error: 'TOO_LARGE' });
      const clean = {};
      if (payload.description && typeof payload.description === 'object') {
        const { type, sdp } = payload.description;
        if (['offer', 'answer', 'rollback'].includes(type) && typeof (sdp || '') === 'string') clean.description = { type, sdp: sdp || '' };
      }
      if (payload.candidate !== undefined) clean.candidate = payload.candidate;
      relay('rtc:signal', clean, ack);
    });
  });
}

module.exports = { registerSignaling, iceServers, hasTurn };
