'use strict';

/**
 * Testes automáticos (node:test): gerador, validação, regras do jogo e servidor real.
 *
 *   npm test                                   → servidor com SQLite temporário
 *   TEST_DATABASE_URL=postgres://… npm test     → servidor com PostgreSQL
 *
 * Os testes de integração arrancam o servidor verdadeiro (server.js) numa porta
 * livre e jogam por Socket.IO como dois navegadores.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const gen = require('../server/generator');
const G = require('../server/game');
const CATS = require('../data/categorias');

const D = gen.DIRS;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function bank(id) {
  const c = CATS.find((x) => x.id === id);
  return c.words.split('|').map((s, i) => {
    const [display, hint] = s.split('::').map((x) => x.trim());
    return { id: `${id}-${i}`, display, norm: gen.normalize(display), hint: hint || '' };
  });
}
const ends = (w) => ({ r1: w.r, c1: w.c, r2: w.r + D[w.dir][0] * (w.len - 1), c2: w.c + D[w.dir][1] * (w.len - 1) });

/* ===================================================================== */
/* Gerador                                                                */
/* ===================================================================== */
test('gerador: todas as dimensões e dificuldades produzem grelhas verificadas', () => {
  let n = 0;
  for (const { size } of gen.BASE_SIZES)
    for (const difficulty of gen.DIFFICULTY_IDS)
      for (const cat of ['animais', 'pt-br', 'paises', 'capitais']) {
        const g = gen.generate({ seed: `t-${size}-${difficulty}-${cat}`, size, difficulty, words: bank(cat), secretLabel: cat });
        const v = gen.verify(g);
        assert.ok(v.ok, `${size} ${difficulty} ${cat}: ${(v.errors || []).join(' ')}`);
        assert.equal(g.rows.length, size);
        assert.ok(g.rows.every((r) => r.length === size && /^[A-Z]+$/.test(r)), 'só letras maiúsculas sem acentos');
        assert.ok(g.words.length >= 4);
        n++;
      }
  assert.ok(n >= 96);
});

test('gerador: as 8 direções aparecem nas dificuldades altas e cada palavra existe exatamente uma vez', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const g = gen.generate({ seed: `dir-${i}`, size: 15, difficulty: 'especialista', words: bank('animais') });
    for (const w of g.words) {
      seen.add(w.dir);
      assert.equal(gen.findOccurrences(g.rows, w.norm).length, 1, `${w.norm} deve aparecer só uma vez`);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(D).sort());
});

test('gerador: «Fácil» só usa direções simples (sem ao contrário)', () => {
  for (let i = 0; i < 20; i++) {
    const g = gen.generate({ seed: `f-${i}`, size: 10, difficulty: 'facil', words: bank('frutas') });
    for (const w of g.words) assert.ok(['E', 'S'].includes(w.dir) || gen.DIFFICULTIES.facil.dirs[w.dir] > 0, w.dir);
  }
});

test('gerador: a mesma semente reconstrói a mesma grelha (auditoria)', () => {
  const a = gen.generate({ seed: 'igual', size: 12, difficulty: 'medio', words: bank('natureza') });
  const b = gen.generate({ seed: 'igual', size: 12, difficulty: 'medio', words: bank('natureza') });
  assert.deepEqual(a.rows, b.rows);
  assert.equal(a.signature, b.signature);
});

test('gerador: palavras com acentos e espaços são normalizadas sem alterar o que se mostra', () => {
  assert.equal(gen.normalize('Pão de Açúcar'), 'PAODEACUCAR');
  assert.equal(gen.normalize('Estrela-do-mar'), 'ESTRELADOMAR');
  const g = gen.generate({ seed: 'ac', size: 15, difficulty: 'medio', words: bank('pt-br') });
  assert.ok(g.words.some((w) => /[À-ÿ ]/.test(w.display)), 'há palavras mostradas com acentos ou espaços');
});

