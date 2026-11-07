'use strict';

/**
 * Regras de uma partida (sem base de dados): seleções, pontuação, pistas,
 * tempo, pausa, fim e vistas por jogador.
 *
 * Segurança: as posições das palavras ficam no servidor. Cada jogador só
 * recebe as posições das palavras que já encontrou (no desafio, nunca as do
 * adversário) — até a partida acabar.
 */

const crypto = require('crypto');
const { DIRS, DIR_NAMES, DIR_ARROWS, DIFFICULTIES, matchSelection, wordCells } = require('./generator');

const SEATS = ['X', 'O'];
const other = (s) => (s === 'X' ? 'O' : 'X');
const HINT_KINDS = ['letter', 'direction', 'zone', 'text', 'reveal'];
const HINT_NAMES = { letter: 'Primeira letra', direction: 'Direção', zone: 'Zona', text: 'Indicação', reveal: 'Revelar palavra' };

function rulesFrom(settings, { multiplier = 1, difficulty }) {
  return {
    points: { short: settings.pointsShort, medium: settings.pointsMedium, long: settings.pointsLong, veryLong: settings.pointsVeryLong },
    secretBonus: settings.secretBonus,
    completionBonus: settings.completionBonus,
    firstFinishBonus: settings.firstFinishBonus,
    speedBonusPerSecond: settings.speedBonusPerSecond,
    parSecondsPerWord: settings.parSecondsPerWord,
    wrongPenalty: settings.wrongPenalty,
    costs: { letter: settings.hintLetterCost, direction: settings.hintDirectionCost, zone: settings.hintZoneCost, text: settings.hintTextCost, reveal: settings.hintRevealCost },
    allowReveal: !!settings.allowReveal,
    maxHints: { facil: settings.maxHintsFacil, medio: settings.maxHintsMedio, dificil: settings.maxHintsDificil, especialista: settings.maxHintsEspecialista }[difficulty] ?? 6,
    zoneSeconds: settings.zoneSeconds,
    multiplier,
  };
}

function wordPoints(rules, len) {
  const p = rules.points;
  const base = len <= 4 ? p.short : len <= 7 ? p.medium : len <= 10 ? p.long : p.veryLong;
  return Math.round(base * (rules.multiplier || 1));
}

function emptyPlayer() {
  return { score: 0, found: {}, correct: 0, wrong: 0, hints: 0, hintList: [], done: false, doneMs: null, gaveUp: false, bonus: 0 };
}

/**
 * Cria uma partida a partir de uma grelha gerada.
 */
function newMatch({ grid, mode, category, challenge = null, timeLimitMs = 0, settings, repeatOf = null }) {
  return {
    id: crypto.randomBytes(9).toString('base64url'),
    mode: mode === 'versus' ? 'versus' : 'coop',
    difficulty: grid.difficulty,
    size: grid.size,
    seed: grid.seed,
    signature: grid.signature,
    rows: grid.rows,
    words: grid.words,
    category: { id: category.id, name: category.name, icon: category.icon, special: !!category.special },
    challenge: challenge ? { id: challenge.id, name: challenge.name, multiplier: challenge.config.multiplier } : null,
    repeatOf,
    rules: rulesFrom(settings, { multiplier: challenge ? challenge.config.multiplier : 1, difficulty: grid.difficulty }),
    timeLimitMs: Math.max(0, Number(timeLimitMs) || 0),
    elapsedMs: 0,
    resumedAt: null,
    paused: false,
    pauseReq: null,
    status: 'playing',
    startedAt: Date.now(),
    finishedAt: null,
    found: {}, // modo «juntos»: palavra → { by, ms, revealed }
    hints: [], // modo «juntos»: pistas partilhadas
    players: { X: emptyPlayer(), O: emptyPlayer() },
    leader: null,
    result: null,
  };
}

/* ------------------------------------------------------------------ */
/* Tempo                                                               */
/* ------------------------------------------------------------------ */
function elapsed(m, now = Date.now()) {
  return m.elapsedMs + (m.resumedAt ? now - m.resumedAt : 0);
}
function timeLeft(m, now = Date.now()) {
  return m.timeLimitMs ? Math.max(0, m.timeLimitMs - elapsed(m, now)) : null;
}
function pause(m, now = Date.now()) {
  if (m.resumedAt) {
    m.elapsedMs += now - m.resumedAt;
    m.resumedAt = null;
  }
}
function resume(m, now = Date.now()) {
  if (m.status !== 'playing' || m.paused || m.resumedAt) return;
  m.resumedAt = now;
}
function isRunning(m) {
  return !!m.resumedAt;
}

