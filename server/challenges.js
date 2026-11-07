'use strict';

/**
 * Desafios especiais (60 s, 3 min, 5 min, relâmpago, diário, fim de semana
 * e os que o administrador criar).
 */

const crypto = require('crypto');
const logger = require('./logger');
const { cleanText } = require('./security');
const { DIFFICULTIES, rngFrom } = require('./generator');

const BUILTIN = [
  { id: 'c60', name: 'Desafio de 60 segundos', icon: '⏱️', description: 'Uma grelha pequenina e um minuto no relógio.', config: { size: 8, difficulty: 'facil', category: 'aleatoria', seconds: 60, words: 6, multiplier: 1, schedule: 'always' } },
  { id: 'c180', name: 'Desafio de 3 minutos', icon: '⏳', description: 'Grelha 10×10, nível médio, três minutos.', config: { size: 10, difficulty: 'medio', category: 'aleatoria', seconds: 180, words: 0, multiplier: 1, schedule: 'always' } },
  { id: 'c300', name: 'Desafio de 5 minutos', icon: '🕔', description: 'Grelha 12×12, nível médio, cinco minutos.', config: { size: 12, difficulty: 'medio', category: 'aleatoria', seconds: 300, words: 0, multiplier: 1, schedule: 'always' } },
  { id: 'relampago', name: 'Desafio relâmpago', icon: '⚡', description: 'Palavras curtas, 90 segundos e pontos a dobrar.', config: { size: 10, difficulty: 'facil', category: 'aleatoria', seconds: 90, words: 8, multiplier: 2, schedule: 'always' } },
  { id: 'diario', name: 'Desafio diário', icon: '📅', description: 'A mesma grelha para todos, durante todo o dia. Volta amanhã para outra!', config: { size: 12, difficulty: 'medio', category: 'aleatoria', seconds: 360, words: 0, multiplier: 1, schedule: 'daily' } },
  { id: 'fimdesemana', name: 'Desafio de fim de semana', icon: '🌅', description: 'Só ao sábado e ao domingo: uma grelha grande para jogar com calma.', config: { size: 15, difficulty: 'dificil', category: 'aleatoria', seconds: 900, words: 0, multiplier: 1.5, schedule: 'weekend' } },
];

const SCHEDULES = ['always', 'daily', 'weekend'];
const newId = () => crypto.randomBytes(6).toString('base64url');

/** Data em Lisboa (AAAA-MM-DD) e dia da semana (0 = domingo). */
function lisbonDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t).value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: wd };
}

function validateConfig(cfg, categories) {
  const errors = [];
  const c = cfg || {};
  const size = Number(c.size);
  if (!Number.isInteger(size) || size < 6 || size > 26) errors.push('Dimensão entre 6 e 26.');
  if (!DIFFICULTIES[c.difficulty]) errors.push('Dificuldade inválida.');
  if (c.category !== 'aleatoria' && c.category !== 'mista' && !categories.get(c.category)) errors.push('Categoria inválida.');
  const seconds = Number(c.seconds);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 7200) errors.push('Tempo entre 0 e 7200 segundos.');
  const words = Number(c.words || 0);
  if (!Number.isInteger(words) || words < 0 || words > 30) errors.push('Número de palavras entre 0 (automático) e 30.');
  const mult = Number(c.multiplier || 1);
  if (!(mult >= 0.5 && mult <= 5)) errors.push('Multiplicador entre 0,5 e 5.');
  if (!SCHEDULES.includes(c.schedule || 'always')) errors.push('Agenda inválida.');
  return { errors, config: { size, difficulty: c.difficulty, category: c.category, seconds, words, multiplier: Math.round(mult * 100) / 100, schedule: c.schedule || 'always' } };
}

class Challenges {
  constructor(db, words) {
    this.db = db;
    this.words = words;
    this.list = [];
  }

  async seed() {
    const have = new Set((await this.db.query('SELECT id FROM challenges')).map((r) => r.id));
    const now = Date.now();
    for (const [i, c] of BUILTIN.entries()) {
      if (have.has(c.id)) continue;
      await this.db.run('INSERT INTO challenges (id, name, description, config, active, builtin, position, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $6)', [c.id, `${c.icon} ${c.name}`, c.description, JSON.stringify(c.config), i + 1, now]);
    }
    await this.load();
  }

