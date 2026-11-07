/* ==========================================================================
   Grelha de letras: desenho, marcas de marcador e seleção.
   - Rato: carregar, arrastar e largar.
   - Toque: arrastar (também em diagonal) sem deslocar a página; ou tocar na
     primeira e na última letra.
   - Teclado: setas para mover, Enter/Espaço para marcar início e fim, Esc cancela.
   A seleção encaixa sempre numa das 8 direções. Quem decide se está certa é o servidor.
   ========================================================================== */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const DIRS = [
    [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
  ];

  function create(el, opts = {}) {
    const o = { interactive: true, seatClass: 'x', onSelect: null, ...opts };
    let n = 0;
    let rowsSig = '';
    let cells = [];
    let svg = null;
    let gMarks = null;
    let gSel = null;
    let gZone = null;
    let cellSize = 0;
    let known = new Set();
    let lastWords = [];
    let drag = null;
    let anchor = null;
    let cursor = { r: 0, c: 0 };
    let enabled = true;
    let pending = false;
    let highlights = [];

    /* ---------------- construção ---------------- */
    function build(rows) {
      n = rows.length;
      el.style.setProperty('--n', n);
      el.innerHTML = '';
      cells = [];
      svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'marks');
      svg.setAttribute('aria-hidden', 'true');
      gZone = document.createElementNS(SVGNS, 'g');
      gMarks = document.createElementNS(SVGNS, 'g');
      gSel = document.createElementNS(SVGNS, 'g');
      svg.append(gZone, gMarks, gSel);
      el.appendChild(svg);
      for (let r = 0; r < n; r++) {
        cells[r] = [];
        for (let c = 0; c < n; c++) {
          const d = document.createElement('div');
          d.className = 'cell';
          d.textContent = rows[r][c];
          d.setAttribute('role', 'gridcell');
          el.appendChild(d);
          cells[r][c] = d;
        }
      }
      known = new Set();
      anchor = null;
      cursor = { r: 0, c: 0 };
      layout();
    }

    function metrics() {
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) || 0;
      const inner = el.clientWidth - pad * 2;
      return { pad, size: inner / Math.max(1, n) };
    }

    function layout() {
      if (!n) return;
      const { size } = metrics();
      cellSize = size;
      el.style.setProperty('--fs', `${Math.max(9, Math.min(34, size * 0.56)).toFixed(1)}px`);
      svg.setAttribute('viewBox', `0 0 ${el.clientWidth} ${el.clientHeight}`);
      drawMarks(lastWords, true);
      drawSelection();
    }

    function center(r, c) {
      const { pad, size } = metrics();
      return [pad + (c + 0.5) * size, pad + (r + 0.5) * size];
    }

    function line(r1, c1, r2, c2, cls) {
      const [x1, y1] = center(r1, c1);
      const [x2, y2] = center(r2, c2);
      const p = document.createElementNS(SVGNS, 'line');
      p.setAttribute('x1', x1);
      p.setAttribute('y1', y1);
      p.setAttribute('x2', x2);
      p.setAttribute('y2', y2);
      p.setAttribute('class', cls);
      p.setAttribute('stroke-width', (cellSize * 0.78).toFixed(1));
      return p;
    }

    /* ---------------- marcas ---------------- */
    function drawMarks(words, silent) {
      lastWords = words || [];
      if (!gMarks) return;
      gMarks.innerHTML = '';
      for (const w of lastWords) {
        if (!w.cells || !w.cells.length || !w.markClass) continue;
        const a = w.cells[0];
        const b = w.cells[w.cells.length - 1];
        const isNew = !silent && !known.has(w.id) && w.animate;
        const ln = line(a[0], a[1], b[0], b[1], `mark ${w.markClass}${isNew ? ' new' : ''}`);
        if (isNew) {
          const len = Math.hypot(Number(ln.getAttribute('x2')) - Number(ln.getAttribute('x1')), Number(ln.getAttribute('y2')) - Number(ln.getAttribute('y1'))) + cellSize;
          ln.style.setProperty('--len', len);
          ln.setAttribute('stroke-dasharray', len);
        }
        gMarks.appendChild(ln);
      }
      known = new Set(lastWords.filter((w) => w.cells && w.markClass).map((w) => w.id));
    }

    /* ---------------- seleção ---------------- */
    function snap(a, b) {
      const dr = b.r - a.r;
      const dc = b.c - a.c;
      if (!dr && !dc) return { r: a.r, c: a.c, len: 0 };
      const k = ((Math.round(Math.atan2(dr, dc) / (Math.PI / 4)) % 8) + 8) % 8;
      const [sr, sc] = DIRS[k];
      let len = Math.round((dr * sr + dc * sc) / (sr * sr + sc * sc));
      len = Math.max(0, len);
      while (len > 0 && (a.r + sr * len < 0 || a.r + sr * len >= n || a.c + sc * len < 0 || a.c + sc * len >= n)) len--;
      return { r: a.r + sr * len, c: a.c + sc * len, len };
    }

    function drawSelection(bad) {
      if (!gSel) return;
      gSel.innerHTML = '';
      for (const row of cells) for (const d of row) d.classList.remove('anchor', 'cursor');
      const cls = `sel me-${o.seatClass}${bad ? ' bad' : ''}`;
      if (drag) {
        gSel.appendChild(line(drag.start.r, drag.start.c, drag.end.r, drag.end.c, cls));
      } else if (anchor) {
        cells[anchor.r][anchor.c].classList.add('anchor');
        if (el.dataset.kbd === '1') {
          const e = snap(anchor, cursor);
          gSel.appendChild(line(anchor.r, anchor.c, e.r, e.c, cls));
        }
      } else if (bad) {
        gSel.appendChild(line(bad.r1, bad.c1, bad.r2, bad.c2, cls));
      }
      if (el.dataset.kbd === '1' && cells[cursor.r]) cells[cursor.r][cursor.c].classList.add('cursor');
      for (const h of highlights) if (cells[h.r] && cells[h.r][h.c]) cells[h.r][h.c].classList.add('hl-letter');
    }

    function cellAt(x, y, clamp) {
      const rect = el.getBoundingClientRect();
      const { pad, size } = metrics();
      let c = Math.floor((x - rect.left - pad) / size);
      let r = Math.floor((y - rect.top - pad) / size);
      if (clamp) {
        r = Math.max(0, Math.min(n - 1, r));
        c = Math.max(0, Math.min(n - 1, c));
      } else if (r < 0 || c < 0 || r >= n || c >= n) return null;
      return { r, c };
    }

    async function submit(a, b) {
      if (!o.onSelect || pending) return;
      const sel = { r1: a.r, c1: a.c, r2: b.r, c2: b.c };
      pending = true;
      drag = { start: a, end: b };
      drawSelection();
      let res = null;
      try {
        res = await o.onSelect(sel);
      } finally {
        pending = false;
        drag = null;
      }
      if (res === 'wrong') {
        drawSelection(sel);
        setTimeout(() => drawSelection(), 450);
      } else drawSelection();
    }

    el.addEventListener('pointerdown', (e) => {
      if (!o.interactive || !enabled || pending || !n || e.button > 0) return;
      const at = cellAt(e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      el.dataset.kbd = '0';
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* sem captura neste navegador */
      }
      drag = { start: at, end: at, moved: false, id: e.pointerId };
      drawSelection();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId || pending) return;
      e.preventDefault();
      const at = cellAt(e.clientX, e.clientY, true);
      const s = snap(drag.start, at);
      if (s.r !== drag.end.r || s.c !== drag.end.c) {
        drag.end = { r: s.r, c: s.c };
        drag.moved = true;
        drawSelection();
      }
    });
    function endDrag(e) {
      if (!drag || drag.id !== e.pointerId || pending) return;
      const d = drag;
      drag = null;
      if (d.moved && (d.end.r !== d.start.r || d.end.c !== d.start.c)) {
        anchor = null;
        submit(d.start, d.end);
        return;
      }
      // toque simples: primeira letra, depois a última
      if (anchor && (anchor.r !== d.start.r || anchor.c !== d.start.c)) {
        const s = snap(anchor, d.start);
        const a = anchor;
        anchor = null;
        if (s.len > 0) submit(a, s);
        else drawSelection();
      } else if (anchor) {
        anchor = null;
        drawSelection();
      } else {
        anchor = d.start;
        drawSelection();
      }
    }
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', (e) => {
      if (drag && drag.id === e.pointerId) {
        drag = null;
        drawSelection();
      }
    });
    // impedir que o toque desloque a página durante a seleção (iOS antigo)
    el.addEventListener('touchmove', (e) => { if (o.interactive) e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => o.interactive && e.preventDefault());

    el.addEventListener('keydown', (e) => {
      if (!o.interactive || !n) return;
      const k = e.key;
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[k]) {
        e.preventDefault();
        el.dataset.kbd = '1';
        cursor = { r: Math.max(0, Math.min(n - 1, cursor.r + moves[k][0])), c: Math.max(0, Math.min(n - 1, cursor.c + moves[k][1])) };
        if (o.onCursor) o.onCursor(cursor, cells[cursor.r][cursor.c].textContent, anchor);
        drawSelection();
      } else if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        if (!enabled || pending) return;
        el.dataset.kbd = '1';
        if (!anchor) {
          anchor = { ...cursor };
          if (o.onCursor) o.onCursor(cursor, cells[cursor.r][cursor.c].textContent, anchor);
          drawSelection();
        } else {
          const s = snap(anchor, cursor);
          const a = anchor;
          anchor = null;
          if (s.len > 0) submit(a, s);
          else drawSelection();
        }
      } else if (k === 'Escape') {
        anchor = null;
        drawSelection();
      }
    });
    el.addEventListener('focus', () => {
      if (el.dataset.kbd !== '0') el.dataset.kbd = '1';
      drawSelection();
    });
    el.addEventListener('blur', () => {
      el.dataset.kbd = '0';
      drawSelection();
    });

    const ro = new ResizeObserver(() => layout());
    ro.observe(el);

    return {
      render(rows, words) {
        const sig = rows.join('');
        if (sig !== rowsSig) {
          rowsSig = sig;
          build(rows);
          drawMarks(words, true);
        } else drawMarks(words, false);
        drawSelection();
      },
      setEnabled(v) {
        enabled = !!v;
        if (!enabled) {
          anchor = null;
          drag = null;
          drawSelection();
        }
      },
      setSeatClass(c) {
        o.seatClass = c;
      },
      setHighlights(list) {
        for (const row of cells) for (const d of row) d.classList.remove('hl-letter');
        highlights = list || [];
        drawSelection();
      },
      showZone(z) {
        if (!gZone || !z) return;
        const { pad, size } = metrics();
        const rect = document.createElementNS(SVGNS, 'rect');
        rect.setAttribute('x', pad + z.c0 * size);
        rect.setAttribute('y', pad + z.r0 * size);
        rect.setAttribute('width', (z.c1 - z.c0 + 1) * size);
        rect.setAttribute('height', (z.r1 - z.r0 + 1) * size);
        rect.setAttribute('rx', size * 0.4);
        rect.setAttribute('class', 'zone');
        rect.style.setProperty('--secs', `${z.seconds || 8}s`);
        gZone.appendChild(rect);
        setTimeout(() => rect.remove(), (z.seconds || 8) * 1000 + 200);
      },
      flash() {
        el.classList.remove('found-flash');
        void el.offsetWidth;
        el.classList.add('found-flash');
      },
      reset() {
        rowsSig = '';
        known = new Set();
      },
      get size() {
        return n;
      },
    };
  }

  window.WordGrid = { create };
})();
