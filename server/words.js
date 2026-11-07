'use strict';

/**
 * Categorias e palavras (banco editável no painel) e o sistema anti-repetição.
 */

const crypto = require('crypto');
const logger = require('./logger');
const { cleanText } = require('./security');
const { normalize, DIFFICULTIES, lengthRange } = require('./generator');
const BUILTIN = require('../data/categorias');

const MIXED = { id: 'mista', name: 'Todas as categorias', icon: '🎲', description: 'Uma mistura de todas as categorias ativas.' };
// palavras que nunca entram (o banco inicial não tem nenhuma; isto protege as importações)
const BLOCK = ['PUTA', 'CARALHO', 'MERDA', 'FODA', 'FODASE', 'CONA', 'PILA', 'CABRAO', 'PANELEIRO', 'BICHA', 'VIADO', 'CORNO', 'ESTUPIDO', 'IDIOTA', 'IMBECIL', 'OTARIO', 'BOSTA', 'PORRA', 'CACETE', 'BUCETA', 'XOTA', 'PICA', 'CRETINO', 'RETARDADO', 'NAZI'];
const newId = () => crypto.randomBytes(8).toString('base64url');
const slug = (s) =>
  normalize(s)
    .toLowerCase()
    .slice(0, 30) || newId().toLowerCase();

