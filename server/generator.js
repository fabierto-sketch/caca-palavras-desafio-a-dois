'use strict';

/**
 * Gerador de grelhas de caça-palavras.
 *
 * - Semente guardada (a mesma semente + as mesmas palavras dão sempre a mesma grelha).
 * - Oito direções, pesos diferentes por dificuldade.
 * - Cruzamentos só quando as letras coincidem; nenhuma palavra fica escondida dentro de outra.
 * - Depois de preencher, verifica que cada palavra aparece exatamente uma vez
 *   (e tenta que não apareçam outras palavras do banco por acaso).
 */

const crypto = require('crypto');

const DIRS = {
  E: [0, 1],
  W: [0, -1],
  S: [1, 0],
  N: [-1, 0],
  SE: [1, 1],
  NE: [-1, 1],
  SW: [1, -1],
  NW: [-1, -1],
};
const DIR_NAMES = {
  E: 'horizontal, da esquerda para a direita',
  W: 'horizontal, da direita para a esquerda',
  S: 'vertical, de cima para baixo',
  N: 'vertical, de baixo para cima',
  SE: 'diagonal descendente (↘)',
  NE: 'diagonal ascendente (↗)',
  SW: 'diagonal inversa descendente (↙)',
  NW: 'diagonal inversa ascendente (↖)',
};
const DIR_ARROWS = { E: '→', W: '←', S: '↓', N: '↑', SE: '↘', NE: '↗', SW: '↙', NW: '↖' };

/** Níveis de dificuldade (o administrador pode mudar tempos e pistas nas definições). */
const DIFFICULTIES = {
  facil: {
    id: 'facil',
    name: 'Fácil',
    description: 'Grelhas pequenas, palavras simples, quase tudo na horizontal e na vertical.',
    sizes: [8, 10],
    defaultSize: 10,
    dirs: { E: 6, S: 6, SE: 1 },
    minLen: 3,
    maxLen: 8,
    density: 0.8,
    overlap: 0,
    fill: 'freq',
    secrets: 0,
  },
  medio: {
    id: 'medio',
    name: 'Médio',
    description: 'Mais palavras, diagonais e palavras invertidas.',
    sizes: [10, 12],
    defaultSize: 12,
    dirs: { E: 4, S: 4, W: 2, N: 2, SE: 2, NE: 2 },
    minLen: 4,
    maxLen: 10,
    density: 0.9,
    overlap: 1,
    fill: 'freq',
    secrets: 1,
  },
  dificil: {
    id: 'dificil',
    name: 'Difícil',
    description: 'Grelhas grandes, todas as direções, palavras maiores e mais letras de enchimento.',
    sizes: [15, 18],
    defaultSize: 15,
    dirs: { E: 2, W: 2, S: 2, N: 2, SE: 2, NE: 2, SW: 2, NW: 2 },
    minLen: 5,
    maxLen: 13,
    density: 0.85,
    overlap: 2,
    fill: 'mixed',
    secrets: 1,
  },
  especialista: {
    id: 'especialista',
    name: 'Especialista',
    description: 'Grelhas enormes, palavras sobrepostas e escondidas em todas as direções.',
    sizes: [18, 20],
    defaultSize: 20,
    dirs: { E: 1, S: 1, W: 3, N: 3, SE: 2, NE: 3, SW: 3, NW: 3 },
    minLen: 5,
    maxLen: 20,
    density: 1,
    overlap: 6,
    fill: 'decoy',
    secrets: 2,
  },
};
const DIFFICULTY_IDS = Object.keys(DIFFICULTIES);
const BASE_SIZES = [
  { size: 8, label: 'Muito fácil' },
  { size: 10, label: 'Fácil' },
  { size: 12, label: 'Médio' },
  { size: 15, label: 'Difícil' },
  { size: 18, label: 'Muito difícil' },
  { size: 20, label: 'Especialista' },
];

/* ------------------------------------------------------------------ */
/* Aleatoriedade com semente                                            */
/* ------------------------------------------------------------------ */
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function rngFrom(seed) {
  let a = hashSeed(String(seed))();
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.shuffle = (arr) => {
    const a2 = arr.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [a2[i], a2[j]] = [a2[j], a2[i]];
    }
    return a2;
  };
  next.weighted = (weights) => {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let x = next() * total;
    for (const [k, w] of entries) {
      x -= w;
      if (x < 0) return k;
    }
    return entries[entries.length - 1][0];
  };
  return next;
}
const newSeed = () => crypto.randomBytes(9).toString('base64url');