/* ------------------------------------------------------------------ */
/* Seleções                                                            */
/* ------------------------------------------------------------------ */
function foundBy(m, seat, wid) {
  return m.mode === 'coop' ? m.found[wid] : m.players[seat].found[wid];
}
function remaining(m, seat) {
  return m.words.filter((w) => !foundBy(m, seat, w.id)).length;
}

/**
 * Um jogador seleciona da letra (r1,c1) à letra (r2,c2).
 * O servidor confirma letra a letra; nunca confia no navegador.
 */
function select(m, seat, sel, now = Date.now()) {
  if (m.status !== 'playing') return { ok: false, error: 'NOT_PLAYING' };
  if (!isRunning(m)) return { ok: false, error: 'PAUSED' };
  const me = m.players[seat];
  if (me.done) return { ok: false, error: 'ALREADY_DONE' };
  const res = matchSelection(m, sel);
  if (res.error) return { ok: false, error: 'BAD_SELECTION' };
  const events = [];
  if (!res.word) {
    // seleção errada: penalização configurada
    me.wrong++;
    const pen = m.rules.wrongPenalty;
    me.score -= pen;
    return { ok: true, result: 'wrong', penalty: pen, events };
  }
  const w = res.word;
  if (foundBy(m, seat, w.id)) return { ok: true, result: 'already', wordId: w.id, events };
  const ms = elapsed(m, now);
  const points = wordPoints(m.rules, w.len) + (w.secret ? m.rules.secretBonus : 0);
  me.correct++;
  me.score += points;
  if (m.mode === 'coop') m.found[w.id] = { by: seat, ms };
  else me.found[w.id] = { ms };
  events.push({ type: 'found', by: seat, wordId: w.id, points, secret: w.secret, display: w.display });
  // quem vai à frente / falta pouco
  const left = remaining(m, seat);
  if (m.mode === 'coop') {
    if (left > 0 && left <= 2) events.push({ type: 'almost', left });
    const cX = Object.values(m.found).filter((f) => f.by === 'X').length;
    const cO = Object.values(m.found).filter((f) => f.by === 'O').length;
    const lead = cX > cO + 1 ? 'X' : cO > cX + 1 ? 'O' : null;
    if (lead && lead !== m.leader) events.push({ type: 'lead', seat: lead });
    m.leader = lead || m.leader;
  } else {
    const sX = m.players.X.score;
    const sO = m.players.O.score;
    const lead = sX > sO ? 'X' : sO > sX ? 'O' : null;
    if (lead && lead !== m.leader) events.push({ type: 'lead', seat: lead });
    if (lead) m.leader = lead;
    if (left > 0 && left <= 2) events.push({ type: 'almost', left, seat });
  }
  let end = null;
  if (left === 0) {
    if (m.mode === 'coop') end = 'complete';
    else {
      me.done = true;
      me.doneMs = ms;
      events.push({ type: 'player-done', seat, ms });
      if (m.players[other(seat)].done) end = 'complete';
    }
  }
  return { ok: true, result: 'found', wordId: w.id, points, events, end };
}

/** No desafio: um jogador dá por terminada a sua parte. */
function giveUp(m, seat, now = Date.now()) {
  if (m.mode !== 'versus' || m.status !== 'playing') return { ok: false, error: 'WRONG_PHASE' };
  const me = m.players[seat];
  if (me.done) return { ok: false, error: 'ALREADY_DONE' };
  me.done = true;
  me.gaveUp = true;
  me.doneMs = elapsed(m, now);
  return { ok: true, end: m.players[other(seat)].done ? 'complete' : null };
}

/* ------------------------------------------------------------------ */
/* Pistas                                                              */
/* ------------------------------------------------------------------ */
function hintList(m, seat) {
  return m.mode === 'coop' ? m.hints : m.players[seat].hintList;
}

