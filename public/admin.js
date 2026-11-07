/* ==========================================================================
   Painel de administração. A palavra-passe nunca fica no navegador: a sessão
   é um cookie HttpOnly e todas as operações são verificadas no servidor.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.Charts.esc;
  const view = $('#view');
  const DIR = { E: [0, 1], W: [0, -1], S: [1, 0], N: [-1, 0], SE: [1, 1], NE: [-1, 1], SW: [1, -1], NW: [-1, -1] };
  const DIFFS = { facil: 'Fácil', medio: 'Médio', dificil: 'Difícil', especialista: 'Especialista' };
  const SCHED = { always: 'Sempre', daily: 'Diário (mesma grelha para todos, por dia)', weekend: 'Só ao fim de semana' };
  let tab = 'overview';
  let cats = [];
  let selCat = null;

  /* ---------------- utilitários ---------------- */
  function toast(text, bad) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ' good'}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
  async function api(method, path, body) {
    const opt = { method, headers: { 'X-Requested-With': 'caca-palavras' }, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`/api/admin${path}`, opt);
    } catch {
      toast('Sem ligação ao servidor.', true);
      return { ok: false };
    }
    const data = await res.json().catch(() => ({ ok: false }));
    if (res.status === 401 && path !== '/login') {
      showLogin();
      return { ok: false };
    }
    if (!data.ok && data.ok !== undefined) data.message = data.message || (data.errors || []).join(' ') || 'Operação recusada.';
    return data;
  }
  const fmtDate = (t) => (t ? new Date(Number(t)).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtTime = (ms) => {
    const s = Math.round((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  function modal(html) {
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
  }
  const closeModal = () => ($('#modal').hidden = true);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.id === 'modal') closeModal();
  });
  async function typed(word, text) {
    const v = prompt(`${text}\n\nPara confirmar, escreva ${word}:`);
    return v === word;
  }

  /* ---------------- tema ---------------- */
  const theme = (() => {
    try {
      return JSON.parse(localStorage.getItem('cp_theme')) || 'light';
    } catch {
      return 'light';
    }
  })();
  document.body.dataset.theme = theme;
  $('#btn-theme').addEventListener('click', () => {
    const t = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = t;
    try {
      localStorage.setItem('cp_theme', JSON.stringify(t));
    } catch {
      /* sem armazenamento */
    }
  });

  /* ---------------- sessão ---------------- */
  function showLogin() {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-pass').focus();
  }
  async function boot() {
    const s = await api('GET', '/session');
    if (!s.configured) {
      showLogin();
      $('#login-error').textContent = 'A administração está desativada: defina ADMIN_PASSWORD (mínimo 6 caracteres) no servidor.';
      return;
    }
    if (!s.authenticated) return showLogin();
    $('#login').hidden = true;
    $('#app').hidden = false;
    go(location.hash.slice(1) || 'overview');
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    const r = await api('POST', '/login', { password: $('#login-pass').value });
    $('#login-pass').value = '';
    if (!r.ok) return ($('#login-error').textContent = r.message);
    boot();
  });
  $('#btn-logout').addEventListener('click', async () => {
    await api('POST', '/logout', {});
    showLogin();
  });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) go(b.dataset.tab);
  });
  function go(t) {
    tab = RENDER[t] ? t : 'overview';
    location.hash = tab;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    view.innerHTML = '<p class="muted">A carregar…</p>';
    RENDER[tab]();
  }

  /* ===================================================================== */
  /* Resumo                                                                 */
  /* ===================================================================== */
  async function overview() {
    const s = await api('GET', '/stats');
    if (!s.ok) return;
    const t = s.totals;
    const days = Object.entries(s.perDay);
    const max = Math.max(1, ...days.map(([, v]) => v));
    view.innerHTML = `
      <div class="section-head"><div><h2>Resumo</h2><p class="muted">Dados reais guardados na base de dados.</p></div><button class="btn btn-ghost btn-sm" id="ov-refresh">Atualizar</button></div>
      <div class="stat-grid">
        <div class="stat"><b>${s.live.online}</b><span>jogadores ligados agora</span></div>
        <div class="stat"><b>${s.live.playing}</b><span>partidas a decorrer</span></div>
        <div class="stat"><b>${t.matches}</b><span>partidas terminadas</span></div>
        <div class="stat"><b>${t.coop} / ${t.versus}</b><span>juntos / desafio</span></div>
        <div class="stat"><b>${t.coopWins}</b><span>vitórias a dois</span></div>
        <div class="stat"><b>${t.draws}</b><span>empates</span></div>
        <div class="stat"><b>${t.words}</b><span>palavras encontradas</span></div>
        <div class="stat"><b>${t.hints}</b><span>pistas usadas</span></div>
        <div class="stat"><b>${t.bestScore}</b><span>melhor pontuação</span></div>
        <div class="stat"><b>${fmtTime(t.avgMs)}</b><span>duração média</span></div>
        <div class="stat"><b>${s.rooms} <small class="muted">(${s.openRooms} abertas)</small></b><span>salas</span></div>
        <div class="stat"><b>${s.players}</b><span>jogadores (navegadores)</span></div>
        <div class="stat"><b>${s.words}</b><span>palavras em ${s.categories} categorias</span></div>
      </div>
      <div class="cols" style="margin-top:16px">
        <div class="panel"><h3>Partidas nos últimos 14 dias</h3><div class="mini-bars">${days.map(([d, v]) => `<div style="height:${(v / max) * 100}%" title="${d}: ${v}"><b>${v || ''}</b><span>${d.slice(8)}</span></div>`).join('')}</div><div style="height:16px"></div></div>
        <div class="panel"><h3>Categorias mais jogadas</h3>${window.Charts.bars(Object.entries(s.byCategory).map(([label, value]) => ({ label, value })))}</div>
        <div class="panel"><h3>Dificuldade</h3>${window.Charts.bars(Object.entries(s.byDifficulty).map(([k, value]) => ({ label: DIFFS[k] || k, value })), { color: 'var(--coral)' })}</div>
      </div>
      <div class="cols" style="margin-top:16px">
        <div class="panel"><h3>Salas ativas agora</h3>${s.live.rooms.length ? `<table class="tbl">${s.live.rooms.map((r) => `<tr><td><b>${esc(r.code)}</b></td><td>${esc(r.names)}</td><td class="muted">${esc(r.what)}</td></tr>`).join('')}</table>` : '<p class="muted">Ninguém a jogar neste momento.</p>'}</div>
        <div class="panel"><h3>Últimas partidas</h3>${matchTable(s.recent)}</div>
      </div>`;
    $('#ov-refresh').onclick = overview;
  }

  function matchTable(list) {
    if (!list.length) return '<p class="muted">Ainda sem partidas.</p>';
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Data</th><th>Sala</th><th>Modo</th><th>Categoria</th><th>Grelha</th><th>Resultado</th><th>Tempo</th><th>Estado</th></tr></thead><tbody>${list
      .map(
        (m) => `<tr class="click" data-match="${esc(m.id)}"><td>${fmtDate(m.finishedAt)}</td><td>${esc(m.room)}</td><td>${m.mode === 'coop' ? '🤝 Juntos' : '⚔️ Desafio'}</td><td>${esc(m.category)}${m.challenge ? ` <span class="lbl warn">${esc(m.challenge)}</span>` : ''}</td><td>${m.size}×${m.size} · ${DIFFS[m.difficulty] || m.difficulty}</td><td>${m.mode === 'coop' ? `${esc(m.names.X)} & ${esc(m.names.O)}: <b>${m.scores.team ?? 0}</b>` : `${esc(m.names.X)} <b>${m.scores.X}</b> – <b>${m.scores.O}</b> ${esc(m.names.O)}`}</td><td>${fmtTime(m.elapsedMs)}</td><td>${statusLabel(m)}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
  }
  function statusLabel(m) {
    if (m.status === 'abandoned') return '<span class="lbl bad">interrompida</span>';
    if (m.status === 'timeout') return '<span class="lbl warn">tempo esgotado</span>';
    if (m.mode === 'versus') return m.winner === 'draw' ? '<span class="lbl">empate</span>' : `<span class="lbl ok">venceu ${esc(m.names[m.winner] || '')}</span>`;
    return '<span class="lbl ok">completa</span>';
  }
  view.addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-match]');
    if (!tr) return;
    const r = await api('GET', `/matches/${encodeURIComponent(tr.dataset.match)}`);
    if (!r.ok) return toast(r.message, true);
    const m = r.match;
    const a = r.audit || {};
    modal(`<h2>Partida ${esc(m.id)}</h2>
      <p class="muted">${fmtDate(m.finishedAt)} · sala ${esc(m.room)} · ${m.mode === 'coop' ? 'Juntos' : 'Desafio'} · ${esc(m.category)} · ${m.size}×${m.size} · ${DIFFS[m.difficulty] || ''}</p>
      <p><span class="lbl ${a.ok ? 'ok' : 'bad'}">${a.ok ? 'Auditoria: grelha válida' : 'Auditoria: problemas'}</span> <span class="small muted">semente <code>${esc(m.seed)}</code> · assinatura <code>${esc(String(m.signature || '').slice(0, 16))}…</code></span></p>
      ${a.ok ? '' : `<p class="form-msg">${esc((a.errors || []).join(' '))}</p>`}
      <div class="preview"><div class="board review" id="mb"></div><div><table class="tbl"><thead><tr><th>Palavra</th><th>Posição</th></tr></thead><tbody>${m.words.map((w) => `<tr><td>${esc(w.display)}${w.secret ? ' <span class="lbl warn">secreta</span>' : ''}</td><td class="muted small">linha ${w.r + 1}, col. ${w.c + 1}, ${esc(w.dir)}</td></tr>`).join('')}</tbody></table>
      <pre class="log" style="margin-top:12px;white-space:pre-wrap">${esc(JSON.stringify(m.result, null, 2))}</pre></div></div>`);
    drawGrid($('#mb'), m.rows, m.words);
  });

  function drawGrid(el, rows, words) {
    const g = window.WordGrid.create(el, { interactive: false });
    const marks = words.map((w, i) => ({ id: w.id || String(i), cells: Array.from({ length: w.len }, (_, k) => [w.r + DIR[w.dir][0] * k, w.c + DIR[w.dir][1] * k]), markClass: i % 2 ? 'o' : 'x' }));
    requestAnimationFrame(() => g.render(rows, marks));
  }

  /* ===================================================================== */
  /* Salas                                                                  */
  /* ===================================================================== */
  async function rooms() {
    const r = await api('GET', '/rooms');
    if (!r.ok) return;
    const phase = { lobby: 'sala de espera', playing: 'a jogar', finished: 'resultados' };
    view.innerHTML = `
      <div class="section-head"><div><h2>Salas</h2><p class="muted">Cada sala tem dois lugares. Ninguém mais consegue entrar quando estão ocupados.</p></div>
        <form id="room-new" class="row-actions" style="margin:0"><input id="room-label" placeholder="Nome da sala (opcional)" maxlength="40" class="field" style="padding:9px 12px;border-radius:11px;border:1.5px solid var(--line-2);background:var(--card-solid)" /><button class="btn btn-primary btn-sm">Criar sala</button></form></div>
      <div class="panel tbl-wrap">${
        r.rooms.length
          ? `<table class="tbl"><thead><tr><th>Código</th><th>Nome</th><th>Jogadores</th><th>Estado</th><th>Partidas</th><th>Última atividade</th><th></th></tr></thead><tbody>${r.rooms
              .map((x) => {
                const players = ['X', 'O'].map((s) => (x.seats[s] ? `<span class="dot ${x.seats[s].connected ? 'on' : ''}"></span>${esc(x.seats[s].name)}` : '<span class="muted">livre</span>')).join(' · ');
                const cur = x.current && x.current.status === 'playing' ? `<br><small class="muted">${esc(x.current.category)} ${x.current.size}×${x.current.size} · ${x.current.found}/${x.current.total}</small>` : '';
                return `<tr><td><b>${esc(x.code)}</b></td><td>${esc(x.label || '')}</td><td>${players}</td><td>${x.status === 'closed' ? '<span class="lbl bad">encerrada</span>' : `<span class="lbl">${phase[x.phase] || x.phase}</span>`}${cur}</td><td>${x.stats.matches || 0}</td><td>${fmtDate(x.lastActivity)}</td>
                <td class="actions"><button class="btn btn-ghost btn-sm" data-copy="${esc(x.inviteUrl)}">Copiar convite</button>
                ${x.status === 'closed' ? `<button class="btn btn-ghost btn-sm" data-act="reopen" data-code="${x.code}">Reabrir</button>` : `<button class="btn btn-ghost btn-sm" data-act="close" data-code="${x.code}">Encerrar</button>`}
                <button class="btn btn-ghost btn-sm" data-act="clear-history" data-code="${x.code}">Apagar histórico</button>
                <button class="btn btn-danger btn-sm" data-act="delete" data-code="${x.code}">Eliminar</button></td></tr>`;
              })
              .join('')}</tbody></table>`
          : '<p class="muted">Ainda não há salas.</p>'
      }</div>`;
    $('#room-new').onsubmit = async (e) => {
      e.preventDefault();
      const res = await api('POST', '/rooms', { label: $('#room-label').value });
      if (!res.ok) return toast(res.message, true);
      toast(`Sala ${res.room.code} criada.`);
      rooms();
    };
    view.onclick = null;
    $$('[data-copy]', view).forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Convite copiado.'), () => prompt('Copie o convite:', b.dataset.copy))));
    $$('[data-act]', view).forEach(
      (b) =>
        (b.onclick = async () => {
          const { act, code } = b.dataset;
          if (act === 'delete' && !confirm(`Eliminar a sala ${code} e todo o seu histórico?`)) return;
          if (act === 'clear-history' && !confirm(`Apagar o histórico de partidas da sala ${code}?`)) return;
          if (act === 'close' && !confirm(`Encerrar a sala ${code}? Os jogadores são desligados.`)) return;
          const res = act === 'delete' ? await api('DELETE', `/rooms/${code}`) : await api('POST', `/rooms/${code}/${act}`, {});
          toast(res.ok ? res.message || 'Feito.' : res.message, !res.ok);
          rooms();
        })
    );
  }

  /* ===================================================================== */
  /* Categorias e palavras                                                  */
  /* ===================================================================== */
  async function wordsTab() {
    const r = await api('GET', '/categories');
    if (!r.ok) return;
    cats = r.categories;
    if (!selCat || !cats.some((c) => c.id === selCat)) selCat = cats[0] && cats[0].id;
    view.innerHTML = `
      <div class="section-head"><div><h2>Categorias e palavras</h2><p class="muted">As palavras são guardadas com acentos; a validação ignora acentos e o «ç». Só letras, de 3 a 20.</p></div>
        <div class="row-actions" style="margin:0"><button class="btn btn-ghost btn-sm" id="btn-dups">Palavras repetidas</button><button class="btn btn-primary btn-sm" id="btn-newcat">Nova categoria</button></div></div>
      <div class="cols-2">
        <div class="panel"><h3>Categorias (${cats.length})</h3><div class="cat-list" id="cat-list"></div></div>
        <div id="cat-detail"></div>
      </div>`;
    renderCatList();
    renderCat();
    $('#btn-newcat').onclick = () => catForm();
    $('#btn-dups').onclick = duplicates;
  }
  function renderCatList() {
    $('#cat-list').innerHTML = cats
      .slice()
      .sort((a, b) => b.special - a.special || a.position - b.position)
      .map((c) => `<button class="cat-item ${c.id === selCat ? 'on' : ''} ${c.active ? '' : 'off'}" data-cat="${esc(c.id)}"><span>${esc(c.icon)}</span><span class="n">${esc(c.name)}</span><small>${c.activeWords}/${c.words}</small>${c.special ? '<span class="lbl warn">especial</span>' : ''}</button>`)
      .join('');
    $('#cat-list').onclick = (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      selCat = b.dataset.cat;
      renderCatList();
      renderCat();
    };
  }
  async function renderCat() {
    const c = cats.find((x) => x.id === selCat);
    const box = $('#cat-detail');
    if (!c) return (box.innerHTML = '');
    const r = await api('GET', `/categories/${encodeURIComponent(c.id)}/words`);
    const list = r.ok ? r.words : [];
    box.innerHTML = `
      <div class="panel">
        <div class="section-head" style="margin-bottom:8px"><div><h3 style="margin:0">${esc(c.icon)} ${esc(c.name)} ${c.active ? '<span class="lbl ok">ativa</span>' : '<span class="lbl bad">desativada</span>'}</h3><p class="muted small">${esc(c.description || '')}</p></div>
          <div class="row-actions" style="margin:0">
            <button class="btn btn-ghost btn-sm" id="cat-edit">Editar</button>
            <button class="btn btn-ghost btn-sm" id="cat-toggle">${c.active ? 'Desativar' : 'Ativar'}</button>
            <button class="btn btn-danger btn-sm" id="cat-del">Eliminar</button></div></div>
        <div class="row-actions"><select id="pv-size" class="select" style="width:auto">${[8, 10, 12, 15, 18, 20].map((n) => `<option value="${n}" ${n === 12 ? 'selected' : ''}>${n}×${n}</option>`).join('')}</select><select id="pv-diff" class="select" style="width:auto">${Object.entries(DIFFS).map(([k, v]) => `<option value="${k}" ${k === 'medio' ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="btn btn-soft btn-sm" id="pv-go">Pré-visualizar uma grelha</button></div>
        <div id="pv-out"></div>
      </div>
      <div class="panel">
        <h3>Acrescentar palavras</h3>
        <p class="muted small">Uma por linha (ou separadas por «;»). Para uma dica (usada nas palavras secretas): <code>palavra :: dica</code>. Pode colar listas grandes (até 5000 linhas).</p>
        <label class="field"><textarea id="add-words" placeholder="Saudade :: Sentimento muito português&#10;Bacalhau&#10;Pão de queijo"></textarea></label>
        <div class="row-actions"><button class="btn btn-primary btn-sm" id="add-go">Importar</button><span class="small" id="add-out"></span></div>
      </div>
      <div class="panel">
        <div class="section-head" style="margin-bottom:8px"><h3 style="margin:0">Palavras (${list.length})</h3><input id="w-filter" placeholder="Procurar…" style="padding:7px 10px;border-radius:10px;border:1.5px solid var(--line-2);background:var(--card-solid)" /></div>
        <div class="tbl-wrap" style="max-height:60vh;overflow:auto"><table class="tbl"><thead><tr><th>Palavra</th><th>Dica</th><th>Ativa</th><th></th></tr></thead><tbody id="w-body">${list
          .map((w) => `<tr data-id="${esc(w.id)}" data-norm="${esc(w.norm)}"><td><input type="text" value="${esc(w.display)}" data-f="display" /></td><td><input type="text" value="${esc(w.hint || '')}" data-f="hint" placeholder="—" /></td><td><input type="checkbox" data-f="active" ${w.active ? 'checked' : ''} /></td><td class="actions"><button class="btn btn-ghost btn-sm" data-del>Eliminar</button></td></tr>`)
          .join('')}</tbody></table></div>
        <p class="muted small">As alterações a uma palavra são guardadas ao sair do campo.</p>
      </div>`;
    $('#cat-edit').onclick = () => catForm(c);
    $('#cat-toggle').onclick = async () => {
      const res = await api('PUT', `/categories/${encodeURIComponent(c.id)}`, { active: !c.active });
      toast(res.ok ? 'Categoria atualizada.' : res.message, !res.ok);
      wordsTab();
    };
    $('#cat-del').onclick = async () => {
      if (!(await typed('ELIMINAR', `Eliminar a categoria «${c.name}» e as suas ${c.words} palavras?`))) return;
      const res = await api('DELETE', `/categories/${encodeURIComponent(c.id)}`);
      toast(res.ok ? 'Categoria eliminada.' : res.message, !res.ok);
      selCat = null;
      wordsTab();
    };
    $('#pv-go').onclick = async () => {
      const res = await api('POST', '/preview', { categoryId: c.id, size: Number($('#pv-size').value), difficulty: $('#pv-diff').value });
      if (!res.ok) return ($('#pv-out').innerHTML = `<p class="form-msg">${esc(res.message)}</p>`);
      const g = res.grid;
      $('#pv-out').innerHTML = `<div class="preview"><div class="board review" id="pv-board"></div><div><p><span class="lbl ${res.verify.ok ? 'ok' : 'bad'}">${res.verify.ok ? 'Verificação: cada palavra aparece exatamente uma vez' : 'Verificação falhou'}</span></p><p class="small muted">Semente <code>${esc(g.seed)}</code> · ${g.words.length} palavras · tentativa ${g.attempt}</p><p class="small">${g.words.map((w) => `${esc(w.display)}${w.secret ? ' (secreta)' : ''} <span class="muted">${esc(w.dir)}</span>`).join(' · ')}</p></div></div>`;
      drawGrid($('#pv-board'), g.rows, g.words);
    };
    $('#add-go').onclick = async () => {
      const text = $('#add-words').value;
      if (!text.trim()) return;
      const res = await api('POST', `/categories/${encodeURIComponent(c.id)}/words`, { text });
      if (!res.ok) return toast(res.message, true);
      $('#add-out').innerHTML = `<b>${res.added}</b> acrescentada(s).${res.skipped.length ? ` Ignoradas ${res.skipped.length}: ${res.skipped.slice(0, 12).map((s) => `${esc(s.word)} (${esc(s.reason)})`).join(', ')}${res.skipped.length > 12 ? '…' : ''}` : ''}`;
      $('#add-words').value = '';
      const keep = $('#add-out').innerHTML;
      const rr = await api('GET', '/categories');
      if (rr.ok) cats = rr.categories;
      renderCatList();
      await renderCat();
      $('#add-out').innerHTML = keep;
    };
    $('#w-filter').oninput = (e) => {
      const q = e.target.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      $$('#w-body tr').forEach((tr) => (tr.hidden = q && !tr.dataset.norm.toLowerCase().includes(q)));
    };
    $('#w-body').addEventListener('change', async (e) => {
      const tr = e.target.closest('tr');
      const f = e.target.dataset.f;
      if (!tr || !f) return;
      const val = f === 'active' ? e.target.checked : e.target.value;
      const res = await api('PUT', `/words/${encodeURIComponent(tr.dataset.id)}`, { [f]: val });
      toast(res.ok ? 'Palavra guardada.' : res.message, !res.ok);
    });
    $('#w-body').addEventListener('click', async (e) => {
      if (!e.target.closest('[data-del]')) return;
      const tr = e.target.closest('tr');
      const res = await api('DELETE', `/words/${encodeURIComponent(tr.dataset.id)}`);
      if (res.ok) tr.remove();
      toast(res.ok ? 'Palavra eliminada.' : res.message, !res.ok);
    });
  }
  function catForm(c) {
    modal(`<h2>${c ? 'Editar categoria' : 'Nova categoria'}</h2>
      <form id="cat-form" class="stack">
        <div class="form-grid"><label class="field"><span>Nome</span><input name="name" maxlength="40" required value="${esc(c ? c.name : '')}" /></label>
        <label class="field"><span>Ícone (emoji)</span><input name="icon" maxlength="8" value="${esc(c ? c.icon : '🔤')}" /></label>
        ${c ? `<label class="field"><span>Posição</span><input name="position" type="number" min="0" max="999" value="${c.position}" /></label>` : ''}</div>
        <label class="field"><span>Descrição</span><input name="description" maxlength="200" value="${esc(c ? c.description : '')}" /></label>
        ${c ? '' : '<label class="field"><span>Palavras (opcional, uma por linha)</span><textarea name="words"></textarea></label>'}
        <div class="row-actions"><button class="btn btn-primary">${c ? 'Guardar' : 'Criar'}</button><span class="form-msg" id="cat-msg"></span></div>
      </form>`);
    $('#cat-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      if (fd.position !== undefined) fd.position = Number(fd.position);
      const res = c ? await api('PUT', `/categories/${encodeURIComponent(c.id)}`, fd) : await api('POST', '/categories', fd);
      if (!res.ok) return ($('#cat-msg').textContent = res.message);
      closeModal();
      if (!c) selCat = res.id;
      toast(c ? 'Categoria guardada.' : 'Categoria criada.');
      wordsTab();
    };
  }
  async function duplicates() {
    const r = await api('GET', '/duplicates');
    if (!r.ok) return;
    modal(`<h2>Palavras repetidas entre categorias (${r.duplicates.length})</h2>
      <p class="muted small">Repetições entre categorias não estragam o jogo (numa grelha nunca aparece a mesma palavra duas vezes), mas pode limpá-las. Dentro da mesma categoria não há repetições: o servidor recusa-as.</p>
      ${r.duplicates.length ? `<div class="row-actions"><label class="field" style="flex-direction:row;display:flex;align-items:center;gap:8px"><span>Manter na categoria:</span><select id="dup-keep"><option value="">a primeira encontrada</option>${cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><button class="btn btn-danger btn-sm" id="dup-go">Remover repetições</button></div>
      <div class="tbl-wrap" style="max-height:55vh;overflow:auto;margin-top:10px"><table class="tbl"><thead><tr><th>Palavra</th><th>Categorias</th></tr></thead><tbody>${r.duplicates.map((d) => `<tr><td><b>${esc(d.list[0].display)}</b></td><td>${d.list.map((x) => esc(x.categoryName)).join(', ')}</td></tr>`).join('')}</tbody></table></div>` : '<p>Não há repetições. ✨</p>'}`);
    const go = $('#dup-go');
    if (go)
      go.onclick = async () => {
        if (!(await typed('ELIMINAR', 'Remover as palavras repetidas (fica uma cópia de cada)?'))) return;
        const res = await api('POST', '/duplicates/remove', { confirm: 'ELIMINAR', keepCategory: $('#dup-keep').value || undefined });
        toast(res.ok ? `${res.deleted} repetições removidas.` : res.message, !res.ok);
        closeModal();
        wordsTab();
      };
  }

  /* ===================================================================== */
  /* Desafios                                                               */
  /* ===================================================================== */
  async function challengesTab() {
    const [r, rc] = await Promise.all([api('GET', '/challenges'), api('GET', '/categories')]);
    if (!r.ok) return;
    cats = rc.ok ? rc.categories : cats;
    const catName = (id) => (id === 'aleatoria' ? 'Aleatória' : id === 'mista' ? 'Todas (mista)' : (cats.find((c) => c.id === id) || {}).name || id);
    view.innerHTML = `
      <div class="section-head"><div><h2>Desafios especiais</h2><p class="muted">Aparecem na sala de espera. O diário usa a mesma grelha para todos durante o dia (hora de Lisboa).</p></div><button class="btn btn-primary btn-sm" id="ch-new">Novo desafio</button></div>
      <div class="panel tbl-wrap"><table class="tbl"><thead><tr><th>Nome</th><th>Grelha</th><th>Categoria</th><th>Tempo</th><th>Palavras</th><th>Pontos</th><th>Agenda</th><th>Ativo</th><th></th></tr></thead><tbody>${r.challenges
        .map((c) => `<tr><td><b>${esc(c.name)}</b><br><small class="muted">${esc(c.description || '')}</small></td><td>${c.config.size}×${c.config.size} · ${DIFFS[c.config.difficulty]}</td><td>${esc(catName(c.config.category))}</td><td>${c.config.seconds ? fmtTime(c.config.seconds * 1000) : 'sem limite'}</td><td>${c.config.words || 'auto'}</td><td>×${c.config.multiplier}</td><td>${esc(SCHED[c.config.schedule] || c.config.schedule)}</td><td><input type="checkbox" data-active="${esc(c.id)}" ${c.active ? 'checked' : ''} /></td><td class="actions"><button class="btn btn-ghost btn-sm" data-edit="${esc(c.id)}">Editar</button><button class="btn btn-danger btn-sm" data-delch="${esc(c.id)}">Eliminar</button></td></tr>`)
        .join('')}</tbody></table></div>`;
    $('#ch-new').onclick = () => chForm(null, catName);
    $$('[data-edit]').forEach((b) => (b.onclick = () => chForm(r.challenges.find((c) => c.id === b.dataset.edit), catName)));
    $$('[data-active]').forEach(
      (b) =>
        (b.onchange = async () => {
          const res = await api('POST', `/challenges/${encodeURIComponent(b.dataset.active)}/active`, { active: b.checked });
          toast(res.ok ? 'Desafio atualizado.' : res.message, !res.ok);
        })
    );
    $$('[data-delch]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm('Eliminar este desafio?')) return;
          const res = await api('DELETE', `/challenges/${encodeURIComponent(b.dataset.delch)}`);
          toast(res.ok ? 'Desafio eliminado.' : res.message || 'Não foi possível.', !res.ok);
          challengesTab();
        })
    );
  }
  function chForm(c, catName) {
    const cfg = c ? c.config : { size: 12, difficulty: 'medio', category: 'aleatoria', seconds: 300, words: 0, multiplier: 1, schedule: 'always' };
    const catOpts = ['aleatoria', 'mista', ...cats.map((x) => x.id)];
    modal(`<h2>${c ? 'Editar desafio' : 'Novo desafio'}</h2>
      <form id="ch-form" class="stack">
        <div class="form-grid"><label class="field"><span>Nome</span><input name="name" maxlength="60" required value="${esc(c ? c.name : '')}" /></label>
        <label class="field"><span>Descrição</span><input name="description" maxlength="200" value="${esc(c ? c.description : '')}" /></label></div>
        <div class="form-grid">
          <label class="field"><span>Dimensão (6–26)</span><input name="size" type="number" min="6" max="26" value="${cfg.size}" /></label>
          <label class="field"><span>Dificuldade</span><select name="difficulty">${Object.entries(DIFFS).map(([k, v]) => `<option value="${k}" ${cfg.difficulty === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field"><span>Categoria</span><select name="category">${catOpts.map((id) => `<option value="${esc(id)}" ${cfg.category === id ? 'selected' : ''}>${esc(catName(id))}</option>`).join('')}</select></label>
          <label class="field"><span>Tempo (segundos, 0 = sem limite)</span><input name="seconds" type="number" min="0" max="7200" value="${cfg.seconds}" /></label>
          <label class="field"><span>N.º de palavras (0 = automático)</span><input name="words" type="number" min="0" max="30" value="${cfg.words || 0}" /></label>
          <label class="field"><span>Multiplicador de pontos</span><input name="multiplier" type="number" min="0.5" max="5" step="0.1" value="${cfg.multiplier}" /></label>
          <label class="field"><span>Agenda</span><select name="schedule">${Object.entries(SCHED).map(([k, v]) => `<option value="${k}" ${cfg.schedule === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="active" ${!c || c.active ? 'checked' : ''} /> Ativo</label>
        <div class="row-actions"><button class="btn btn-primary">Guardar</button><span class="form-msg" id="ch-msg"></span></div>
      </form>`);
    $('#ch-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, description: f.description.value, active: f.active.checked, config: { size: Number(f.size.value), difficulty: f.difficulty.value, category: f.category.value, seconds: Number(f.seconds.value), words: Number(f.words.value), multiplier: Number(f.multiplier.value), schedule: f.schedule.value } };
      const res = c ? await api('PUT', `/challenges/${encodeURIComponent(c.id)}`, body) : await api('POST', '/challenges', body);
      if (!res.ok) return ($('#ch-msg').textContent = res.message);
      closeModal();
      toast('Desafio guardado.');
      challengesTab();
    };
  }

  /* ===================================================================== */
  /* Partidas e jogadores                                                    */
  /* ===================================================================== */
  async function matchesTab(filter = {}) {
    const q = new URLSearchParams(filter).toString();
    const r = await api('GET', `/matches${q ? `?${q}` : ''}`);
    if (!r.ok) return;
    view.innerHTML = `
      <div class="section-head"><div><h2>Partidas</h2><p class="muted">Últimas 300. Clique numa partida para ver a grelha, a solução e a auditoria (a grelha é reconstruída e verificada a partir do que foi guardado).</p></div>
        <form id="mf" class="row-actions" style="margin:0"><input name="room" placeholder="Código da sala" maxlength="6" value="${esc(filter.room || '')}" style="padding:8px 10px;border-radius:10px;border:1.5px solid var(--line-2);background:var(--card-solid);width:140px" /><select name="mode" class="select" style="width:auto"><option value="">Todos os modos</option><option value="coop" ${filter.mode === 'coop' ? 'selected' : ''}>Juntos</option><option value="versus" ${filter.mode === 'versus' ? 'selected' : ''}>Desafio</option></select><button class="btn btn-ghost btn-sm">Filtrar</button></form></div>
      <div class="panel">${matchTable(r.matches)}</div>`;
    $('#mf').onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(Object.entries(Object.fromEntries(new FormData(e.target))).filter(([, v]) => v));
      matchesTab(f);
    };
  }
  async function playersTab() {
    const r = await api('GET', '/players');
    if (!r.ok) return;
    view.innerHTML = `
      <div class="section-head"><div><h2>Jogadores</h2><p class="muted">Não há contas: cada navegador tem uma identificação anónima, usada só para estatísticas e para não repetir palavras.</p></div></div>
      <div class="panel tbl-wrap">${
        r.players.length
          ? `<table class="tbl"><thead><tr><th>Nome</th><th>Desde</th><th>Último acesso</th><th>Partidas</th><th>Vitórias (desafio)</th><th>Vitórias juntos</th><th>Empates</th><th>Palavras</th><th>Melhor</th><th>Precisão</th></tr></thead><tbody>${r.players.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${fmtDate(p.since)}</td><td>${fmtDate(p.lastSeen)}</td><td>${p.matches}</td><td>${p.winsIndividual}</td><td>${p.coopWins}</td><td>${p.draws}</td><td>${p.words}</td><td>${p.best}</td><td>${p.accuracy !== null ? `${p.accuracy}%` : '—'}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">Ainda sem jogadores.</p>'
      }</div>`;
  }

  /* ===================================================================== */
  /* Definições                                                             */
  /* ===================================================================== */
  const GROUPS = [
    ['Textos e mensagens', ['welcomeMessage', 'dedication', 'specialPhrase', 'closingMessage', 'msgFound', 'msgLead', 'msgSecret', 'msgAlmost', 'quickMessages']],
    ['Modo especial Portugal ❤️ Brasil', ['specialGameMessage', 'specialVictory', 'specialSignature']],
    ['Pontuação', ['pointsShort', 'pointsMedium', 'pointsLong', 'pointsVeryLong', 'secretBonus', 'completionBonus', 'firstFinishBonus', 'speedBonusPerSecond', 'parSecondsPerWord', 'wrongPenalty']],
    ['Pistas', ['hintLetterCost', 'hintDirectionCost', 'hintZoneCost', 'hintTextCost', 'hintRevealCost', 'allowReveal', 'maxHintsFacil', 'maxHintsMedio', 'maxHintsDificil', 'maxHintsEspecialista', 'zoneSeconds']],
    ['Tempo e grelhas', ['minutesFacil', 'minutesMedio', 'minutesDificil', 'minutesEspecialista', 'lowTimeSeconds', 'pauseMode', 'extraSizes']],
    ['Salas e convívio', ['playersCanCreateRooms', 'chatEnabled', 'reactionsEnabled', 'videoEnabled', 'playersCanClearHistory']],
  ];
  async function settingsTab() {
    const r = await api('GET', '/settings');
    if (!r.ok) return;
    const schema = Object.fromEntries(r.schema.map((s) => [s.key, s]));
    const used = new Set(GROUPS.flatMap(([, k]) => k));
    const groups = GROUPS.concat([['Outras', r.schema.map((s) => s.key).filter((k) => !used.has(k))]]).filter(([, k]) => k.length);
    const input = (k) => {
      const s = schema[k];
      const v = r.settings[k];
      if (!s) return '';
      const id = `set-${k}`;
      let ctl;
      if (s.type === 'bool') ctl = `<label class="check"><input type="checkbox" id="${id}" data-k="${k}" ${v ? 'checked' : ''} /> ${v ? 'Sim' : 'Não'}</label>`;
      else if (s.type === 'enum') ctl = `<select id="${id}" data-k="${k}">${s.values.map((x) => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
      else if (s.type === 'int' || s.type === 'num') ctl = `<input type="number" id="${id}" data-k="${k}" value="${v}" ${s.min !== undefined ? `min="${s.min}"` : ''} ${s.max !== undefined ? `max="${s.max}"` : ''} step="${s.type === 'num' ? '0.1' : '1'}" />`;
      else if (s.type === 'multiline' || s.type === 'lines') ctl = `<textarea id="${id}" data-k="${k}">${esc(Array.isArray(v) ? v.join('\n') : v)}</textarea>${s.type === 'lines' ? '<small class="muted">Uma por linha.</small>' : ''}`;
      else if (s.type === 'sizes') ctl = `<input type="text" id="${id}" data-k="${k}" value="${esc((v || []).join(', '))}" placeholder="ex.: 14, 16" /><small class="muted">Números entre 6 e 26, separados por vírgulas.</small>`;
      else ctl = `<input type="text" id="${id}" data-k="${k}" value="${esc(v)}" maxlength="${s.max || 200}" />`;
      return `<div class="set-row"><label for="${id}">${esc(s.label)}</label><div>${ctl}</div></div>`;
    };
    view.innerHTML = `
      <div class="section-head"><div><h2>Definições</h2><p class="muted">Aplicam-se às partidas que começarem depois de guardar (as partidas a decorrer mantêm as regras com que começaram).</p></div><button class="btn btn-ghost btn-sm" id="set-reset">Repor tudo por omissão</button></div>
      <form id="set-form">${groups.map(([title, keys]) => `<div class="panel settings-group"><h3>${esc(title)}</h3>${keys.map(input).join('')}</div>`).join('')}
      <div class="sticky-save"><span class="small muted" id="set-changed" style="margin-right:auto"></span><button class="btn btn-primary" id="set-save">Guardar alterações</button></div></form>`;
    const changed = new Set();
    const form = $('#set-form');
    form.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      changed.add(k);
      e.target.closest('.set-row').classList.add('changed');
      $('#set-changed').textContent = `${changed.size} alteração(ões) por guardar`;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!changed.size) return toast('Nada para guardar.');
      const patch = {};
      for (const k of changed) {
        const el = form.querySelector(`[data-k="${k}"]`);
        const s = schema[k];
        if (s.type === 'bool') patch[k] = el.checked;
        else if (s.type === 'int' || s.type === 'num') patch[k] = Number(el.value);
        else if (s.type === 'lines') patch[k] = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
        else if (s.type === 'sizes') patch[k] = el.value.split(/[,;\s]+/).filter(Boolean).map(Number);
        else patch[k] = el.value;
      }
      const res = await api('PUT', '/settings', patch);
      if (!res.ok) return toast(res.message, true);
      toast('Definições guardadas.');
      settingsTab();
    });
    $('#set-reset').onclick = async () => {
      if (!(await typed('REPOR', 'Repor todas as definições (textos, pontos, pistas, tempos)?'))) return;
      const res = await api('POST', '/settings/reset', {});
      toast(res.ok ? 'Definições repostas.' : res.message, !res.ok);
      settingsTab();
    };
  }

  /* ===================================================================== */
  /* Manutenção                                                             */
  /* ===================================================================== */
  async function maintenance(type = '') {
    const r = await api('GET', '/activity');
    if (!r.ok) return;
    const s = r.server;
    const up = s.uptimeSec;
    const log = r.log.filter((l) => !type || l.type === type);
    view.innerHTML = `
      <div class="section-head"><div><h2>Manutenção e estado do servidor</h2></div><button class="btn btn-ghost btn-sm" id="mt-refresh">Atualizar</button></div>
      <div class="stat-grid">
        <div class="stat"><b>${esc(s.database)}</b><span>base de dados${s.database === 'sqlite' ? ' (só para testes locais)' : ''}</span></div>
        <div class="stat"><b>${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min</b><span>ligado há</span></div>
        <div class="stat"><b>${s.sockets}</b><span>ligações ativas</span></div>
        <div class="stat"><b>${s.memoryMb} MB</b><span>memória</span></div>
        <div class="stat"><b>${esc(s.node)}</b><span>Node.js</span></div>
        <div class="stat"><b>${s.turnConfigured ? 'Sim' : 'Não'}</b><span>servidor TURN configurado</span></div>
        <div class="stat"><b style="color:${s.errors ? 'var(--bad)' : 'inherit'}">${s.errors}</b><span>erros recentes</span></div>
      </div>
      <div class="cols" style="margin-top:16px">
        <div class="panel"><h3>Registo técnico</h3>
          <div class="chips" style="margin-bottom:8px">${['', 'error', 'warn', 'admin', 'game', 'info'].map((t) => `<button class="chip ${t === type ? 'on' : ''}" data-log="${t}">${{ '': 'Tudo', error: 'Erros', warn: 'Avisos', admin: 'Administração', game: 'Jogo', info: 'Info' }[t]}</button>`).join('')}</div>
          <div class="log">${log.length ? log.map((l) => `<div class="${esc(l.type)}">[${fmtDate(l.at)}] ${esc(l.type.toUpperCase())} ${esc(l.message)}</div>`).join('') : '<span class="muted">Sem registos.</span>'}</div>
          <p class="muted small">O registo nunca inclui palavras-passe, códigos de sessão nem as soluções das partidas.</p></div>
        <div>
          <div class="panel"><h3>Apagar dados de teste</h3>
            <p class="small muted">Use antes de começar a jogar «a sério». Não apaga categorias, palavras, desafios nem definições.</p>
            <label class="check"><input type="radio" name="scope" value="history" checked /> Histórico de partidas, estatísticas, chat e jogadores</label>
            <label class="check"><input type="radio" name="scope" value="all" /> Tudo isso e também todas as salas</label>
            <div class="row-actions"><button class="btn btn-danger btn-sm" id="mt-clear">Apagar…</button></div></div>
          <div class="panel"><h3>Sessões</h3><p class="small muted">Termina a sessão do painel em todos os dispositivos.</p><button class="btn btn-ghost btn-sm" id="mt-logout-all">Terminar todas as sessões</button></div>
        </div>
      </div>`;
    $('#mt-refresh').onclick = () => maintenance(type);
    $$('[data-log]').forEach((b) => (b.onclick = () => maintenance(b.dataset.log)));
    $('#mt-clear').onclick = async () => {
      const scope = $('input[name="scope"]:checked').value;
      if (!(await typed('APAGAR', scope === 'all' ? 'Apagar histórico, jogadores e TODAS as salas?' : 'Apagar histórico de partidas, estatísticas, chat e jogadores?'))) return;
      const res = await api('POST', '/clear-test-data', { confirm: 'APAGAR', scope });
      toast(res.ok ? 'Dados apagados.' : res.message, !res.ok);
      maintenance(type);
    };
    $('#mt-logout-all').onclick = async () => {
      if (!confirm('Terminar todas as sessões do painel?')) return;
      await api('POST', '/sessions/logout-all', {});
      showLogin();
    };
  }

  const RENDER = { overview, rooms, words: wordsTab, challenges: challengesTab, matches: () => matchesTab(), players: playersTab, settings: settingsTab, maintenance };
  boot();
})();
