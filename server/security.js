'use strict';

/**
 * Utilitários de segurança: cabeçalhos HTTP, limitação de pedidos (HTTP e
 * Socket.IO) e sanitização de texto. Sem dependências externas.
 */

const crypto = require('crypto');

/** Cabeçalhos de segurança aplicados a todas as respostas. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

/**
 * Limitador de janela deslizante simples, em memória.
 * hit(chave) devolve true se o pedido é permitido.
 */
class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.prune(), Math.max(windowMs, 30_000));
    this.timer.unref();
  }

  hit(key) {
    const now = Date.now();
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    while (list.length && list[0] <= now - this.windowMs) list.shift();
    if (list.length >= this.max) return false;
    list.push(now);
    return true;
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      while (list.length && list[0] <= cutoff) list.shift();
      if (!list.length) this.hits.delete(key);
    }
  }
}

/** Middleware Express de limitação por IP. */
function rateLimitMiddleware({ windowMs, max, message = 'Demasiados pedidos. Tente novamente dentro de momentos.' }) {
  const limiter = new RateLimiter({ windowMs, max });
  return (req, res, next) => {
    if (limiter.hit(req.ip || 'unknown')) return next();
    res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
    res.status(429).json({ ok: false, error: 'RATE_LIMITED', message });
  };
}

// Caracteres de controlo e de formatação invisível (inclui marcas bidirecionais).
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069]', 'g');

/** Remove caracteres de controlo e limita o comprimento. */
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Comparação em tempo constante (evita ataques de temporização). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Obtém o IP real do cliente de um socket (atrás do proxy do Render). */
function socketIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

module.exports = {
  securityHeaders,
  RateLimiter,
  rateLimitMiddleware,
  cleanText,
  randomToken,
  safeEqual,
  socketIp,
};
