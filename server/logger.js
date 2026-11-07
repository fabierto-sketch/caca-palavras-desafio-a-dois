'use strict';

/**
 * Registo de atividade do servidor.
 * Escreve na consola (visível nos "Logs" do Render) e guarda as últimas
 * entradas em memória para o painel de administração.
 */

const MAX_ENTRIES = 400;
const entries = [];

function log(type, message, meta = {}) {
  const entry = { at: Date.now(), type, message, ...meta };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  const line = `[${new Date(entry.at).toISOString()}] ${type.toUpperCase().padEnd(6)} ${message}`;
  if (type === 'error') console.error(line, meta.error || '');
  else if (type === 'warn') console.warn(line);
  else console.log(line);
}

function recent(limit = 150) {
  return entries.slice(-limit).reverse();
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  game: (msg, meta) => log('game', msg, meta),
  admin: (msg, meta) => log('admin', msg, meta),
  recent,
};