/* ------------------------------------------------------------------ */
/* Palavras                                                            */
/* ------------------------------------------------------------------ */
/** Normaliza para a grelha: maiúsculas, sem acentos, sem espaços nem hífenes. */
function normalize(word) {
  return String(word || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}
const reverse = (s) => [...s].reverse().join('');

/** Letras de enchimento com a frequência do português. */
const FREQ = { A: 14, E: 12, O: 10, S: 8, R: 6.5, I: 6, N: 5, D: 5, M: 4.7, U: 4.6, T: 4.3, C: 3.9, L: 2.8, P: 2.5, V: 1.7, G: 1.3, H: 1.3, Q: 1.2, B: 1, F: 1, Z: 0.5, J: 0.4, X: 0.3 };

/** Quantas palavras para uma grelha deste tamanho e dificuldade. */
function wordCount(size, difficulty) {
  const d = DIFFICULTIES[difficulty] || DIFFICULTIES.medio;
  return Math.max(4, Math.min(30, Math.round(size * d.density)));
}

function lengthRange(size, difficulty) {
  const d = DIFFICULTIES[difficulty] || DIFFICULTIES.medio;
  const maxLen = Math.min(d.maxLen, size);
  const minLen = Math.min(d.minLen, Math.max(3, maxLen - 2));
  return { minLen, maxLen };
}

/* ------------------------------------------------------------------ */
/* Construção da grelha                                                 */
/* ------------------------------------------------------------------ */
function cellsOf(p) {
  const [dr, dc] = DIRS[p.dir];
  return Array.from({ length: p.len }, (_, i) => [p.r + dr * i, p.c + dc * i]);
}

function tryPlace(grid, size, norm, rng, diff, owner) {
  const options = [];
  for (let attempt = 0; attempt < 160; attempt++) {
    const dir = rng.weighted(diff.dirs);
    const [dr, dc] = DIRS[dir];
    const len = norm.length;
    // posições iniciais possíveis para esta direção
    const rMin = dr < 0 ? len - 1 : 0;
    const rMax = dr > 0 ? size - len : size - 1;
    const cMin = dc < 0 ? len - 1 : 0;
    const cMax = dc > 0 ? size - len : size - 1;
    if (rMax < rMin || cMax < cMin) continue;
    const r = rMin + rng.int(rMax - rMin + 1);
    const c = cMin + rng.int(cMax - cMin + 1);
    let overlap = 0;
    let ok = true;
    for (let i = 0; i < len; i++) {
      const cell = grid[r + dr * i][c + dc * i];
      if (cell === null) continue;
      if (cell !== norm[i]) {
        ok = false;
        break;
      }
      overlap++;
    }
    if (!ok || overlap === len) continue; // nunca totalmente por cima de outra
    // não deixar a palavra continuar exatamente uma palavra já colocada na mesma linha
    if (overlap > 1 && sameLineOverlap(owner, r, c, dir, len)) continue;
    options.push({ r, c, dir, len, overlap, score: overlap * diff.overlap + rng() * 2 });
    if (options.length >= 24) break;
  }
  if (!options.length) return null;
  options.sort((a, b) => b.score - a.score);
  return options[0];
}

/** Duas palavras na mesma linha e direção (ou oposta) a partilhar letras confundem-se. */
function sameLineOverlap(owner, r, c, dir, len) {
  const [dr, dc] = DIRS[dir];
  for (let i = 0; i < len; i++) {
    const list = owner[r + dr * i][c + dc * i];
    for (const o of list) {
      const [odr, odc] = DIRS[o.dir];
      if ((odr === dr && odc === dc) || (odr === -dr && odc === -dc)) return true;
    }
  }
  return false;
}

function findOccurrences(rows, norm) {
  const size = rows.length;
  const found = new Set();
  const first = norm[0];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (rows[r][c] !== first) continue;
      for (const [dir, [dr, dc]] of Object.entries(DIRS)) {
        const er = r + dr * (norm.length - 1);
        const ec = c + dc * (norm.length - 1);
        if (er < 0 || ec < 0 || er >= size || ec >= size) continue;
        let ok = true;
        for (let i = 1; i < norm.length; i++) {
          if (rows[r + dr * i][c + dc * i] !== norm[i]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const cells = Array.from({ length: norm.length }, (_, i) => `${r + dr * i},${c + dc * i}`).sort().join(';');
        found.add(cells + '|' + dir);
      }
    }
  }
  // a mesma posição lida ao contrário (palíndromos) conta como uma só
  const byCells = new Map();
  for (const f of found) {
    const [cells] = f.split('|');
    if (!byCells.has(cells)) byCells.set(cells, f);
  }
  return [...byCells.values()].map((f) => {
    const [cells, dir] = f.split('|');
    return { cells: cells.split(';'), dir };
  });
}

/**
 * Gera uma grelha.
 * @param {object} o
 * @param {string} o.seed
 * @param {number} o.size
 * @param {string} o.difficulty
 * @param {Array<{display,norm,hint?}>} o.words  palavras candidatas, por ordem de preferência
 * @param {number} [o.count]
 * @param {string[]} [o.avoid]  outras palavras do banco a evitar por acaso (tentativa)
 */
function generate({ seed, size, difficulty, words, count, avoid = [], secretLabel = '' }) {
  const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.medio;
  size = Math.max(6, Math.min(26, Number(size) || diff.defaultSize));
  const want = Math.min(count || wordCount(size, difficulty), words.length);
  const { minLen, maxLen } = lengthRange(size, difficulty);
  const usable = words.filter((w) => w.norm.length >= Math.min(minLen, 3) && w.norm.length <= Math.min(maxLen, size));
  // prefere as palavras dentro do intervalo da dificuldade, mas aceita mais curtas se faltarem
  const preferred = usable.filter((w) => w.norm.length >= minLen);
  const fallback = usable.filter((w) => w.norm.length < minLen);
  const pool = [...preferred, ...fallback];

  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = rngFrom(`${seed}#${attempt}`);
    const grid = Array.from({ length: size }, () => Array(size).fill(null));
    const owner = Array.from({ length: size }, () => Array.from({ length: size }, () => []));
    const chosen = [];
    const order = pool.slice();
    for (const w of order) {
      if (chosen.length >= want) break;
      // nada de palavras dentro de outras (MAR / MARINHEIRO), nem iguais ao contrário
      if (chosen.some((x) => x.norm.includes(w.norm) || w.norm.includes(x.norm) || reverse(x.norm).includes(w.norm) || w.norm.includes(reverse(x.norm)))) continue;
      chosen.push(w);
    }
    // as maiores primeiro (mais difíceis de encaixar)
    chosen.sort((a, b) => b.norm.length - a.norm.length);
    const placed = [];
    for (const w of chosen) {
      const p = tryPlace(grid, size, w.norm, rng, diff, owner);
      if (!p) continue;
      cellsOf(p).forEach(([r, c], i) => {
        grid[r][c] = w.norm[i];
        owner[r][c].push(p);
      });
      placed.push({ ...w, ...p });
    }
    if (placed.length < Math.min(want, 4) || placed.length < want * 0.85) continue;

    // letras de enchimento
    const wordLetters = placed.map((p) => p.norm).join('');
    const fillLetter = () => {
      if (diff.fill === 'decoy' && rng() < 0.6) return wordLetters[rng.int(wordLetters.length)];
      if (diff.fill === 'mixed' && rng() < 0.3) return wordLetters[rng.int(wordLetters.length)];
      return rng.weighted(FREQ);
    };
    const filler = [];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c] === null) filler.push([r, c]);
    filler.forEach(([r, c]) => (grid[r][c] = fillLetter()));
    const isFiller = new Set(filler.map(([r, c]) => `${r},${c}`));

    // cada palavra tem de aparecer uma única vez
    let valid = false;
    for (let fix = 0; fix < 60; fix++) {
      const rows = grid.map((row) => row.join(''));
      let changed = false;
      for (const p of placed) {
        const occ = findOccurrences(rows, p.norm);
        if (occ.length > 1) {
          const own = new Set(cellsOf(p).map(([r, c]) => `${r},${c}`));
          for (const o of occ) {
            if (o.cells.every((k) => own.has(k))) continue;
            const cand = o.cells.filter((k) => isFiller.has(k));
            if (!cand.length) continue;
            const [r, c] = rng.pick(cand).split(',').map(Number);
            grid[r][c] = fillLetter();
            changed = true;
          }
        }
      }
      // tentar que outras palavras do banco não apareçam por acaso
      if (!changed && fix < 40) {
        for (const a of avoid) {
          if (a.length < 5 || placed.some((p) => p.norm === a)) continue;
          for (const o of findOccurrences(rows, a)) {
            const cand = o.cells.filter((k) => isFiller.has(k));
            if (!cand.length) continue;
            const [r, c] = rng.pick(cand).split(',').map(Number);
            grid[r][c] = rng.weighted(FREQ);
            changed = true;
          }
        }
      }
      if (!changed) {
        valid = true;
        break;
      }
    }
    if (!valid) continue;
    const rows = grid.map((row) => row.join(''));
    if (!placed.every((p) => findOccurrences(rows, p.norm).length === 1)) continue;

    // palavras secretas: não aparecem na lista, só o número de letras e uma dica
    const secretsWanted = placed.length >= 8 ? diff.secrets : 0;
    const secretIdx = new Set(rng.shuffle(placed.map((_, i) => i).filter((i) => placed[i].norm.length >= 5)).slice(0, secretsWanted));
    // a lista fica pela ordem alfabética, como nas revistas
    const list = placed
      .map((p, i) => ({ p, secret: secretIdx.has(i) }))
      .sort((a, b) => a.p.display.localeCompare(b.p.display, 'pt'))
      .map(({ p, secret }, i) => ({
        id: `w${i}`,
        display: p.display,
        norm: p.norm,
        len: p.norm.length,
        hint: p.hint || '',
        secret,
        secretClue: secret ? p.hint || `Uma palavra de «${secretLabel}» com ${p.norm.length} letras.` : '',
        r: p.r,
        c: p.c,
        dir: p.dir,
      }));
    const signature = crypto
      .createHash('sha1')
      .update(list.map((w) => w.norm).sort().join(',') + '|' + rows.join(''))
      .digest('hex')
      .slice(0, 20);
    return { seed: String(seed), size, difficulty: diff.id, rows, words: list, signature, attempt };
  }
  throw new Error('Não foi possível gerar uma grelha válida com estas palavras.');
}

