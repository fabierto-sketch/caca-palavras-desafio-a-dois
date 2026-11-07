'use strict';

/**
 * Teste de ponta a ponta no navegador (Playwright + Chromium), opcional:
 *   npm i -D playwright && npx playwright install chromium
 *   npm run test:e2e
 *
 * Dois navegadores reais: o Alberto num computador (rato e teclado) e a
 * Bernardete num iPhone 13 simulado (toque). Câmara e microfone falsos para a
 * videochamada. Guarda capturas em test/screens/.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const assert = require('node:assert/strict');

let pw;
try {
  pw = require(process.env.PLAYWRIGHT_PATH || 'playwright');
} catch {
  console.error('Playwright não está instalado: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium, devices } = pw;

const PORT = 4400 + Math.floor(Math.random() * 300);
const URL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screens');
const DB = path.join(require('os').tmpdir(), `cp-e2e-${process.pid}.db`);
const D = { E: [0, 1], W: [0, -1], S: [1, 0], N: [-1, 0], SE: [1, 1], NE: [-1, 1], SW: [1, -1], NW: [-1, -1] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['✔', name]);
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push(['✘', name, err.message]);
    console.log(`✘ ${name}\n   ${err.message}`);
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'e2e-segredo', WS_TEST_HOOKS: '1', SQLITE_FILE: DB, DATABASE_URL: '', JOIN_RATE_MAX: '200', SELECT_RATE_MAX: '200' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${URL}/health`)).ok) break;
    } catch {
      /* a arrancar */
    }
    await wait(150);
  }

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 900 }, permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera', 'microphone'] });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errors = [];
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(`${n}: ${m.text()}`));
  }
  const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  const state = (p) => p.evaluate(() => window.CP.state);

  async function cellPoint(p, r, c) {
    const box = await p.locator('#board').boundingBox();
    const pad = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#board')).paddingLeft));
    const n = await p.evaluate(() => window.CP.state.match.size);
    const size = (box.width - pad * 2) / n;
    return [box.x + pad + (c + 0.5) * size, box.y + pad + (r + 0.5) * size];
  }
  async function mouseSelect(p, r1, c1, r2, c2) {
    const [x1, y1] = await cellPoint(p, r1, c1);
    const [x2, y2] = await cellPoint(p, r2, c2);
    await p.mouse.move(x1, y1);
    await p.mouse.down();
    await p.mouse.move((x1 + x2) / 2 + 3, (y1 + y2) / 2 - 2, { steps: 4 });
    await p.mouse.move(x2, y2, { steps: 4 });
    await p.mouse.up();
    await wait(350);
  }
  async function touchSelect(p, r1, c1, r2, c2) {
    await p.locator('#board').scrollIntoViewIfNeeded();
    const [x1, y1] = await cellPoint(p, r1, c1);
    const [x2, y2] = await cellPoint(p, r2, c2);
    const cdp = await p.context().newCDPSession(p);
    const tp = (x, y) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(x1, y1) });
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(x1 + ((x2 - x1) * i) / 10, y1 + ((y2 - y1) * i) / 10) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(450);
  }
  const endOf = (w) => [w.r + D[w.dir][0] * (w.len - 1), w.c + D[w.dir][1] * (w.len - 1)];

  await step('página inicial carrega (desktop e telemóvel) sem deslocamento horizontal', async () => {
    await A.goto(URL);
    await B.goto(URL);
    await A.waitForSelector('#home-cats span');
    await shot(A, '01-inicio-desktop');
    await shot(B, '02-inicio-telemovel');
    const over = await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(over, false);
  });

  let invite;
  await step('criar sala e entrar pelo link de convite', async () => {
    await A.fill('#create-name', 'Alberto');
    await A.fill('#create-pass', 'e2e-segredo');
    await A.click('#form-create button');
    await A.waitForSelector('#screen-lobby:not([hidden])');
    invite = await A.inputValue('#invite-link');
    assert.match(invite, /\/sala\/[A-Z2-9]{6}$/);
    await B.goto(invite);
    await B.waitForSelector('#join-peek:not([hidden])');
    await B.fill('#join-name', 'Bernardete');
    await B.click('#form-join button');
    await B.waitForSelector('#screen-lobby:not([hidden])');
    await A.waitForFunction(() => window.CP.state.seats.O && window.CP.state.seats.O.connected);
    await shot(A, '03-sala-de-espera');
  });

  await step('só o anfitrião configura; a convidada vê as escolhas em tempo real', async () => {
    await A.click('[data-mode="versus"]');
    await A.click('[data-diff="dificil"]');
    await A.click('[data-cat="pt-br"]');
    await A.selectOption('#cfg-minutes', '10');
    await B.waitForFunction(() => window.CP.state.config.mode === 'versus' && window.CP.state.config.categoryId === 'pt-br');
    assert.equal(await B.isVisible('#btn-start'), false);
    await shot(B, '04-sala-telemovel');
  });

  let sol;
  await step('desafio: rato (desktop) e toque (telemóvel) encontram palavras; a página não desliza', async () => {
    await A.click('#btn-start');
    await A.waitForSelector('#screen-game:not([hidden])');
    await B.waitForSelector('#screen-game:not([hidden])');
    await wait(700); // fim da animação de entrada do ecrã
    sol = (await A.evaluate(() => new Promise((r) => window.CP.socket.emit('test:solution', {}, r)))).words;
    const w = sol[0];
    await mouseSelect(A, w.r, w.c, ...endOf(w));
    let st = await state(A);
    assert.ok(st.match.words.find((x) => x.id === w.id).found, 'rato');
    const w2 = sol[1];
    const [er, ec] = endOf(w2);
    await B.locator('#board').scrollIntoViewIfNeeded();
    const y0 = await B.evaluate(() => window.scrollY);
    await touchSelect(B, er, ec, w2.r, w2.c); // ao contrário, do fim para o início
    const y1 = await B.evaluate(() => window.scrollY);
    st = await state(B);
    assert.ok(st.match.words.find((x) => x.id === w2.id).found, 'toque (ao contrário)');
    assert.ok(Math.abs(y1 - y0) < 2, `a página deslizou ${y1 - y0}px`);
    const stA = await state(A);
    assert.equal(stA.match.words.find((x) => x.id === w2.id).found, null, 'o Alberto não sabe qual foi');
    assert.equal(stA.match.opp.found, 1);
    await shot(A, '05-desafio-desktop');
    await shot(B, '06-desafio-telemovel');
  });

  await step('seleção errada: indicação discreta e penalização', async () => {
    const before = (await state(A)).match.me.score;
    // duas letras quaisquer que não sejam uma palavra
    const st = await state(A);
    let sel = null;
    for (let c = 0; c < st.match.size - 1 && !sel; c++) if (!sol.some((w) => w.r === 0 && w.c === c)) sel = [0, c, 0, c + 1];
    await mouseSelect(A, ...sel);
    const after = (await state(A)).match.me.score;
    assert.equal(after, before - (await state(A)).match.rules.wrongPenalty);
  });

  await step('teclado: setas + Enter selecionam uma palavra', async () => {
    const w = sol[2];
    await A.focus('#board');
    await A.evaluate(() => document.querySelector('#board').dispatchEvent(new FocusEvent('focus')));
    const go = async (r, c, cur) => {
      for (; cur.r < r; cur.r++) await A.keyboard.press('ArrowDown');
      for (; cur.r > r; cur.r--) await A.keyboard.press('ArrowUp');
      for (; cur.c < c; cur.c++) await A.keyboard.press('ArrowRight');
      for (; cur.c > c; cur.c--) await A.keyboard.press('ArrowLeft');
    };
    // o cursor começa em 0,0 — pode já ter sido movido; voltar ao canto
    for (let i = 0; i < 20; i++) {
      await A.keyboard.press('ArrowUp');
      await A.keyboard.press('ArrowLeft');
    }
    const cur = { r: 0, c: 0 };
    await go(w.r, w.c, cur);
    await A.keyboard.press('Enter');
    const [er, ec] = endOf(w);
    await go(er, ec, cur);
    await A.keyboard.press('Enter');
    await wait(400);
    assert.ok((await state(A)).match.words.find((x) => x.id === w.id).found);
  });

  await step('pista pela interface: primeira letra assinalada e custo descontado', async () => {
    const before = (await state(B)).match.me.score;
    await B.click('#btn-hint');
    await B.waitForSelector('#modal-hint:not([hidden])');
    await shot(B, '07-pistas-telemovel');
    await B.click('[data-kind="letter"]');
    await wait(400);
    const st = await state(B);
    assert.equal(st.match.me.score, before - st.match.rules.costs.letter);
    assert.ok(await B.$('.cell.hl-letter'), 'letra assinalada na grelha');
  });

  await step('pausa: pedido de um lado, aceitação do outro; letras escondidas', async () => {
    await A.click('#btn-pause');
    await B.waitForSelector('#g-banner [data-pause="accept"]');
    await B.click('#g-banner [data-pause="accept"]');
    await A.waitForSelector('#board-cover:not([hidden])');
    await shot(A, '08-pausa');
    await A.click('#cover-actions [data-pause="resume"]');
    await A.waitForSelector('#board-cover', { state: 'hidden' });
  });

  await step('chat, mensagens rápidas, indicador de escrita e reações', async () => {
    await A.click('#chat-fab');
    await A.fill('#chat-input', 'Estás quase! 😄');
    await B.waitForSelector('#chat-dot:not([hidden])', { timeout: 3000 }).catch(() => {});
    await A.press('#chat-input', 'Enter');
    await B.click('#chat-fab');
    await B.waitForFunction(() => [...document.querySelectorAll('#chat-log .msg')].some((m) => m.textContent.includes('Estás quase!')));
    await B.click('#quick button');
    await A.waitForFunction(() => [...document.querySelectorAll('#chat-log .msg.o')].length > 0);
    await B.click('[data-react="heart"]');
    await A.waitForSelector('.react-fly');
    await shot(A, '09-chat');
  });

  await step('videochamada com câmara e microfone (simulados): ligação estabelecida e jogo continua', async () => {
    await A.click('#btn-video-open');
    await A.click('#btn-call');
    await B.waitForSelector('#modal-call:not([hidden])', { timeout: 8000 });
    await B.click('#call-accept');
    await A.waitForSelector('#video-panel.has-remote', { timeout: 20000 });
    await B.waitForSelector('#video-panel.has-remote', { timeout: 20000 });
    await A.click('#btn-mic');
    await B.waitForSelector('#remote-media:not([hidden])', { timeout: 5000 });
    await A.click('#vp-min');
    await shot(A, '10-videochamada');
    const w = sol[3];
    await mouseSelect(A, w.r, w.c, ...endOf(w));
    assert.ok((await state(A)).match.words.find((x) => x.id === w.id).found, 'joga durante a chamada');
    await A.click('#btn-hangup').catch(async () => {
      await A.click('#vp-min');
      await A.click('#btn-hangup');
    });
    await B.waitForSelector('#video-panel:not(.in-call)', { timeout: 5000 });
    await A.click('#vp-close');
    await B.click('#vp-close').catch(() => {});
  });

  await step('fim do desafio: resultados com vencedor, precisão e diferença', async () => {
    await A.click('#chat-close').catch(() => {});
    await B.click('#chat-close').catch(() => {});
    for (const w of sol) {
      const st = await state(A);
      if (st.phase !== 'playing') break;
      if (st.match.words.find((x) => x.id === w.id).found) continue;
      await mouseSelect(A, w.r, w.c, ...endOf(w));
    }
    await B.evaluate(() => new Promise((r) => window.CP.socket.emit('game:giveup', {}, r)));
    await A.waitForSelector('#screen-results:not([hidden])');
    await B.waitForSelector('#screen-results:not([hidden])');
    const t = await A.textContent('#res-title');
    assert.match(t, /Ganhaste/);
    assert.match(await B.textContent('#res-title'), /Alberto ganhou/);
    assert.match(await A.textContent('#res-table'), /Precisão/);
    await wait(1500);
    await shot(A, '11-resultados-desktop');
    await B.evaluate(() => window.scrollTo(0, 0));
    await shot(B, '12-resultados-telemovel');
  });

  await step('rever a grelha resolvida e estatísticas com gráficos', async () => {
    await A.click('#btn-review');
    await A.waitForSelector('#modal-review:not([hidden]) .board .cell');
    await shot(A, '13-revisao');
    await A.click('#modal-review [data-close]');
    await A.click('#btn-res-stats');
    await A.waitForSelector('#stats-body .stat');
    await shot(A, '14-estatisticas');
    await A.click('[data-tab="ranking"]');
    await A.waitForSelector('#stats-body table, #stats-body p');
    await A.click('#modal-stats [data-close]');
  });

  await step('jogar juntos: as descobertas dos dois aparecem com a cor de quem encontrou', async () => {
    await A.click('#btn-res-lobby');
    await A.waitForSelector('#screen-lobby:not([hidden])');
    await A.click('[data-mode="coop"]');
    await A.click('[data-diff="facil"]');
    await A.click('[data-cat="animais"]');
    await A.click('#btn-start');
    await B.waitForSelector('#screen-game:not([hidden])');
    await wait(700); // fim da animação de entrada do ecrã
    sol = (await A.evaluate(() => new Promise((r) => window.CP.socket.emit('test:solution', {}, r)))).words;
    await mouseSelect(A, sol[0].r, sol[0].c, ...endOf(sol[0]));
    await touchSelect(B, sol[1].r, sol[1].c, ...endOf(sol[1]));
    await A.waitForFunction((id) => window.CP.state.match.words.find((x) => x.id === id).found, sol[1].id);
    assert.ok(await A.$('svg.marks .mark.o'), 'marca rosa (Bernardete) no ecrã do Alberto');
    assert.ok(await B.$('svg.marks .mark.x'), 'marca azul (Alberto) no ecrã da Bernardete');
    await shot(A, '15-juntos-desktop');
    await shot(B, '16-juntos-telemovel');
  });

  await step('reconexão: recarregar a página recupera a sala e a partida', async () => {
    await B.reload();
    await B.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
    const st = await state(B);
    assert.equal(st.phase, 'playing');
    assert.ok(st.match.words.find((x) => x.id === sol[0].id).found);
  });

  await step('modo escuro', async () => {
    await A.click('#btn-theme');
    await wait(500);
    await shot(A, '17-escuro');
    assert.equal(await A.evaluate(() => document.body.dataset.theme), 'dark');
  });

  await step('painel: entrada, resumo e pré-visualização', async () => {
    const P = await ctxA.newPage();
    await P.goto(`${URL}/admin`);
    await P.fill('#login-pass', 'e2e-segredo');
    await P.click('#login-form button');
    await P.waitForSelector('#app:not([hidden]) .stat');
    await shot(P, '18-painel-resumo');
    await P.click('[data-tab="words"]');
    await P.waitForSelector('#pv-go');
    await P.click('#pv-go');
    await P.waitForSelector('#pv-board .cell');
    await shot(P, '19-painel-palavras');
    await P.click('[data-tab="settings"]');
    await P.waitForSelector('.set-row');
    await shot(P, '20-painel-definicoes');
  });

  await step('sem erros de JavaScript nas páginas', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close();
  server.kill();
  try {
    fs.unlinkSync(DB);
  } catch {
    /* nada */
  }
  const failed = results.filter((r) => r[0] === '✘');
  console.log(`\n${results.length - failed.length}/${results.length} passos concluídos. Capturas em ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})();