function hint(m, seat, { wordId, kind }, now = Date.now()) {
  if (m.status !== 'playing') return { ok: false, error: 'NOT_PLAYING' };
  if (!isRunning(m)) return { ok: false, error: 'PAUSED' };
  if (!HINT_KINDS.includes(kind)) return { ok: false, error: 'INVALID_ACTION' };
  if (kind === 'reveal' && !m.rules.allowReveal) return { ok: false, error: 'DISABLED' };
  const w = m.words.find((x) => x.id === wordId);
  if (!w) return { ok: false, error: 'NOT_FOUND' };
  if (foundBy(m, seat, w.id)) return { ok: false, error: 'ALREADY_FOUND' };
  if (m.players[seat].done) return { ok: false, error: 'ALREADY_DONE' };
  const list = hintList(m, seat);
  if (list.some((h) => h.wordId === wordId && h.kind === kind)) return { ok: false, error: 'HINT_USED' };
  if (list.length >= m.rules.maxHints) return { ok: false, error: 'NO_MORE_HINTS' };
  const me = m.players[seat];
  const cost = m.rules.costs[kind] || 0;
  const [dr, dc] = DIRS[w.dir];
  let data;
  switch (kind) {
    case 'letter':
      data = { r: w.r, c: w.c, letter: w.norm[0] };
      break;
    case 'direction':
      data = { dir: w.dir, name: DIR_NAMES[w.dir], arrow: DIR_ARROWS[w.dir] };
      break;
    case 'zone': {
      const er = w.r + dr * (w.len - 1);
      const ec = w.c + dc * (w.len - 1);
      let r0 = Math.min(w.r, er);
      let r1 = Math.max(w.r, er);
      let c0 = Math.min(w.c, ec);
      let c1 = Math.max(w.c, ec);
      // a zona tem pelo menos 5×5 e é um pouco maior do que a palavra
      const grow = (a, b, min) => {
        while (b - a + 1 < min) {
          if (a > 0) a--;
          if (b - a + 1 < min && b < m.size - 1) b++;
          if (a === 0 && b === m.size - 1) break;
        }
        return [a, b];
      };
      [r0, r1] = grow(Math.max(0, r0 - 1), Math.min(m.size - 1, r1 + 1), 5);
      [c0, c1] = grow(Math.max(0, c0 - 1), Math.min(m.size - 1, c1 + 1), 5);
      data = { r0, c0, r1, c1, seconds: m.rules.zoneSeconds };
      break;
    }
    case 'text':
      data = { text: w.secret ? `Começa por «${w.norm[0]}» e acaba em «${w.norm[w.len - 1]}».` : `Começa na linha ${w.r + 1} (a contar de cima) e tem ${w.len} letras.` };
      break;
    case 'reveal':
      data = { cells: wordCells(w) };
      break;
    default:
      break;
  }
  const paid = cost;
  me.score -= paid;
  me.hints++;
  const h = { wordId, kind, by: seat, data, cost: paid, at: now };
  list.push(h);
  const events = [{ type: 'hint', by: seat, kind, wordId }];
  let end = null;
  if (kind === 'reveal') {
    const ms = elapsed(m, now);
    if (m.mode === 'coop') m.found[w.id] = { by: seat, ms, revealed: true };
    else me.found[w.id] = { ms, revealed: true };
    if (remaining(m, seat) === 0) {
      if (m.mode === 'coop') end = 'complete';
      else {
        me.done = true;
        me.doneMs = ms;
        if (m.players[other(seat)].done) end = 'complete';
      }
    }
  }
  return { ok: true, hint: h, events, end };
}

/* ------------------------------------------------------------------ */
/* Fim da partida                                                      */
/* ------------------------------------------------------------------ */
function speedBonus(m, ms) {
  const r = m.rules;
  if (m.timeLimitMs) return Math.round((Math.max(0, m.timeLimitMs - ms) / 1000) * r.speedBonusPerSecond);
  const par = m.words.length * r.parSecondsPerWord * 1000;
  return Math.round((Math.max(0, par - ms) / 1000) * r.speedBonusPerSecond);
}

