require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const mysql = require('mysql2/promise');

const {
  PORT = 8080,
  ALLOWED_ORIGINS = '',
  MYSQL_HOST,
  MYSQL_PORT,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE
} = process.env;

const nowISO = () => new Date().toISOString();

async function ensureDatabaseAndSchema() {
  const adminPool = mysql.createPool({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 5
  });

  try {
    const createDbSQL = `
      CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\`
      CHARACTER SET utf8mb4
      COLLATE utf8mb4_0900_ai_ci;
    `;
    await adminPool.query(createDbSQL);
  } catch (e) {
    if (String(e.message || '').includes('Unknown collation')) {
      await adminPool.query(`
        CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\`
        CHARACTER SET utf8mb4
        COLLATE utf8mb4_general_ci;
      `);
    } else {
      throw e;
    }
  } finally {
    await adminPool.end();
  }

  const pool = mysql.createPool({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    multipleStatements: true
  });

  const schemaSQL = `
    CREATE TABLE IF NOT EXISTS users (
      id          VARCHAR(24) PRIMARY KEY,
      name        VARCHAR(80) NOT NULL,
      api_key     CHAR(36) NOT NULL,
      created_at  VARCHAR(30) NOT NULL,
      UNIQUE KEY uq_users_api_key (api_key)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE IF NOT EXISTS chats (
      id          VARCHAR(24) PRIMARY KEY,
      user_id     VARCHAR(24) NOT NULL,
      title       VARCHAR(255),
      model       VARCHAR(120),
      incognito   TINYINT NOT NULL DEFAULT 0,
      created_at  VARCHAR(30) NOT NULL,
      updated_at  VARCHAR(30) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_chats_user_updated (user_id, updated_at)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE IF NOT EXISTS messages (
      id          VARCHAR(24) PRIMARY KEY,
      chat_id     VARCHAR(24) NOT NULL,
      role        VARCHAR(16) NOT NULL,
      content     MEDIUMTEXT NOT NULL,
      idx         INT NOT NULL,
      created_at  VARCHAR(30) NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
      UNIQUE KEY uq_chat_idx (chat_id, idx),
      INDEX idx_messages_chat_idx (chat_id, idx)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci;

    CREATE TABLE IF NOT EXISTS drafts (
      user_id     VARCHAR(24) PRIMARY KEY,
      chat_id     VARCHAR(24),
      text        MEDIUMTEXT,
      updated_at  VARCHAR(30) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci;
  `;

  for (const stmt of schemaSQL.split(';').map(s => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }

  return pool;
}

async function start() {
  const pool = await ensureDatabaseAndSchema();
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (!allowed.length) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      cb(new Error('CORS not allowed: ' + origin));
    }
  }));

  app.get('/health', async (req, res) => {
    try {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up', ms: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  async function auth(req, res, next) {
    const key = req.header('X-API-Key');
    if (!key) return res.status(401).json({ error: 'missing api key' });
    try {
      const [rows] = await pool.query(
        'SELECT id, name FROM users WHERE api_key = ? LIMIT 1',
        [key]
      );
      if (!rows.length) return res.status(401).json({ error: 'invalid api key' });
      req.user = { id: rows[0].id, name: rows[0].name };
      next();
    } catch {
      res.status(500).json({ error: 'auth error' });
    }
  }

  app.post('/auth/register', async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0,80);
    if (!name) return res.status(400).json({ error: 'name_required' });

    const id = nanoid();
    const apiKey = crypto.randomUUID();
    const ts = nowISO();

    try {
      await pool.query(
        'INSERT INTO users (id, name, api_key, created_at) VALUES (?,?,?,?)',
        [id, name, apiKey, ts]
      );
      return res.json({ userId: id, name, apiKey });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'name_taken' });
      }
      return res.status(500).json({ error: 'register_failed' });
    }
  });

  app.post('/auth/rotate', auth, async (req, res) => {
    const apiKey = crypto.randomUUID();
    try {
      await pool.query('UPDATE users SET api_key = ? WHERE id = ?', [apiKey, req.user.id]);
      res.json({ apiKey });
    } catch {
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  app.get('/me', auth, async (req, res) => {
    res.json({ userId: req.user.id, name: req.user.name });
  });

  app.get('/chats', auth, async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, title, model, incognito, created_at, updated_at
         FROM chats WHERE user_id = ?
         ORDER BY updated_at DESC`, [req.user.id]
      );
      res.json(rows);
    } catch {
      res.status(500).json({ error: 'list failed' });
    }
  });

  app.post('/chats', auth, async (req, res) => {
    const id = nanoid();
    const ts = nowISO();
    const title = req.body?.title ? String(req.body.title).slice(0, 255) : null;
    const model = req.body?.model ? String(req.body.model).slice(0, 120) : null;
    const incognito = req.body?.incognito ? 1 : 0;
    try {
      await pool.query(
        `INSERT INTO chats (id, user_id, title, model, incognito, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        [id, req.user.id, title, model, incognito, ts, ts]
      );
      res.json({ id });
    } catch {
      res.status(500).json({ error: 'create chat failed' });
    }
  });

  app.get('/chats/:id', auth, async (req, res) => {
    try {
      const [crows] = await pool.query(
        `SELECT * FROM chats WHERE id = ? AND user_id = ? LIMIT 1`,
        [req.params.id, req.user.id]
      );
      if (!crows.length) return res.status(404).json({ error: 'not found' });
      const chat = crows[0];
      const [mrows] = await pool.query(
        `SELECT id, role, content, idx, created_at
         FROM messages WHERE chat_id = ? ORDER BY idx ASC`,
        [chat.id]
      );
      res.json({ meta: chat, messages: mrows });
    } catch {
      res.status(500).json({ error: 'get chat failed' });
    }
  });

  app.put('/chats/:id', auth, async (req, res) => {
    try {
      const [chk] = await pool.query(
        `SELECT id FROM chats WHERE id = ? AND user_id = ? LIMIT 1`,
        [req.params.id, req.user.id]
      );
      if (!chk.length) return res.status(404).json({ error: 'not found' });
      const ts = nowISO();
      if (req.body?.title !== undefined) {
        await pool.query(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`,
          [String(req.body.title).slice(0, 255), ts, req.params.id]);
      }
      if (req.body?.model !== undefined) {
        await pool.query(`UPDATE chats SET model = ?, updated_at = ? WHERE id = ?`,
          [String(req.body.model).slice(0, 120), ts, req.params.id]);
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'update failed' });
    }
  });

  app.delete('/chats/:id', auth, async (req, res) => {
    try {
      const [chk] = await pool.query(
        `SELECT id FROM chats WHERE id = ? AND user_id = ? LIMIT 1`,
        [req.params.id, req.user.id]
      );
      if (!chk.length) return res.status(404).json({ error: 'not found' });
      await pool.query(`DELETE FROM chats WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'delete failed' });
    }
  });

  app.post('/chats/:id/messages', auth, async (req, res) => {
    const { role, content } = req.body || {};
    if (!role || typeof content !== 'string') return res.status(400).json({ error: 'role and content required' });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [crows] = await conn.query(
        `SELECT id FROM chats WHERE id = ? AND user_id = ? LIMIT 1`,
        [req.params.id, req.user.id]
      );
      if (!crows.length) { await conn.rollback(); return res.status(404).json({ error: 'not found' }); }
      const [m] = await conn.query(
        `SELECT COALESCE(MAX(idx), -1) AS m FROM messages WHERE chat_id = ? FOR UPDATE`,
        [req.params.id]
      );
      const nextIdx = Number(m[0].m) + 1;
      const id = nanoid();
      const ts = nowISO();
      await conn.query(
        `INSERT INTO messages (id, chat_id, role, content, idx, created_at)
         VALUES (?,?,?,?,?,?)`,
        [id, req.params.id, String(role), String(content), nextIdx, ts]
      );
      await conn.query(
        `UPDATE chats SET updated_at = ? WHERE id = ?`,
        [ts, req.params.id]
      );
      await conn.commit();
      res.json({ id, idx: nextIdx, created_at: ts });
    } catch {
      await conn.rollback();
      res.status(500).json({ error: 'append failed' });
    } finally {
      conn.release();
    }
  });

  app.get('/drafts/current', auth, async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT chat_id, text, updated_at FROM drafts WHERE user_id = ? LIMIT 1`,
        [req.user.id]
      );
      res.json(rows[0] || { chat_id: null, text: '', updated_at: null });
    } catch {
      res.status(500).json({ error: 'get draft failed' });
    }
  });

  app.put('/drafts/current', auth, async (req, res) => {
    const chatId = req.body?.chatId || null;
    const text = String(req.body?.text || '').slice(0, 20000);
    const ts = nowISO();
    try {
      await pool.query(
        `INSERT INTO drafts (user_id, chat_id, text, updated_at)
         VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id), text=VALUES(text), updated_at=VALUES(updated_at)`,
        [req.user.id, chatId, text, ts]
      );
      res.json({ ok: true, updated_at: ts });
    } catch {
      res.status(500).json({ error: 'put draft failed' });
    }
  });

  app.delete('/drafts/current', auth, async (req, res) => {
    try {
      await pool.query(`DELETE FROM drafts WHERE user_id = ?`, [req.user.id]);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'delete draft failed' });
    }
  });

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Chat storage API auf http://0.0.0.0:${PORT}`);
    if (!ALLOWED_ORIGINS) {
      console.log('CORS aktuell offen. Setze ALLOWED_ORIGINS, um auf deine UI-URLs zu begrenzen.');
    }
  });
}

start().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
