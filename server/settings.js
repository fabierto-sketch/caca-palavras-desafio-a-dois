'use strict';

/**
 * Definições do jogo (pontuação, pistas, tempos, mensagens…), editáveis no
 * painel de administração e guardadas na base de dados.
 */

const { cleanText } = require('./security');

const CLOSING = ['Não importa quem encontrou mais palavras. O importante é que continuamos a descobrir coisas juntos.', 'Alberto ❤️ Bernardete', 'Estamos juntos, amor… Sempre.'].join('\n\n');

const SCHEMA = {
  // textos
  welcomeMessage: { type: 'text', max: 200, def: '', label: 'Mensagem de boas-vindas' },
  dedication: { type: 'text', max: 120, def: 'Projeto dedicado a Alberto e Bernardete.', label: 'Dedicatória' },
  specialPhrase: { type: 'text', max: 120, def: 'Estamos juntos, amor… Sempre.', label: 'Frase especial' },
  closingMessage: { type: 'multiline', max: 1500, def: CLOSING, label: 'Mensagem de encerramento' },
  specialGameMessage: { type: 'text', max: 200, def: 'Mesmo separados por um oceano, continuam a jogar lado a lado.', label: 'Mensagem durante o jogo (Portugal ❤️ Brasil)' },
  specialVictory: { type: 'text', max: 200, def: 'Alberto e Bernardete: mais uma partida vencida juntos!', label: 'Vitória especial (Portugal ❤️ Brasil)' },
  specialSignature: { type: 'text', max: 120, def: 'Estamos juntos, amor… Sempre. ❤️', label: 'Assinatura especial' },
  msgFound: { type: 'lines', max: 12, def: ['Boa! Encontraram mais uma palavra!', 'Mais uma! Que dupla! 💪', 'Olhos de lince! 👀', 'Estão imparáveis! ✨'], label: 'Mensagens: palavra encontrada (a jogar juntos)' },
  msgLead: { type: 'lines', max: 12, def: ['{nome} está mais rápido(a)! ⚡', '{nome} vai à frente!', 'Atenção: {nome} está a acelerar! 🏃'], label: 'Mensagens: quem vai à frente ({nome})' },
  msgSecret: { type: 'lines', max: 12, def: ['{nome} descobriu uma palavra secreta! 🤫', 'Palavra secreta desvendada por {nome}! 🗝️'], label: 'Mensagens: palavra secreta ({nome})' },
  msgAlmost: { type: 'lines', max: 12, def: ['Falta pouco para vencerem!', 'Só mais um bocadinho! 🔥', 'Estão quase lá!'], label: 'Mensagens: falta pouco' },
  quickMessages: { type: 'lines', max: 16, def: ['Encontrei! 🎉', 'Onde estás a procurar?', 'Vê na diagonal ↗', 'Está ao contrário! 🔄', 'Pede uma pista?', 'Quase! 😅', 'És rápido(a) demais! ⚡', 'Revanche? 😏', 'Boa jogada! 👏', 'Adoro-te ❤️'], label: 'Mensagens rápidas do chat' },
  // pontuação
  pointsShort: { type: 'int', min: 0, max: 500, def: 10, label: 'Palavra curta (até 4 letras)' },
  pointsMedium: { type: 'int', min: 0, max: 500, def: 15, label: 'Palavra média (5 a 7 letras)' },
  pointsLong: { type: 'int', min: 0, max: 500, def: 20, label: 'Palavra longa (8 a 10 letras)' },
  pointsVeryLong: { type: 'int', min: 0, max: 500, def: 30, label: 'Palavra muito longa (11 ou mais)' },
  secretBonus: { type: 'int', min: 0, max: 500, def: 10, label: 'Bónus por palavra secreta' },
  completionBonus: { type: 'int', min: 0, max: 2000, def: 50, label: 'Bónus de conclusão' },
  firstFinishBonus: { type: 'int', min: 0, max: 2000, def: 30, label: 'Bónus para quem termina primeiro (desafio)' },
  speedBonusPerSecond: { type: 'num', min: 0, max: 20, def: 0.5, label: 'Bónus de rapidez por segundo poupado' },
  parSecondsPerWord: { type: 'int', min: 5, max: 300, def: 30, label: 'Tempo de referência por palavra, sem relógio (s)' },
  wrongPenalty: { type: 'int', min: 0, max: 200, def: 2, label: 'Penalização por seleção errada' },
  // pistas
  hintLetterCost: { type: 'int', min: 0, max: 500, def: 5, label: 'Pista: primeira letra' },
  hintDirectionCost: { type: 'int', min: 0, max: 500, def: 5, label: 'Pista: direção' },
  hintZoneCost: { type: 'int', min: 0, max: 500, def: 8, label: 'Pista: destacar zona' },
  hintTextCost: { type: 'int', min: 0, max: 500, def: 4, label: 'Pista: indicação' },
  hintRevealCost: { type: 'int', min: 0, max: 500, def: 25, label: 'Revelar palavra (se permitido)' },
  allowReveal: { type: 'bool', def: false, label: 'Permitir revelar a palavra completa' },
  maxHintsFacil: { type: 'int', min: 0, max: 50, def: 10, label: 'Máximo de pistas — Fácil' },
  maxHintsMedio: { type: 'int', min: 0, max: 50, def: 6, label: 'Máximo de pistas — Médio' },
  maxHintsDificil: { type: 'int', min: 0, max: 50, def: 4, label: 'Máximo de pistas — Difícil' },
  maxHintsEspecialista: { type: 'int', min: 0, max: 50, def: 2, label: 'Máximo de pistas — Especialista' },
  zoneSeconds: { type: 'int', min: 2, max: 30, def: 6, label: 'Duração do destaque da zona (s)' },
  // tempo
  minutesFacil: { type: 'int', min: 0, max: 120, def: 0, label: 'Tempo por omissão — Fácil (0 = sem limite)' },
  minutesMedio: { type: 'int', min: 0, max: 120, def: 10, label: 'Tempo por omissão — Médio' },
  minutesDificil: { type: 'int', min: 0, max: 120, def: 15, label: 'Tempo por omissão — Difícil' },
  minutesEspecialista: { type: 'int', min: 0, max: 120, def: 15, label: 'Tempo por omissão — Especialista' },
  lowTimeSeconds: { type: 'int', min: 5, max: 300, def: 30, label: 'Alerta de pouco tempo (s)' },
  pauseMode: { type: 'enum', values: ['both', 'host', 'off'], def: 'both', label: 'Pausa (both = os dois concordam, host = só o anfitrião, off = sem pausa)' },
  extraSizes: { type: 'sizes', def: [], label: 'Dimensões adicionais das grelhas' },
  // salas e convívio
  playersCanCreateRooms: { type: 'bool', def: true, label: 'Os jogadores podem criar salas na página inicial' },
  chatEnabled: { type: 'bool', def: true, label: 'Chat' },
  reactionsEnabled: { type: 'bool', def: true, label: 'Reações' },
  videoEnabled: { type: 'bool', def: true, label: 'Videochamada' },
  playersCanClearHistory: { type: 'bool', def: true, label: 'Os jogadores podem apagar o histórico da sala (os dois têm de aceitar)' },
};