/** Valida uma seleção do jogador (início e fim). Devolve a palavra ou null. */
function matchSelection(game, sel) {
  const size = game.size;
  const r1 = Number(sel.r1);
  const c1 = Number(sel.c1);
  const r2 = Number(sel.r2);
  const c2 = Number(sel.c2);
  if (![r1, c1, r2, c2].every((n) => Number.isInteger(n) && n >= 0 && n < size)) return { error: 'BAD_SELECTION' };
  const dr = Math.sign(r2 - r1);
  const dc = Math.sign(c2 - c1);
  const lr = Math.abs(r2 - r1);
  const lc = Math.abs(c2 - c1);
  // só linhas, colunas ou diagonais perfeitas
  if (!(lr === 0 || lc === 0 || lr === lc)) return { error: 'NOT_STRAIGHT' };
  const len = Math.max(lr, lc) + 1;
  if (len < 2) return { error: 'TOO_SHORT' };
  let text = '';
  for (let i = 0; i < len; i++) text += game.rows[r1 + dr * i][c1 + dc * i];
  for (const w of game.words) {
    if (w.len !== len) continue;
    const [wdr, wdc] = DIRS[w.dir];
    const er = w.r + wdr * (w.len - 1);
    const ec = w.c + wdc * (w.len - 1);
    const forward = w.r === r1 && w.c === c1 && er === r2 && ec === c2;
    const backward = w.r === r2 && w.c === c2 && er === r1 && ec === c1;
    if ((forward || backward) && (forward ? text : reverse(text)) === w.norm) return { word: w, text };
  }
  return { word: null, text };
}