/** Valida uma palavra escrita pelo administrador. */
function checkWord(raw) {
  const [d, h] = String(raw || '').split('::');
  const display = cleanText(d, 30).replace(/\s+/g, ' ').trim();
  const hint = cleanText(h || '', 120);
  const norm = normalize(display);
  if (!display) return { error: 'vazia' };
  if (!/^[\p{L}][\p{L}\s'’-]*$/u.test(display)) return { display, error: 'só letras, espaços e hífenes' };
  if (norm.length < 3) return { display, error: 'tem menos de 3 letras' };
  if (norm.length > 20) return { display, error: 'tem mais de 20 letras' };
  if (BLOCK.some((b) => norm === b || (b.length >= 5 && norm.includes(b)))) return { display, error: 'palavra não permitida' };
  return { display, norm, hint };
}

class Words {
  constructor(db) {
    this.db = db;
    this.cats = new Map();
  }

  /** Importa as categorias de origem que ainda não existam (as alterações do painel mantêm-se). */
  async seed() {
    const existing = new Set((await this.db.query('SELECT id FROM categories')).map((r) => r.id));
    let cats = 0;
    let words = 0;
    const now = Date.now();
    for (const [i, c] of BUILTIN.entries()) {
      if (existing.has(c.id)) continue;
      await this.db.tx(async (q) => {
        await q('INSERT INTO categories (id, name, icon, description, active, special, position, builtin, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, $5, $6, 1, $7, $7)', [c.id, c.name, c.icon, c.description, c.special ? 1 : 0, i + 1, now]);
        const seen = new Set();
        for (const raw of c.words.split('|')) {
          const w = checkWord(raw);
          if (w.error || seen.has(w.norm)) continue;
          seen.add(w.norm);
          await q('INSERT INTO words (id, category_id, display, norm, hint, active, builtin, created_at) VALUES ($1, $2, $3, $4, $5, 1, 1, $6)', [newId(), c.id, w.display, w.norm, w.hint || null, now]);
          words++;
        }
      });
      cats++;
    }
    if (cats) logger.info(`Banco de palavras importado: ${cats} categorias e ${words} palavras.`);
    await this.load();
  }

  async load() {
    const cats = await this.db.query('SELECT * FROM categories ORDER BY position, name');
    const words = await this.db.query('SELECT id, category_id, display, norm, hint, active FROM words ORDER BY display');
    this.cats = new Map();
    for (const c of cats) this.cats.set(c.id, { id: c.id, name: c.name, icon: c.icon || '🔤', description: c.description || '', active: !!Number(c.active), special: !!Number(c.special), position: Number(c.position) || 0, builtin: !!Number(c.builtin), updatedAt: Number(c.updated_at) || null, words: [] });
    for (const w of words) {
      const c = this.cats.get(w.category_id);
      if (c) c.words.push({ id: w.id, display: w.display, norm: w.norm, hint: w.hint || '', active: !!Number(w.active) });
    }
  }

  get(id) {
    if (id === MIXED.id) return { ...MIXED, active: true, special: false, words: this.mixedWords() };
    return this.cats.get(id) || null;
  }

  mixedWords() {
    const out = [];
    const seen = new Set();
    for (const c of this.cats.values()) {
      if (!c.active || c.special) continue;
      for (const w of c.words) if (w.active && !seen.has(w.norm)) {
        seen.add(w.norm);
        out.push(w);
      }
    }
    return out;
  }

  /** Categorias para os jogadores (só as ativas). */
  list() {
    const out = [];
    for (const c of this.cats.values()) {
      if (!c.active) continue;
      const n = c.words.filter((w) => w.active).length;
      if (n < 6) continue;
      out.push({ id: c.id, name: c.name, icon: c.icon, description: c.description, special: c.special, words: n });
    }
    out.sort((a, b) => (b.special - a.special) || 0);
    return [{ ...MIXED, special: false, words: this.mixedWords().length }, ...out];
  }

  /** Para o painel. */
  adminList() {
    return [...this.cats.values()].map((c) => ({ id: c.id, name: c.name, icon: c.icon, description: c.description, active: c.active, special: c.special, builtin: c.builtin, position: c.position, words: c.words.length, activeWords: c.words.filter((w) => w.active).length, updatedAt: c.updatedAt }));
  }

  /* ---------------- Anti-repetição ---------------- */
  async seenMap(roomCode, playerKeys = []) {
    const keys = playerKeys.filter(Boolean);
    const params = [roomCode];
    let where = 'room_code = $1';
    keys.forEach((k, i) => {
      params.push(k);
      where += ` OR player_key = $${i + 2}`;
    });
    const rows = await this.db.query(`SELECT norm, MAX(at) AS at, COUNT(*) AS n FROM word_log WHERE ${where} GROUP BY norm`, params);
    return new Map(rows.map((r) => [r.norm, { at: Number(r.at), n: Number(r.n) }]));
  }

  async recentSignatures(roomCode, limit = 30) {
    const rows = await this.db.query('SELECT DISTINCT signature FROM word_log WHERE room_code = $1 AND signature IS NOT NULL ORDER BY signature LIMIT 500', [roomCode]);
    void limit;
    return new Set(rows.map((r) => r.signature));
  }

  async log(roomCode, playerKeys, norms, signature) {
    const now = Date.now();
    const keys = playerKeys.filter(Boolean);
    await this.db.tx(async (q) => {
      for (const norm of norms) {
        for (const k of keys.length ? keys : [null]) {
          await q('INSERT INTO word_log (id, room_code, player_key, norm, signature, at) VALUES ($1, $2, $3, $4, $5, $6)', [newId(), roomCode, k, norm, signature, now]);
        }
      }
    });
  }

  /**
   * Escolhe palavras candidatas por ordem de preferência:
   * primeiro as nunca vistas por esta sala/jogadores (baralhadas), depois as vistas há mais tempo.
   */
  candidates({ categoryId, size, difficulty, rng, seen = new Map(), ignoreSeen = false }) {
    const cat = this.get(categoryId);
    if (!cat) return [];
    const { minLen, maxLen } = lengthRange(size, difficulty);
    const active = cat.words.filter((w) => w.active && w.norm.length >= 3 && w.norm.length <= Math.min(maxLen, size));
    // palavras mais simples no fácil: preferir as curtas
    const shuffled = rng.shuffle(active);
    const inRange = (w) => w.norm.length >= minLen;
    if (ignoreSeen) return [...shuffled.filter(inRange), ...shuffled.filter((w) => !inRange(w))];
    const fresh = shuffled.filter((w) => !seen.has(w.norm));
    const old = shuffled.filter((w) => seen.has(w.norm)).sort((a, b) => seen.get(a.norm).at - seen.get(b.norm).at);
    return [...fresh.filter(inRange), ...old.filter(inRange), ...fresh.filter((w) => !inRange(w)), ...old.filter((w) => !inRange(w))];
  }

  /** Outras palavras da categoria (para evitar que apareçam por acaso). */
  avoidList(categoryId) {
    const cat = this.get(categoryId);
    return cat ? cat.words.filter((w) => w.active).map((w) => w.norm) : [];
  }

  /* ---------------- Administração ---------------- */
  async createCategory({ name, icon, description, special }) {
    const n = cleanText(name, 40);
    if (!n) return { ok: false, errors: ['Escreva o nome da categoria.'] };
    let id = slug(n);
    while (this.cats.has(id) || id === MIXED.id) id = `${id}-${Math.floor(Math.random() * 90 + 10)}`;
    const now = Date.now();
    const pos = Math.max(0, ...[...this.cats.values()].map((c) => c.position)) + 1;
    await this.db.run('INSERT INTO categories (id, name, icon, description, active, special, position, builtin, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, $5, $6, 0, $7, $7)', [id, n, cleanText(icon || '🔤', 8) || '🔤', cleanText(description || '', 200), special ? 1 : 0, pos, now]);
    await this.load();
    logger.admin(`Categoria criada: ${n}`);
    return { ok: true, id };
  }

  async updateCategory(id, patch) {
    const c = this.cats.get(id);
    if (!c) return { ok: false, errors: ['Categoria não encontrada.'] };
    const name = patch.name !== undefined ? cleanText(patch.name, 40) : c.name;
    if (!name) return { ok: false, errors: ['O nome não pode ficar vazio.'] };
    const icon = patch.icon !== undefined ? cleanText(patch.icon, 8) || '🔤' : c.icon;
    const description = patch.description !== undefined ? cleanText(patch.description, 200) : c.description;
    const active = patch.active !== undefined ? !!patch.active : c.active;
    const position = patch.position !== undefined ? Math.max(0, Math.min(999, Number(patch.position) || 0)) : c.position;
    await this.db.run('UPDATE categories SET name = $2, icon = $3, description = $4, active = $5, position = $6, updated_at = $7 WHERE id = $1', [id, name, icon, description, active ? 1 : 0, position, Date.now()]);
    await this.load();
    logger.admin(`Categoria ${id} alterada${patch.active !== undefined ? (active ? ' (ativada)' : ' (desativada)') : ''}`);
    return { ok: true };
  }

  async deleteCategory(id) {
    if (!this.cats.has(id)) return { ok: false, errors: ['Categoria não encontrada.'] };
    await this.db.tx(async (q) => {
      await q('DELETE FROM words WHERE category_id = $1', [id]);
      await q('DELETE FROM categories WHERE id = $1', [id]);
    });
    await this.load();
    logger.admin(`Categoria eliminada: ${id}`);
    return { ok: true };
  }

  /** Acrescenta palavras (uma por linha; «palavra :: dica» opcional). */
  async addWords(categoryId, input) {
    const c = this.cats.get(categoryId);
    if (!c) return { ok: false, errors: ['Categoria não encontrada.'] };
    const lines = (Array.isArray(input) ? input : String(input || '').split(/\r?\n|;/))
      .map((l) => String(l).trim())
      .filter(Boolean)
      .slice(0, 5000);
    const existing = new Set(c.words.map((w) => w.norm));
    const added = [];
    const skipped = [];
    const now = Date.now();
    await this.db.tx(async (q) => {
      for (const line of lines) {
        const w = checkWord(line);
        if (w.error) {
          skipped.push({ word: w.display || line.slice(0, 30), reason: w.error });
          continue;
        }
        if (existing.has(w.norm)) {
          skipped.push({ word: w.display, reason: 'já existe nesta categoria' });
          continue;
        }
        existing.add(w.norm);
        await q('INSERT INTO words (id, category_id, display, norm, hint, active, builtin, created_at) VALUES ($1, $2, $3, $4, $5, 1, 0, $6)', [newId(), categoryId, w.display, w.norm, w.hint || null, now]);
        added.push(w.display);
      }
    });
    await this.load();
    if (added.length) logger.admin(`${added.length} palavras acrescentadas a ${categoryId}`);
    return { ok: true, added: added.length, skipped };
  }

  async updateWord(id, patch) {
    const row = await this.db.one('SELECT * FROM words WHERE id = $1', [id]);
    if (!row) return { ok: false, errors: ['Palavra não encontrada.'] };
    let display = row.display;
    let norm = row.norm;
    if (patch.display !== undefined) {
      const w = checkWord(patch.display);
      if (w.error) return { ok: false, errors: [`«${w.display || patch.display}»: ${w.error}.`] };
      const clash = await this.db.one('SELECT id FROM words WHERE category_id = $1 AND norm = $2 AND id <> $3', [row.category_id, w.norm, id]);
      if (clash) return { ok: false, errors: ['Já existe essa palavra nesta categoria.'] };
      display = w.display;
      norm = w.norm;
    }
    const hint = patch.hint !== undefined ? cleanText(patch.hint, 120) : row.hint;
    const active = patch.active !== undefined ? !!patch.active : !!Number(row.active);
    await this.db.run('UPDATE words SET display = $2, norm = $3, hint = $4, active = $5 WHERE id = $1', [id, display, norm, hint || null, active ? 1 : 0]);
    await this.load();
    return { ok: true };
  }

  async deleteWords(ids) {
    let n = 0;
    for (const id of ids.slice(0, 2000)) n += await this.db.run('DELETE FROM words WHERE id = $1', [String(id)]);
    await this.load();
    if (n) logger.admin(`${n} palavras eliminadas`);
    return { ok: true, deleted: n };
  }

  /** Palavras repetidas entre categorias (a mesma palavra em vários sítios). */
  duplicates() {
    const by = new Map();
    for (const c of this.cats.values()) for (const w of c.words) {
      if (!by.has(w.norm)) by.set(w.norm, []);
      by.get(w.norm).push({ id: w.id, display: w.display, categoryId: c.id, categoryName: c.name });
    }
    return [...by.entries()].filter(([, l]) => l.length > 1).map(([norm, list]) => ({ norm, list })).sort((a, b) => a.norm.localeCompare(b.norm));
  }

  /** Elimina as repetições entre categorias, mantendo a palavra na categoria indicada (ou na primeira). */
  async removeDuplicates({ keepCategory } = {}) {
    const dels = [];
    for (const d of this.duplicates()) {
      const keep = d.list.find((x) => x.categoryId === keepCategory) || d.list[0];
      for (const x of d.list) if (x !== keep) dels.push(x.id);
    }
    return this.deleteWords(dels);
  }

  wordsOf(categoryId) {
    const c = this.cats.get(categoryId);
    return c ? c.words : null;
  }
}

module.exports = { Words, MIXED, checkWord, DIFFICULTIES };