/* ===================================================================== */
/* Validação da seleção                                                   */
/* ===================================================================== */
test('validação: aceita início→fim e fim→início, recusa seleções aproximadas', () => {
  const g = gen.generate({ seed: 'val', size: 12, difficulty: 'dificil', words: bank('animais') });
  for (const w of g.words) {
    const e = ends(w);
    assert.equal(gen.matchSelection(g, e).word.id, w.id);
    assert.equal(gen.matchSelection(g, { r1: e.r2, c1: e.c2, r2: e.r1, c2: e.c1 }).word.id, w.id, 'ao contrário');
    // uma letra a menos
    const short = { ...e, r2: e.r2 - D[w.dir][0], c2: e.c2 - D[w.dir][1] };
    assert.ok(!gen.matchSelection(g, short).word, 'seleção curta recusada');
  }
  assert.equal(gen.matchSelection(g, { r1: 0, c1: 0, r2: 1, c2: 3 }).error, 'NOT_STRAIGHT');
  assert.equal(gen.matchSelection(g, { r1: 0, c1: 0, r2: 0, c2: 99 }).error, 'BAD_SELECTION');
  assert.equal(gen.matchSelection(g, { r1: 'x', c1: 0, r2: 0, c2: 1 }).error, 'BAD_SELECTION');
});

/* ===================================================================== */
/* Regras (motor do jogo, sem servidor)                                   */
/* ===================================================================== */
const BASE_SETTINGS = { pointsShort: 10, pointsMedium: 15, pointsLong: 20, pointsVeryLong: 30, secretBonus: 10, completionBonus: 50, firstFinishBonus: 30, speedBonusPerSecond: 0, parSecondsPerWord: 30, wrongPenalty: 2, hintLetterCost: 5, hintDirectionCost: 5, hintZoneCost: 8, hintTextCost: 4, hintRevealCost: 25, allowReveal: false, maxHintsFacil: 10, maxHintsMedio: 6, maxHintsDificil: 4, maxHintsEspecialista: 2, zoneSeconds: 6 };
function match(mode, extra = {}) {
  const g = gen.generate({ seed: `m-${mode}`, size: 12, difficulty: 'medio', words: bank('animais') });
  return G.newMatch({ mode, grid: g, category: { id: 'animais', name: 'Animais', icon: '🦊' }, timeLimitMs: 0, settings: { ...BASE_SETTINGS, ...extra } });
}

test('regras: pontuação por comprimento, sem pontos duplicados, penalização por erro', () => {
  const m = match('coop');
  G.resume(m);
  const w = m.words.find((x) => !x.secret);
  const r = G.select(m, 'X', ends(w));
  assert.equal(r.result, 'found');
  assert.equal(r.points, w.len <= 4 ? 10 : w.len <= 7 ? 15 : w.len <= 10 ? 20 : 30);
  const again = G.select(m, 'O', ends(w));
  assert.equal(again.result, 'already');
  assert.equal(m.players.O.score, 0, 'repetir não dá pontos');
  const bad = G.select(m, 'O', { r1: 0, c1: 0, r2: 0, c2: 1 });
  assert.equal(bad.result, 'wrong');
  assert.equal(m.players.O.score, -2);
});

test('regras: desafio — cada um encontra as suas palavras; vista não revela as do adversário', () => {
  const m = match('versus');
  G.resume(m);
  const w = m.words[0];
  assert.equal(G.select(m, 'X', ends(w)).result, 'found');
  assert.equal(G.select(m, 'O', ends(w)).result, 'found', 'o O também pode encontrar a mesma palavra');
  const w2 = m.words[1];
  G.select(m, 'X', ends(w2));
  const vO = G.view(m, 'O');
  const ww = vO.words.find((x) => x.id === w2.id);
  assert.equal(ww.found, null);
  assert.equal(ww.cells, null);
  assert.equal(vO.opp.found, 2);
  const json = JSON.stringify(vO);
  assert.ok(!json.includes('"dir"') && !/"r":\d/.test(json), 'sem posições na vista');
});