function finish(m, reason, now = Date.now()) {
  if (m.status !== 'playing') return m.result;
  pause(m, now);
  m.status = 'finished';
  m.finishedAt = now;
  const total = m.words.length;
  const stats = {};
  for (const s of SEATS) {
    const p = m.players[s];
    const sel = p.correct + p.wrong;
    stats[s] = { found: m.mode === 'coop' ? Object.values(m.found).filter((f) => f.by === s && !f.revealed).length : Object.values(p.found).filter((f) => !f.revealed).length, correct: p.correct, wrong: p.wrong, hints: p.hints, accuracy: sel ? Math.round((p.correct / sel) * 100) : null, timeMs: p.doneMs ?? m.elapsedMs };
  }
  if (m.mode === 'coop') {
    const complete = Object.keys(m.found).length === total;
    const bonus = complete ? m.rules.completionBonus + speedBonus(m, m.elapsedMs) : 0;
    const wordScore = m.players.X.score + m.players.O.score;
    m.result = {
      mode: 'coop',
      reason,
      complete,
      outcome: complete ? 'win' : 'timeout',
      bonus,
      teamScore: wordScore + bonus,
      found: Object.keys(m.found).length,
      total,
      elapsedMs: m.elapsedMs,
      players: stats,
      contributions: { X: m.players.X.score, O: m.players.O.score },
    };
  } else {
    const done = SEATS.filter((s) => m.players[s].done && !m.players[s].gaveUp && Object.keys(m.players[s].found).length === total);
    const first = done.sort((a, b) => m.players[a].doneMs - m.players[b].doneMs)[0] || null;
    const scores = {};
    for (const s of SEATS) {
      const p = m.players[s];
      const complete = done.includes(s);
      p.bonus = complete ? m.rules.completionBonus + speedBonus(m, p.doneMs) + (s === first ? m.rules.firstFinishBonus : 0) : 0;
      scores[s] = p.score + p.bonus;
      stats[s].bonus = p.bonus;
      stats[s].complete = complete;
      stats[s].first = s === first;
    }
    const winner = scores.X > scores.O ? 'X' : scores.O > scores.X ? 'O' : 'draw';
    m.result = { mode: 'versus', reason, winner, scores, diff: Math.abs(scores.X - scores.O), first, total, elapsedMs: m.elapsedMs, players: stats };
  }
  return m.result;
}

/* ------------------------------------------------------------------ */
/* Vista para cada jogador                                              */
/* ------------------------------------------------------------------ */
function view(m, seat, now = Date.now()) {
  const finished = m.status === 'finished';
  const opp = other(seat);
  const myHints = hintList(m, seat);
  const words = m.words.map((w) => {
    const f = foundBy(m, seat, w.id);
    const visible = finished || !!f;
    const out = {
      id: w.id,
      len: w.len,
      secret: w.secret,
      display: !w.secret || visible ? w.display : null,
      clue: w.secret ? w.secretClue : null,
      found: f ? { by: m.mode === 'coop' ? f.by : seat, ms: f.ms, revealed: !!f.revealed } : null,
      cells: visible ? wordCells(w) : null,
      hints: myHints.filter((h) => h.wordId === w.id).map((h) => ({ kind: h.kind, data: h.data, by: h.by, cost: h.cost })),
    };
    if (finished && m.mode === 'versus') {
      out.foundBy = SEATS.filter((s) => m.players[s].found[w.id]).map((s) => ({ seat: s, ms: m.players[s].found[w.id].ms, revealed: !!m.players[s].found[w.id].revealed }));
    }
    return out;
  });
  const me = m.players[seat];
  const o = m.players[opp];
  const v = {
    id: m.id,
    mode: m.mode,
    difficulty: m.difficulty,
    difficultyName: (DIFFICULTIES[m.difficulty] || {}).name,
    size: m.size,
    rows: m.rows,
    category: m.category,
    challenge: m.challenge,
    status: m.status,
    timeLimitMs: m.timeLimitMs,
    elapsedMs: elapsed(m, now),
    leftMs: timeLeft(m, now),
    running: isRunning(m),
    paused: m.paused,
    pauseReq: m.pauseReq,
    words,
    total: m.words.length,
    me: { score: me.score, found: m.mode === 'coop' ? Object.values(m.found).filter((f) => f.by === seat).length : Object.keys(me.found).length, correct: me.correct, wrong: me.wrong, hints: me.hints, done: me.done, doneMs: me.doneMs, gaveUp: me.gaveUp },
    hintsLeft: Math.max(0, m.rules.maxHints - myHints.length),
    rules: { costs: m.rules.costs, allowReveal: m.rules.allowReveal, maxHints: m.rules.maxHints, multiplier: m.rules.multiplier, wrongPenalty: m.rules.wrongPenalty },
    repeatOf: m.repeatOf,
    result: m.result,
  };
  if (m.mode === 'coop') {
    v.team = { score: m.players.X.score + m.players.O.score, found: Object.keys(m.found).length, by: { X: Object.values(m.found).filter((f) => f.by === 'X').length, O: Object.values(m.found).filter((f) => f.by === 'O').length } };
    v.opp = { score: o.score, correct: o.correct };
  } else {
    // do adversário só se sabe o resultado, nunca que palavras encontrou
    v.opp = { score: o.score, found: Object.keys(o.found).length, wrong: o.wrong, hints: o.hints, done: o.done, doneMs: o.doneMs, gaveUp: o.gaveUp };
  }
  return v;
}

module.exports = { newMatch, select, hint, giveUp, finish, view, elapsed, timeLeft, pause, resume, isRunning, wordPoints, remaining, rulesFrom, HINT_KINDS, HINT_NAMES, SEATS, other };