/** Confirma que uma grelha guardada está correta (auditoria). */
function verify(game) {
  const errors = [];
  if (game.rows.length !== game.size || game.rows.some((r) => r.length !== game.size)) errors.push('Dimensões erradas.');
  for (const w of game.words) {
    const [dr, dc] = DIRS[w.dir] || [];
    if (dr === undefined) {
      errors.push(`${w.display}: direção inválida.`);
      continue;
    }
    let text = '';
    for (let i = 0; i < w.len; i++) {
      const r = w.r + dr * i;
      const c = w.c + dc * i;
      if (r < 0 || c < 0 || r >= game.size || c >= game.size) {
        errors.push(`${w.display}: sai da grelha.`);
        break;
      }
      text += game.rows[r][c];
    }
    if (text !== w.norm) errors.push(`${w.display}: letras não coincidem.`);
    if (findOccurrences(game.rows, w.norm).length !== 1) errors.push(`${w.display}: aparece mais do que uma vez.`);
  }
  return { ok: !errors.length, errors };
}

/** Lista de células de uma palavra (para desenhar no fim e nas pistas). */
function wordCells(w) {
  return cellsOf({ r: w.r, c: w.c, dir: w.dir, len: w.len });
}

module.exports = {
  DIRS,
  DIR_NAMES,
  DIR_ARROWS,
  DIFFICULTIES,
  DIFFICULTY_IDS,
  BASE_SIZES,
  rngFrom,
  newSeed,
  normalize,
  reverse,
  generate,
  matchSelection,
  verify,
  wordCells,
  findOccurrences,
  wordCount,
  lengthRange,
};