const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.def]));

function cleanMultiline(v, max) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => cleanText(l, max))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** Valida um valor. Devolve [valor] ou [undefined, erro]. */
function validate(key, value) {
  const s = SCHEMA[key];
  if (!s) return [undefined, `Definição desconhecida: ${key}`];
  switch (s.type) {
    case 'int':
    case 'num': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < s.min || n > s.max) return [undefined, `${s.label}: tem de estar entre ${s.min} e ${s.max}.`];
      return [s.type === 'int' ? Math.round(n) : Math.round(n * 100) / 100];
    }
    case 'bool':
      return [value === true || value === 'true' || value === 1 || value === '1' || value === 'on'];
    case 'enum':
      if (!s.values.includes(value)) return [undefined, `${s.label}: valor inválido.`];
      return [value];
    case 'text':
      return [cleanText(String(value ?? ''), s.max)];
    case 'multiline':
      return [cleanMultiline(String(value ?? ''), s.max)];
    case 'lines': {
      const arr = (Array.isArray(value) ? value : String(value ?? '').split('\n')).map((l) => cleanText(String(l), 120)).filter(Boolean).slice(0, s.max);
      if (!arr.length) return [undefined, `${s.label}: escreva pelo menos uma linha.`];
      return [arr];
    }
    case 'sizes': {
      const arr = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).filter((x) => x !== '').map(Number);
      if (arr.some((n) => !Number.isInteger(n) || n < 6 || n > 26)) return [undefined, 'Dimensões: números inteiros entre 6 e 26.'];
      return [[...new Set(arr)].sort((a, b) => a - b)];
    }
    default:
      return [undefined, 'Tipo desconhecido'];
  }
}