  async load() {
    const rows = await this.db.query('SELECT * FROM challenges ORDER BY position, created_at');
    this.list = rows.map((r) => ({ id: r.id, name: r.name, description: r.description || '', config: JSON.parse(r.config), active: !!Number(r.active), builtin: !!Number(r.builtin), position: Number(r.position) || 0 }));
  }

  get(id) {
    return this.list.find((c) => c.id === id) || null;
  }

  available(c, now = Date.now()) {
    if (!c || !c.active) return false;
    if (c.config.schedule === 'weekend') {
      const { weekday } = lisbonDate(now);
      return weekday === 0 || weekday === 6;
    }
    return true;
  }

  /** Desafios para os jogadores. */
  publicList(now = Date.now()) {
    const { date } = lisbonDate(now);
    return this.list
      .filter((c) => c.active)
      .map((c) => ({ id: c.id, name: c.name, description: c.description, size: c.config.size, difficulty: c.config.difficulty, seconds: c.config.seconds, multiplier: c.config.multiplier, schedule: c.config.schedule, available: this.available(c, now), date: c.config.schedule === 'daily' ? date : null, category: this.categoryFor(c, now).name }));
  }

  /** Semente fixa para o diário (por dia) e o de fim de semana (por fim de semana). */
  fixedSeed(c, now = Date.now()) {
    const { date, weekday } = lisbonDate(now);
    if (c.config.schedule === 'daily') return `diario:${c.id}:${date}`;
    if (c.config.schedule === 'weekend') {
      const d = new Date(`${date}T12:00:00Z`);
      if (weekday === 0) d.setUTCDate(d.getUTCDate() - 1); // domingo → sábado
      return `fds:${c.id}:${d.toISOString().slice(0, 10)}`;
    }
    return null;
  }

  categoryFor(c, now = Date.now()) {
    const cat = c.config.category;
    if (cat !== 'aleatoria') return this.words.get(cat) || this.words.get('mista');
    const seed = this.fixedSeed(c, now);
    const pool = this.words.list().filter((x) => x.id !== 'mista' && !x.special && x.words >= 20);
    if (!pool.length) return this.words.get('mista');
    if (!seed) return { id: 'aleatoria', name: 'Categoria surpresa' };
    const rng = rngFrom(seed);
    return this.words.get(pool[rng.int(pool.length)].id);
  }

  async save(input, id) {
    const { errors, config } = validateConfig(input.config, { get: (x) => this.words.get(x) });
    const name = cleanText(input.name, 60);
    if (!name) errors.push('Escreva o nome do desafio.');
    if (errors.length) return { ok: false, errors };
    const description = cleanText(input.description || '', 200);
    const now = Date.now();
    if (id) {
      if (!this.get(id)) return { ok: false, errors: ['Desafio não encontrado.'] };
      await this.db.run('UPDATE challenges SET name = $2, description = $3, config = $4, active = $5, updated_at = $6 WHERE id = $1', [id, name, description, JSON.stringify(config), input.active === false ? 0 : 1, now]);
    } else {
      id = newId();
      const pos = Math.max(0, ...this.list.map((c) => c.position)) + 1;
      await this.db.run('INSERT INTO challenges (id, name, description, config, active, builtin, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $7)', [id, name, description, JSON.stringify(config), input.active === false ? 0 : 1, pos, now]);
    }
    await this.load();
    logger.admin(`Desafio guardado: ${name}`);
    return { ok: true, id };
  }

  async setActive(id, active) {
    await this.db.run('UPDATE challenges SET active = $2, updated_at = $3 WHERE id = $1', [id, active ? 1 : 0, Date.now()]);
    await this.load();
    return { ok: true };
  }

  async remove(id) {
    const n = await this.db.run('DELETE FROM challenges WHERE id = $1', [id]);
    await this.load();
    return { ok: n > 0 };
  }
}

module.exports = { Challenges, BUILTIN, lisbonDate, validateConfig };
