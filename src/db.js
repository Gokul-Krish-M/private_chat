import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ROOMS = 2;
export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 500;
const SCHEMA_VERSION = 2; // v2: end-to-end encrypted bodies + per-room salt/verifier

const toMessage = (r) => ({
  id: r.id,
  roomId: r.room_id,
  author: r.author,
  body: r.body, // ciphertext; the server can't read it
  createdAt: r.created_at,
});

const toRoom = (r) => ({
  id: r.id,
  name: r.name,
  salt: r.salt,
  verifier: r.verifier,
  createdAt: r.created_at,
});

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  // v1 stored plaintext and can't be converted (no passphrases), so drop it.
  // Messages only live 24h anyway.
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS rooms;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      salt       TEXT NOT NULL,
      verifier   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room    ON messages(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);

  const q = {
    listRooms: db.prepare('SELECT * FROM rooms ORDER BY id'),
    countRooms: db.prepare('SELECT COUNT(*) AS n FROM rooms'),
    getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    roomByName: db.prepare('SELECT id FROM rooms WHERE name = ?'),
    insertRoom: db.prepare('INSERT INTO rooms (name, salt, verifier, created_at) VALUES (?, ?, ?, ?)'),
    deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
    insertMsg: db.prepare('INSERT INTO messages (room_id, author, body, created_at) VALUES (?, ?, ?, ?)'),
    getMsg: db.prepare('SELECT * FROM messages WHERE id = ?'),
    history: db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE room_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC`),
    purge: db.prepare('DELETE FROM messages WHERE created_at < ?'),
  };

  return {
    listRooms: () => q.listRooms.all().map(toRoom),

    getRoom(id) {
      const r = q.getRoom.get(id);
      return r ? toRoom(r) : null;
    },

    createRoom({ name, salt, verifier }) {
      if (q.countRooms.get().n >= MAX_ROOMS) {
        throw new Error(`Room limit reached (${MAX_ROOMS}). Delete a room first.`);
      }
      if (q.roomByName.get(name)) throw new Error(`A room named "${name}" already exists.`);
      const { lastInsertRowid } = q.insertRoom.run(name, salt, verifier, Date.now());
      return toRoom(q.getRoom.get(lastInsertRowid));
    },

    deleteRoom: (id) => q.deleteRoom.run(id).changes > 0,

    addMessage(roomId, author, body) {
      const { lastInsertRowid } = q.insertMsg.run(roomId, author, body, Date.now());
      return toMessage(q.getMsg.get(lastInsertRowid));
    },

    history: (roomId) =>
      q.history.all(roomId, Date.now() - MESSAGE_TTL_MS, HISTORY_LIMIT).map(toMessage),

    /** Deletes messages older than the cutoff; returns how many were removed. */
    purgeBefore: (cutoff) => Number(q.purge.run(cutoff).changes),

    close: () => db.close(),
  };
}
