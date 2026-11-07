/* ==========================================================================
   Gráficos simples em SVG (sem bibliotecas externas), com as cores do tema.
   ========================================================================== */
(function () {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** Barras horizontais: [{label, value}] */
  function bars(data, { color = 'var(--azul)', max = 8, unit = '' } = {}) {
    const rows = data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value).slice(0, max);
    if (!rows.length) return '<p class="empty">Ainda sem dados.</p>';
    const top = Math.max(...rows.map((d) => d.value));
    const h = 26;
    const W = 320;
    const labelW = 120;
    const out = rows
      .map((d, i) => {
        const w = Math.max(4, ((W - labelW - 40) * d.value) / top);
        const y = i * h;
        return `<g><text x="0" y="${y + 17}" font-size="12" font-weight="700" fill="var(--ink-2)">${esc(d.label.length > 17 ? d.label.slice(0, 16) + '…' : d.label)}</text>
          <rect x="${labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="15" rx="7.5" fill="${color}" opacity="${(0.95 - i * 0.06).toFixed(2)}"><title>${esc(d.label)}: ${d.value}${unit}</title></rect>
          <text x="${labelW + w + 6}" y="${y + 17}" font-size="12" font-weight="800" fill="var(--ink)">${d.value}${unit}</text></g>`;
      })
      .join('');
    return `<svg viewBox="0 0 ${W} ${rows.length * h}" role="img" aria-label="Gráfico de barras">${out}</svg>`;
  }

  /** Linha com pontos: [{value, label, color}] */
  function line(points, { height = 140 } = {}) {
    if (points.length < 2) return '<p class="empty">Joguem pelo menos duas partidas para ver a evolução.</p>';
    const W = 320;
    const H = height;
    const pad = 18;
    const vals = points.map((p) => p.value);
    const min = Math.min(0, ...vals);
    const max = Math.max(...vals, 1);
    const x = (i) => pad + (i * (W - pad * 2)) / (points.length - 1);
    const y = (v) => H - pad - ((v - min) * (H - pad * 2)) / (max - min || 1);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    const area = `${d} L${x(points.length - 1).toFixed(1)} ${H - pad} L${pad} ${H - pad} Z`;
    const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="${p.color || 'var(--azul)'}"><title>${esc(p.label || '')}: ${p.value}</title></circle>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução da pontuação">
      <defs><linearGradient id="lg-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--o)" stop-opacity=".28"/><stop offset="1" stop-color="var(--x)" stop-opacity="0"/></linearGradient></defs>
      <line x1="${pad}" x2="${W - pad}" y1="${H - pad}" y2="${H - pad}" stroke="var(--line-2)"/>
      <text x="${pad}" y="12" font-size="10" fill="var(--muted)">${max}</text>
      <path d="${area}" fill="url(#lg-area)"/>
      <path d="${d}" fill="none" stroke="var(--o)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
  }

  /** Anel de proporção (ex.: vitórias de cada um) */
  function ring(parts) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    if (!total) return '<p class="empty">Ainda sem dados.</p>';
    const R = 46;
    const C = 2 * Math.PI * R;
    let off = 0;
    const arcs = parts
      .filter((p) => p.value > 0)
      .map((p) => {
        const len = (p.value / total) * C;
        const s = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${p.color}" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"><title>${esc(p.label)}: ${p.value}</title></circle>`;
        off += len;
        return s;
      })
      .join('');
    const legend = parts.map((p, i) => `<g transform="translate(132 ${28 + i * 22})"><rect width="12" height="12" rx="3" fill="${p.color}"/><text x="18" y="11" font-size="12" font-weight="700" fill="var(--ink-2)">${esc(p.label)}: ${p.value}</text></g>`).join('');
    return `<svg viewBox="0 0 320 120" role="img" aria-label="Distribuição">${arcs}<text x="60" y="66" text-anchor="middle" font-size="20" font-weight="800" fill="var(--ink)">${total}</text>${legend}</svg>`;
  }

  window.Charts = { bars, line, ring, esc };
})();