class Settings {
  constructor(db) {
    this.db = db;
    this.values = { ...DEFAULTS };
  }

  async load() {
    const rows = await this.db.query('SELECT key, value FROM settings');
    for (const r of rows) {
      if (!(r.key in SCHEMA)) continue;
      try {
        const [v] = validate(r.key, JSON.parse(r.value));
        if (v !== undefined) this.values[r.key] = v;
      } catch {
        /* valor antigo inválido: fica o por omissão */
      }
    }
    return this;
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  /** Todas as definições são públicas (não há segredos aqui). */
  public() {
    return this.all();
  }

  async update(patch) {
    const errors = [];
    const next = {};
    for (const [k, v] of Object.entries(patch || {})) {
      const [val, err] = validate(k, v);
      if (err) errors.push(err);
      else next[k] = val;
    }
    if (errors.length) return { ok: false, errors };
    const now = Date.now();
    for (const [k, v] of Object.entries(next)) {
      await this.db.run(
        'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at',
        [k, JSON.stringify(v), now]
      );
      this.values[k] = v;
    }
    return { ok: true, settings: this.all() };
  }

  async reset(keys) {
    const list = (keys && keys.length ? keys : Object.keys(SCHEMA)).filter((k) => k in SCHEMA);
    for (const k of list) {
      await this.db.run('DELETE FROM settings WHERE key = $1', [k]);
      this.values[k] = DEFAULTS[k];
    }
    return this.all();
  }

  /** Pontos de uma palavra pelo comprimento. */
  wordPoints(len) {
    const v = this.values;
    if (len <= 4) return v.pointsShort;
    if (len <= 7) return v.pointsMedium;
    if (len <= 10) return v.pointsLong;
    return v.pointsVeryLong;
  }

  maxHints(difficulty) {
    const key = { facil: 'maxHintsFacil', medio: 'maxHintsMedio', dificil: 'maxHintsDificil', especialista: 'maxHintsEspecialista' }[difficulty];
    return key ? this.values[key] : 6;
  }

  defaultMinutes(difficulty) {
    const key = { facil: 'minutesFacil', medio: 'minutesMedio', dificil: 'minutesDificil', especialista: 'minutesEspecialista' }[difficulty];
    return key ? this.values[key] : 10;
  }

  hintCost(kind) {
    return { letter: this.values.hintLetterCost, direction: this.values.hintDirectionCost, zone: this.values.hintZoneCost, text: this.values.hintTextCost, reveal: this.values.hintRevealCost }[kind];
  }

  /** Para o painel: esquema com rótulos. */
  schema() {
    return Object.entries(SCHEMA).map(([key, s]) => ({ key, type: s.type, label: s.label, min: s.min, max: s.max, values: s.values }));
  }
}

module.exports = { Settings, DEFAULTS, SCHEMA, CLOSING };
