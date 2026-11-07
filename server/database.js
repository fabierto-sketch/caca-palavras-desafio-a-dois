'use strict';

/**
 * Base de dados persistente.
 *
 * - Produção (Render): PostgreSQL, através de DATABASE_URL.
 * - Desenvolvimento local sem PostgreSQL: SQLite num ficheiro (node:sqlite),
 *   definido por SQLITE_FILE (por omissão ./data/local.db).
 *
 * O SQL usado é comum aos dois motores (placeholders $1, $2… convertidos
 * automaticamente para SQLite). Inclui migrações numeradas.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');

/* ------------------------------------------------------------------ */
/* Migrações                                                           */
/* ------------------------------------------------------------------ */
const MIGRATIONS = [
  {
    version: 1,
    name: 'estrutura inicial',
    up: [
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT)`,
      `CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY, label TEXT, created_at BIGINT, last_activity BIGINT,
        status TEXT DEFAULT 'open', state TEXT, stats TEXT)`,
      `CREATE TABLE IF NOT EXISTS players (
        token_hash TEXT PRIMARY KEY, room_code TEXT NOT NULL, seat TEXT NOT NULL, name TEXT NOT NULL,
        joined_at BIGINT, last_seen BIGINT, active INTEGER DEFAULT 1)`,
      `CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_code)`,
      `CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, room_code TEXT NOT NULL, mode TEXT, started_at BIGINT, ended_at BIGINT,
        winner TEXT, score TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_code)`,
      `CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, room_code TEXT NOT NULL, match_id TEXT, mode TEXT, number INTEGER,
        x_name TEXT, o_name TEXT, starter TEXT, winner TEXT, variant TEXT, summary TEXT, moves TEXT, challenge TEXT,
        challenge_done INTEGER, casual INTEGER DEFAULT 0, started_at BIGINT, ended_at BIGINT)`,
      `CREATE INDEX IF NOT EXISTS idx_games_room ON games(room_code, ended_at)`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, room_code TEXT NOT NULL, seat TEXT, name TEXT, text TEXT, kind TEXT DEFAULT 'user', at BIGINT)`,
      `CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_code, at)`,
      `CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY, created_at BIGINT, expires_at BIGINT, ip TEXT)`,
    ],
  },
  {
    version: 2,
    name: 'caça-palavras: categorias, palavras, partidas, histórico antirrepetição, desafios e jogadores',
    up: [
      `CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, description TEXT, active INTEGER DEFAULT 1,
        special INTEGER DEFAULT 0, position INTEGER DEFAULT 0, builtin INTEGER DEFAULT 0, created_at BIGINT, updated_at BIGINT)`,
      `CREATE TABLE IF NOT EXISTS words (
        id TEXT PRIMARY KEY, category_id TEXT NOT NULL, display TEXT NOT NULL, norm TEXT NOT NULL, hint TEXT,
        active INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0, created_at BIGINT)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_words_cat_norm ON words(category_id, norm)`,
      `CREATE TABLE IF NOT EXISTS ws_matches (
        id TEXT PRIMARY KEY, room_code TEXT, mode TEXT, difficulty TEXT, category_id TEXT, category_name TEXT,
        size INTEGER, seed TEXT, challenge_id TEXT, challenge_name TEXT, time_limit_ms BIGINT, signature TEXT,
        words TEXT, grid TEXT, placements TEXT, status TEXT, result TEXT, winner TEXT,
        x_name TEXT, o_name TEXT, x_key TEXT, o_key TEXT, score_x INTEGER, score_o INTEGER, score_team INTEGER,
        found_x INTEGER, found_o INTEGER, total_words INTEGER, hints INTEGER, elapsed_ms BIGINT,
        started_at BIGINT, finished_at BIGINT)`,
      `CREATE INDEX IF NOT EXISTS idx_wsm_room ON ws_matches(room_code, finished_at)`,
      `CREATE INDEX IF NOT EXISTS idx_wsm_fin ON ws_matches(finished_at)`,
      `CREATE TABLE IF NOT EXISTS word_log (
        id TEXT PRIMARY KEY, room_code TEXT, player_key TEXT, norm TEXT NOT NULL, signature TEXT, at BIGINT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_wlog_room ON word_log(room_code, at)`,
      `CREATE INDEX IF NOT EXISTS idx_wlog_player ON word_log(player_key, at)`,
      `CREATE TABLE IF NOT EXISTS ws_players (
        player_key TEXT PRIMARY KEY, name TEXT, created_at BIGINT, last_seen BIGINT)`,
      `CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, config TEXT NOT NULL, active INTEGER DEFAULT 1,
        builtin INTEGER DEFAULT 0, position INTEGER DEFAULT 0, created_at BIGINT, updated_at BIGINT)`,
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Motores                                                             */
/* ------------------------------------------------------------------ */
function sslOption(url) {
  const flag = (process.env.DATABASE_SSL || '').toLowerCase();
  if (flag === 'false' || flag === 'disable') return false;
  if (flag === 'true' || flag === 'require') return { rejectUnauthorized: false };
  // URL externa do Render, Neon, Supabase, etc. exigem SSL; a URL interna do Render não.
  if (/sslmode=require/.test(url) || /\.(render\.com|neon\.tech|supabase\.co|supabase\.com)/.test(url)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

class PostgresDriver {
  constructor(url) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT -> número
    // o SSL é configurado abaixo; tirar o sslmode do endereço evita avisos do pg
    const clean = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
    this.pool = new pg.Pool({
      connectionString: clean,
      ssl: sslOption(url),
      max: Number(process.env.DATABASE_POOL_MAX || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    this.pool.on('error', (err) => logger.error(`Erro na ligação à base de dados: ${err.message}`));
    this.kind = 'postgres';
  }

  async query(sql, params = [], client) {
    const res = await (client || this.pool).query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount };
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn((sql, params) => this.query(sql, params, client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class SqliteDriver {
  constructor(file) {
    // Silencia o aviso "experimental" do node:sqlite apenas para este módulo.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      process.emitWarning = emit;
      throw new Error('Sem DATABASE_URL e esta versão do Node não tem SQLite integrado. Defina DATABASE_URL (PostgreSQL) ou use Node 22.13 ou superior.');
    }
    process.emitWarning = emit;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.kind = 'sqlite';
    this.file = file;
    this.chain = Promise.resolve();
  }

  convert(sql) {
    return sql.replace(/\$(\d+)/g, '?$1');
  }

  run(sql, params) {
    const stmt = this.db.prepare(this.convert(sql));
    const values = params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
    if (/^\s*(SELECT|WITH)|RETURNING/i.test(sql)) {
      const rows = stmt.all(...values);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...values);
    return { rows: [], rowCount: Number(info.changes) };
  }

  // As operações são serializadas para que as transações não se misturem.
  async query(sql, params = []) {
    const job = this.chain.then(() => this.run(sql, params));
    this.chain = job.catch(() => {});
    return job;
  }

  async tx(fn) {
    const job = this.chain.then(async () => {
      this.db.exec('BEGIN');
      try {
        const result = await fn(async (sql, params = []) => this.run(sql, params));
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignorar */
        }
        throw err;
      }
    });
    this.chain = job.catch(() => {});
    return job;
  }

  async close() {
    await this.chain;
    this.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
class Database {
  constructor(driver) {
    this.driver = driver;
    this.kind = driver.kind;
  }

  static async connect() {
    let driver;
    if (process.env.DATABASE_URL) {
      driver = new PostgresDriver(process.env.DATABASE_URL);
      await driver.query('SELECT 1');
      logger.info('Base de dados: PostgreSQL ligado.');
    } else {
      const file = process.env.SQLITE_FILE || path.join(DATA_DIR, 'local.db');
      driver = new SqliteDriver(file);
      logger.warn(`Base de dados: SQLite local (${path.relative(process.cwd(), file) || file}). Em produção defina DATABASE_URL (PostgreSQL).`);
    }
    const db = new Database(driver);
    await db.migrate();
    await db.seed();
    return db;
  }

  async query(sql, params) {
    return (await this.driver.query(sql, params)).rows;
  }

  async one(sql, params) {
    const rows = await this.query(sql, params);
    return rows[0] || null;
  }

  async run(sql, params) {
    return (await this.driver.query(sql, params)).rowCount;
  }

  tx(fn) {
    return this.driver.tx(fn);
  }

  close() {
    return this.driver.close();
  }

  async migrate() {
    await this.driver.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at BIGINT)`);
    const done = new Set((await this.query('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await this.tx(async (q) => {
        for (const stmt of m.up) await q(stmt);
        await q('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [m.version, m.name, Date.now()]);
      });
      logger.info(`Migração ${m.version} aplicada (${m.name}).`);
    }
  }

  async getMeta(key) {
    const row = await this.one('SELECT value FROM meta WHERE key = $1', [key]);
    return row ? row.value : null;
  }

  async setMeta(key, value) {
    await this.run(
      'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, String(value)]
    );
  }

  /** Valores iniciais (as categorias e palavras são importadas pelo módulo de palavras). */
  async seed() {
    if ((await this.getMeta('rooms_created')) === null) await this.setMeta('rooms_created', 0);
  }
}

module.exports = { Database, MIGRATIONS };