test('regras: pistas custam pontos, têm limite e «revelar» só se permitido', () => {
  const m = match('coop');
  G.resume(m);
  const w = m.words[0];
  assert.equal(G.hint(m, 'X', { wordId: w.id, kind: 'reveal' }).error, 'DISABLED');
  const h = G.hint(m, 'X', { wordId: w.id, kind: 'letter' });
  assert.ok(h.ok);
  assert.equal(m.players.X.score, -5);
  assert.equal(G.hint(m, 'O', { wordId: w.id, kind: 'letter' }).error, 'HINT_USED', 'no modo juntos as pistas são partilhadas');
  for (const k of ['direction', 'zone', 'text']) assert.ok(G.hint(m, 'X', { wordId: w.id, kind: k }).ok);
  for (let i = 1; i < 3; i++) G.hint(m, 'O', { wordId: m.words[i].id, kind: 'letter' });
  assert.equal(G.hint(m, 'O', { wordId: m.words[4].id, kind: 'letter' }).error, 'NO_MORE_HINTS');
  const m2 = match('coop', { allowReveal: true });
  G.resume(m2);
  const rv = G.hint(m2, 'X', { wordId: m2.words[0].id, kind: 'reveal' });
  assert.ok(rv.ok && rv.hint.data.cells.length === m2.words[0].len);
});

test('regras: fim do desafio — vencedor, empate e bónus de quem termina primeiro', () => {
  const m = match('versus');
  G.resume(m);
  for (const w of m.words) G.select(m, 'X', ends(w));
  assert.ok(m.players.X.done);
  for (const w of m.words) G.select(m, 'O', ends(w));
  assert.equal(m.status, 'playing', 'o fim é decidido fora (servidor)');
  const res = G.finish(m, 'all-done');
  assert.equal(res.first, 'X');
  assert.equal(res.winner, 'X');
  assert.equal(res.scores.X - res.scores.O, 30);
  const d = match('versus');
  G.resume(d);
  const r2 = G.finish(d, 'timeout');
  assert.equal(r2.winner, 'draw');
});

/* ===================================================================== */
/* Servidor real                                                          */
/* ===================================================================== */
const PORT = 3900 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const PASS = 'teste-segredo-123';
let proc = null;
const tmpDb = path.join(os.tmpdir(), `cp-test-${process.pid}.db`);

async function startServer() {
  const env = { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: PASS, WS_TEST_HOOKS: '1', SELECT_RATE_MAX: '1000', SOCKET_RATE_MAX: '5000', JOIN_RATE_MAX: '500', ROOMS_PER_HOUR: '200', NODE_ENV: 'test' };
  if (process.env.TEST_DATABASE_URL) env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  else {
    delete env.DATABASE_URL;
    env.SQLITE_FILE = tmpDb;
  }
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* ainda a arrancar */
    }
    await wait(150);
  }
  throw new Error(`O servidor não arrancou:\n${out}`);
}

const emit = (s, e, p = {}) => new Promise((r) => s.emit(e, p, r));
async function newRoom() {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return r.json();
}
async function player(code, name, extra = {}) {
  const s = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((r, j) => {
    s.on('connect', r);
    s.on('connect_error', j);
  });
  s.events = [];
  s.roomEvents = [];
  s.chat = [];
  s.on('room:state', (x) => (s.st = x));
  s.on('game:events', (e) => s.events.push(...e.events));
  s.on('room:event', (e) => s.roomEvents.push(e));
  s.on('chat:message', (m) => s.chat.push(m));
  const j = await emit(s, 'room:join', { code, name, pid: `pid-${name}-${code}-0000000000`, ...extra });
  s.join = j;
  if (j.ok) {
    s.seat = j.seat;
    s.token = j.token;
    s.st = j.state;
  }
  return s;
}
async function pair(cfg = {}) {
  const room = await newRoom();
  const A = await player(room.code, 'Alberto');
  const B = await player(room.code, 'Bernardete');
  assert.ok(A.join.ok && B.join.ok, JSON.stringify([A.join, B.join]));
  if (Object.keys(cfg).length) {
    const r = await emit(A, 'cfg:set', cfg);
    assert.ok(r.ok, JSON.stringify(r));
  }
  return { room, A, B };
}
const close = (...ss) => ss.forEach((s) => s && s.close());

test('servidor', async (t) => {
  await startServer();
  t.after(() => {
    if (proc) proc.kill();
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* nada */
    }
  });

  await t.test('/health responde sem redirecionar', async () => {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.ok(j.ok);
  });

  await t.test('salas: código de 6 caracteres, convite, terceiro jogador bloqueado, códigos inválidos', async () => {
    const room = await newRoom();
    assert.match(room.code, /^[A-Z2-9]{6}$/);
    assert.ok(room.inviteUrl.endsWith(`/sala/${room.code}`));
    const A = await player(room.code, 'Alberto');
    const B = await player(room.code, 'Bernardete');
    const C = await player(room.code, 'Intruso');
    assert.equal(C.join.error, 'ROOM_FULL');
    const D2 = await player('ABC', 'X');
    assert.equal(D2.join.error, 'INVALID_CODE');
    const E = await player('ZZZZZZ', 'X');
    assert.equal(E.join.error, 'ROOM_NOT_FOUND');
    assert.equal(A.st.host, 'X');
    const notHost = await emit(B, 'cfg:set', { mode: 'versus' });
    assert.equal(notHost.error, 'NOT_HOST');
    const intruderStart = await emit(C, 'game:start');
    assert.equal(intruderStart.error, 'NOT_IN_ROOM');
    const unknown = await emit(A, 'score:set', { score: 9999 });
    assert.equal(unknown.error, 'NOT_ALLOWED');
    const redirect = await fetch(`${BASE}/sala/${room.code}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    close(A, B, C, D2, E);
  });

  await t.test('jogar juntos: sincronização, quem encontrou, pontuação conjunta e fim automático', async () => {
    const { A, B } = await pair({ mode: 'coop', difficulty: 'dificil', size: 15, categoryId: 'pt-br', minutes: 5 });
    assert.ok((await emit(A, 'game:start')).ok);
    await wait(80);
    const m = A.st.match;
    assert.equal(m.size, 15);
    assert.ok(m.running);
    assert.ok(!JSON.stringify(A.st).includes('"dir"'), 'o navegador não recebe as posições');
    const sol = (await emit(A, 'test:solution')).words;
    const w0 = sol[0];
    const r = await emit(B, 'game:select', ends(w0));
    assert.equal(r.result, 'found');
    await wait(80);
    const seenByA = A.st.match.words.find((x) => x.id === w0.id);
    assert.equal(seenByA.found.by, 'O', 'o A vê que foi a Bernardete');
    assert.equal(seenByA.cells.length, w0.len);
    assert.ok(A.events.some((e) => e.type === 'found' && e.by === 'O'));
    const dup = await emit(A, 'game:select', ends(w0));
    assert.equal(dup.result, 'already');
    for (const [i, w] of sol.slice(1).entries()) await emit(i % 2 ? A : B, 'game:select', ends(w));
    await wait(120);
    assert.equal(A.st.phase, 'finished');
    const res = A.st.match.result;
    assert.ok(res.complete);
    assert.equal(res.teamScore, res.contributions.X + res.contributions.O + res.bonus);
    assert.ok(res.bonus >= 50);
    close(A, B);
  });

  await t.test('desafio: mesma grelha, progresso individual e nenhuma informação privada do adversário', async () => {
    const { A, B } = await pair({ mode: 'versus', difficulty: 'medio', size: 12, categoryId: 'animais', minutes: 0 });
    assert.ok((await emit(A, 'game:start')).ok);
    await wait(80);
    assert.deepEqual(A.st.match.rows, B.st.match.rows, 'grelha idêntica');
    const sol = (await emit(A, 'test:solution')).words;
    const w = sol[0];
    assert.equal((await emit(A, 'game:select', ends(w))).result, 'found');
    await wait(80);
    const bWord = B.st.match.words.find((x) => x.id === w.id);
    assert.equal(bWord.found, null, 'B não sabe qual palavra o A encontrou');
    assert.equal(bWord.cells, null);
    assert.equal(B.st.match.opp.found, 1);
    assert.ok(B.st.match.opp.score > 0, 'mas vê a pontuação ao vivo');
    const ev = B.events.filter((e) => e.type.includes('found'));
    assert.ok(ev.length && ev.every((e) => e.type === 'opp-found' && !e.wordId && !e.display), 'eventos sem a palavra');
    assert.ok(!JSON.stringify(B.st).includes(w.norm) || w.secret === false, 'nada de soluções no estado');
    // pistas independentes
    const hA = await emit(A, 'game:hint', { wordId: sol[1].id, kind: 'letter' });
    assert.ok(hA.ok);
    const hB = await emit(B, 'game:hint', { wordId: sol[1].id, kind: 'letter' });
    assert.ok(hB.ok, 'a pista do A não gasta a do B');
    await wait(60);
    assert.equal(B.st.match.words.find((x) => x.id === sol[1].id).hints.length, 1);
    assert.ok(B.events.some((e) => e.type === 'opp-hint'));
    // B desiste; A termina; vencedor
    assert.ok((await emit(B, 'game:giveup')).ok);
    for (const x of sol.slice(1)) await emit(A, 'game:select', ends(x));
    await wait(120);
    assert.equal(A.st.phase, 'finished');
    assert.equal(A.st.match.result.winner, 'X');
    // depois do fim, já se pode ver tudo
    assert.ok(B.st.match.words.every((x) => x.cells));
    close(A, B);
  });

  await t.test('desafio: empate permitido quando ninguém pontua', async () => {
    const { A, B } = await pair({ mode: 'versus', size: 8, difficulty: 'facil', categoryId: 'frutas', minutes: 1 });
    await emit(A, 'game:start');
    await emit(A, 'test:time', { leftMs: 50 });
    await wait(400);
    assert.equal(A.st.phase, 'finished');
    assert.equal(A.st.match.result.winner, 'draw');
    assert.equal(A.st.match.result.reason, 'timeout');
    close(A, B);
  });

  await t.test('tempo: termina ao esgotar, pausa só com acordo, relógio parado se alguém sai', async () => {
    const { room, A, B } = await pair({ mode: 'coop', size: 10, difficulty: 'facil', categoryId: 'animais', minutes: 3 });
    await emit(A, 'game:start');
    const p1 = await emit(A, 'game:pause', { action: 'request' });
    assert.ok(p1.ok && p1.pending && !p1.paused);
    await wait(50);
    assert.ok(B.roomEvents.some((e) => e.type === 'pause-request'));
    const p2 = await emit(B, 'game:pause', { action: 'accept' });
    assert.ok(p2.paused);
    await wait(50);
    assert.equal(A.st.match.running, false);
    const sel = await emit(A, 'game:select', { r1: 0, c1: 0, r2: 0, c2: 2 });
    assert.equal(sel.error, 'PAUSED');
    assert.ok((await emit(B, 'game:pause', { action: 'resume' })).ok);
    await wait(50);
    assert.ok(A.st.match.running);
    // desligar: o relógio pára
    B.close();
    await wait(200);
    assert.equal(A.st.match.running, false);
    const B2 = await player(room.code, 'Bernardete', { token: B.token });
    assert.ok(B2.join.ok);
    assert.equal(B2.seat, 'O', 'recupera o mesmo lugar');
    assert.equal(B2.st.phase, 'playing', 'recupera a partida a meio');
    await wait(80);
    assert.ok(A.st.match.running);
    await emit(A, 'test:time', { leftMs: 100 });
    await wait(500);
    assert.equal(A.st.phase, 'finished');
    assert.equal(A.st.match.result.outcome, 'timeout');
    close(A, B2);
  });

  await t.test('anti-repetição: a partida seguinte evita as palavras já usadas; repetir grelha só a pedido', async () => {
    const { A, B } = await pair({ mode: 'coop', size: 10, difficulty: 'facil', categoryId: 'frutas', minutes: 0 });
    await emit(A, 'game:start');
    const first = A.st.match.words.map((w) => w.display).filter(Boolean);
    const rows1 = A.st.match.rows.join('');
    await emit(A, 'game:lobby');
    await emit(A, 'game:start');
    const second = A.st.match.words.map((w) => w.display).filter(Boolean);
    const overlap = second.filter((w) => first.includes(w));
    assert.ok(overlap.length <= 1, `palavras repetidas: ${overlap.join(', ')}`);
    assert.notEqual(A.st.match.rows.join(''), rows1);
    await emit(A, 'game:lobby');
    const rep = await emit(A, 'game:start', { repeat: true });
    assert.ok(rep.ok);
    assert.ok(A.st.match.repeatOf, 'marcada como repetição');
    close(A, B);
  });

  await t.test('histórico e estatísticas permanentes; revisão de partidas', async () => {
    const { A, B } = await pair({ mode: 'versus', size: 8, difficulty: 'facil', categoryId: 'frutas', minutes: 1 });
    await emit(A, 'game:start');
    const sol = (await emit(A, 'test:solution')).words;
    for (const w of sol) await emit(A, 'game:select', ends(w));
    for (const w of sol) await emit(B, 'game:select', ends(w));
    await wait(150);
    const h = await emit(A, 'history:get');
    assert.ok(h.ok);
    assert.equal(h.room.matches, 1);
    assert.equal(h.mine.winsIndividual, 1);
    const id = h.room.recent[0].id;
    const one = await emit(B, 'history:match', { id });
    assert.ok(one.ok && one.match.rows.length === 8 && one.match.words.every((w) => typeof w.r === 'number'));
    const rank = await (await fetch(`${BASE}/api/ranking?type=versus`)).json();
    assert.ok(rank.ok && rank.rows.length >= 1);
    close(A, B);
  });

  await t.test('chat e reações: entrega, limite de tamanho, histórico na reentrada', async () => {
    const { room, A, B } = await pair();
    assert.ok((await emit(A, 'chat:send', { text: 'Olá amor ❤️' })).ok);
    await wait(60);
    assert.ok(B.chat.some((m) => m.text === 'Olá amor ❤️' && m.seat === 'X'));
    assert.equal((await emit(A, 'chat:send', { text: '   ' })).error, 'INVALID_MESSAGE');
    assert.ok((await emit(A, 'chat:send', { text: 'x'.repeat(900) })).ok);
    await wait(60);
    assert.equal(B.chat[B.chat.length - 1].text.length, 500);
    assert.ok((await emit(B, 'react', { kind: 'heart' })).ok);
    assert.equal((await emit(B, 'react', { kind: 'nope' })).error, 'INVALID_MESSAGE');
    B.close();
    const B2 = await player(room.code, 'Bernardete', { token: B.token });
    assert.ok(B2.join.chat.some((m) => m.text === 'Olá amor ❤️'));
    close(A, B2);
  });

  await t.test('videochamada: sinalização apenas entre os dois da sala e configuração ICE', async () => {
    const { A, B } = await pair();
    const cfg = await emit(A, 'rtc:config');
    assert.ok(cfg.ok && Array.isArray(cfg.iceServers) && cfg.iceServers.length);
    const got = new Promise((r) => B.once('rtc:invite', r));
    assert.ok((await emit(A, 'rtc:invite')).ok);
    const inv = await got;
    assert.equal(inv.name, 'Alberto');
    const sig = new Promise((r) => B.once('rtc:signal', r));
    A.emit('rtc:signal', { description: { type: 'offer', sdp: 'v=0' } });
    assert.equal((await sig).description.type, 'offer');
    close(A, B);
  });

  await t.test('limites: seleções inválidas são recusadas sem estragar a partida', async () => {
    const { A, B } = await pair({ size: 8, difficulty: 'facil', categoryId: 'frutas', minutes: 0 });
    await emit(A, 'game:start');
    for (const bad of [{}, { r1: -1, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 5, c2: 1 }, { r1: '0', c1: 'a' }]) {
      const r = await emit(A, 'game:select', bad);
      assert.ok(r.ok === false || r.result === 'wrong', JSON.stringify(r));
    }
    close(A, B);
  });

  await t.test('administração: rotas protegidas no servidor, CSRF, palavra-passe errada, definições', async () => {
    const no = await fetch(`${BASE}/api/admin/stats`);
    assert.equal(no.status, 401);
    const wrong = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'errada' }) });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    const H = { Cookie: cookie, 'Content-Type': 'application/json' };
    const stats = await (await fetch(`${BASE}/api/admin/stats`, { headers: H })).json();
    assert.ok(stats.ok && stats.totals.matches >= 3);
    const csrf = await fetch(`${BASE}/api/admin/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ wrongPenalty: 7 }) });
    assert.equal(csrf.status, 403, 'sem cabeçalho X-Requested-With');
    const H2 = { ...H, 'X-Requested-With': 'caca-palavras' };
    const put = await (await fetch(`${BASE}/api/admin/settings`, { method: 'PUT', headers: H2, body: JSON.stringify({ wrongPenalty: 7 }) })).json();
    assert.ok(put.ok);
    const bad = await fetch(`${BASE}/api/admin/settings`, { method: 'PUT', headers: H2, body: JSON.stringify({ wrongPenalty: -3 }) });
    assert.equal(bad.status, 400);
    // a nova penalização aplica-se às partidas seguintes
    const { A, B } = await pair({ size: 8, difficulty: 'facil', categoryId: 'frutas', minutes: 0 });
    await emit(A, 'game:start');
    const w = await emit(A, 'game:select', { r1: 0, c1: 0, r2: 0, c2: 1 });
    if (w.result === 'wrong') assert.equal(w.penalty, 7);
    close(A, B);
    // categorias e palavras
    const cat = await (await fetch(`${BASE}/api/admin/categories`, { method: 'POST', headers: H2, body: JSON.stringify({ name: 'Teste', icon: '🧪', words: 'Lua\nSol :: Estrela\nMar\nMar\nX1\nCéu;Rio;Vento;Chuva' }) })).json();
    assert.ok(cat.ok);
    const ws = await (await fetch(`${BASE}/api/admin/categories/${cat.id}/words`, { headers: H })).json();
    assert.deepEqual(ws.words.map((x) => x.display).sort(), ['Chuva', 'Céu', 'Lua', 'Mar', 'Rio', 'Sol', 'Vento']);
    const prev = await (await fetch(`${BASE}/api/admin/preview`, { method: 'POST', headers: H2, body: JSON.stringify({ categoryId: cat.id, size: 8, difficulty: 'facil' }) })).json();
    assert.ok(prev.ok && prev.verify.ok);
    const del = await (await fetch(`${BASE}/api/admin/categories/${cat.id}`, { method: 'DELETE', headers: H2 })).json();
    assert.ok(del.ok);
    const clear = await fetch(`${BASE}/api/admin/clear-test-data`, { method: 'POST', headers: H2, body: JSON.stringify({ confirm: 'nao' }) });
    assert.equal(clear.status, 400, 'pede confirmação');
    const act = await (await fetch(`${BASE}/api/admin/activity`, { headers: H })).json();
    assert.ok(!JSON.stringify(act).includes(PASS), 'o registo não expõe a palavra-passe');
    const html = await (await fetch(`${BASE}/admin.js`)).text();
    assert.ok(!html.includes(PASS));
  });

  await t.test('limite de tentativas de entrada numa sala (força bruta de códigos)', async () => {
    // o servidor de testes permite 500 por minuto; aqui confirma-se que o limite existe e responde em pt-PT
    const s = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise((r) => s.on('connect', r));
    let limited = null;
    for (let i = 0; i < 520 && !limited; i++) {
      const r = await emit(s, 'room:join', { code: 'ZZZZZZ', name: 'x' });
      if (r.error === 'RATE_LIMITED') limited = r;
    }
    assert.ok(limited, 'chega ao limite');
    assert.match(limited.message, /Demasiados pedidos/);
    s.close();
  });

  await t.test('cabeçalhos de segurança e ficheiros públicos', async () => {
    const r = await fetch(`${BASE}/`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-security-policy'));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    for (const f of ['/app.js', '/grid.js', '/style.css', '/admin', '/video.js', '/sound.js', '/charts.js']) assert.equal((await fetch(`${BASE}${f}`)).status, 200, f);
    assert.equal((await fetch(`${BASE}/server.js`)).status, 404);
    assert.equal((await fetch(`${BASE}/.env`)).status, 404);
  });
});
