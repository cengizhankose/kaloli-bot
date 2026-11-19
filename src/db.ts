import { Database } from 'bun:sqlite'
import type { Estimate, FoodItem } from './types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id               INTEGER PRIMARY KEY,
  chat_id          INTEGER NOT NULL,
  message_id       INTEGER NOT NULL,  -- the photo message
  reply_message_id INTEGER,           -- the bot's answer to it
  user_id          INTEGER NOT NULL,  -- who posted the photo
  user_name        TEXT    NOT NULL,
  day              TEXT    NOT NULL,  -- local civil date of the photo, YYYY-MM-DD
  created_at       TEXT    NOT NULL,  -- instant the photo was posted, ISO UTC
  user_note        TEXT,
  file_id          TEXT    NOT NULL,
  dish             TEXT    NOT NULL,
  total_kcal       INTEGER NOT NULL,
  protein_g        REAL,
  carbs_g          REAL,
  fat_g            REAL,
  confidence       TEXT,
  model_note       TEXT,
  model            TEXT    NOT NULL,
  raw_response     TEXT    NOT NULL,
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS entries_chat_day ON entries (chat_id, day);
CREATE TABLE IF NOT EXISTS items (
  id        INTEGER PRIMARY KEY,
  entry_id  INTEGER NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT    NOT NULL,
  grams     REAL,
  count     REAL,
  kcal      INTEGER NOT NULL,
  protein_g REAL,
  carbs_g   REAL,
  fat_g     REAL
);
CREATE INDEX IF NOT EXISTS items_entry ON items (entry_id);
CREATE TABLE IF NOT EXISTS reports (
  chat_id INTEGER NOT NULL,
  day     TEXT    NOT NULL,
  sent_at TEXT    NOT NULL,
  PRIMARY KEY (chat_id, day)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export interface NewEntry {
  chatId: number
  messageId: number
  userId: number
  userName: string
  day: string
  createdAt: string
  userNote: string | null
  fileId: string
  estimate: Estimate
  model: string
  rawResponse: string
}

export interface Entry {
  id: number
  chatId: number
  messageId: number
  userId: number
  userName: string
  day: string
  createdAt: string
  userNote: string | null
  dish: string
  totalKcal: number
  proteinG: number | null
  carbsG: number | null
  fatG: number | null
  confidence: string | null
  /** The model's one-sentence statement of what it counted. */
  modelNote: string | null
  items: FoodItem[]
}

export interface LeaderboardRow {
  userId: number
  /** The person's most recent display name. */
  userName: string
  totalKcal: number
  entries: number
  /** Distinct days with at least one entry in the period. */
  days: number
}

interface EntryRow {
  id: number
  chat_id: number
  message_id: number
  user_id: number
  user_name: string
  day: string
  created_at: string
  user_note: string | null
  dish: string
  total_kcal: number
  protein_g: number | null
  carbs_g: number | null
  fat_g: number | null
  confidence: string | null
  model_note: string | null
}

interface ItemRow {
  entry_id: number
  name: string
  grams: number | null
  count: number | null
  kcal: number
  protein_g: number | null
  carbs_g: number | null
  fat_g: number | null
}

const ENTRY_COLUMNS =
  'id, chat_id, message_id, user_id, user_name, day, created_at, user_note, dish, total_kcal, protein_g, carbs_g, fat_g, confidence, model_note'

export class Store {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    // Databases created before per-item counts existed lack the column.
    const itemColumns = this.db.query<{ name: string }, []>('PRAGMA table_info(items)').all()
    if (!itemColumns.some((c) => c.name === 'count')) this.db.exec('ALTER TABLE items ADD COLUMN count REAL')
  }

  close(): void {
    this.db.close()
  }

  /** One entry per photo message: analysing the same photo again replaces the earlier estimate. */
  upsertEntry(e: NewEntry): { id: number; replaced: boolean } {
    return this.db.transaction(() => {
      const gone = this.db.query('DELETE FROM entries WHERE chat_id = ? AND message_id = ?').run(e.chatId, e.messageId)
      const est = e.estimate
      const inserted = this.db
        .query(
          `INSERT INTO entries (chat_id, message_id, user_id, user_name, day, created_at, user_note, file_id, dish,
             total_kcal, protein_g, carbs_g, fat_g, confidence, model_note, model, raw_response)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.chatId, e.messageId, e.userId, e.userName, e.day, e.createdAt, e.userNote, e.fileId, est.dish,
          est.totalKcal, est.proteinG, est.carbsG, est.fatG, est.confidence, est.note, e.model, e.rawResponse,
        )
      const id = Number(inserted.lastInsertRowid)
      const insertItem = this.db.query(
        'INSERT INTO items (entry_id, position, name, count, grams, kcal, protein_g, carbs_g, fat_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      est.items.forEach((item, position) => {
        insertItem.run(id, position, item.name, item.count, item.grams, item.kcal, item.proteinG, item.carbsG, item.fatG)
      })
      return { id, replaced: gone.changes > 0 }
    })()
  }

  setReplyMessageId(entryId: number, replyMessageId: number): void {
    this.db.query('UPDATE entries SET reply_message_id = ? WHERE id = ?').run(replyMessageId, entryId)
  }

  /** Looks an entry up by its photo message or by the bot's answer to it. */
  findEntryByMessage(chatId: number, messageId: number): Entry | undefined {
    const row = this.db
      .query<EntryRow, [number, number, number]>(
        `SELECT ${ENTRY_COLUMNS} FROM entries WHERE chat_id = ? AND (message_id = ? OR reply_message_id = ?)`,
      )
      .get(chatId, messageId, messageId)
    return row ? this.hydrate([row])[0] : undefined
  }

  deleteEntry(id: number): void {
    this.db.query('DELETE FROM entries WHERE id = ?').run(id)
  }

  dayTotalKcal(chatId: number, userId: number, day: string): number {
    const row = this.db
      .query<{ total: number | null }, [number, number, string]>(
        'SELECT SUM(total_kcal) AS total FROM entries WHERE chat_id = ? AND user_id = ? AND day = ?',
      )
      .get(chatId, userId, day)
    return row?.total ?? 0
  }

  /** Per-person totals of a chat between two civil dates (inclusive), highest total first. */
  leaderboard(chatId: number, fromDay: string, toDay: string): LeaderboardRow[] {
    return this.db
      .query<LeaderboardRow, [number, string, string]>(
        `SELECT e.user_id AS userId,
           (SELECT n.user_name FROM entries n WHERE n.chat_id = e.chat_id AND n.user_id = e.user_id
            ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS userName,
           SUM(e.total_kcal) AS totalKcal, COUNT(*) AS entries, COUNT(DISTINCT e.day) AS days
         FROM entries e WHERE e.chat_id = ? AND e.day BETWEEN ? AND ?
         GROUP BY e.user_id ORDER BY totalKcal DESC, userName`,
      )
      .all(chatId, fromDay, toDay)
  }

  /** A chat's entries of one day, oldest first. */
  entriesForDay(chatId: number, day: string): Entry[] {
    const rows = this.db
      .query<EntryRow, [number, string]>(
        `SELECT ${ENTRY_COLUMNS} FROM entries WHERE chat_id = ? AND day = ? ORDER BY created_at, id`,
      )
      .all(chatId, day)
    return this.hydrate(rows)
  }

  /**
   * (chat, day) pairs that have entries but no sent report: every day from `sinceDay` up to
   * yesterday, plus today once `includeToday` is set. Past days are included so a report missed
   * while the machine was off still goes out.
   */
  pendingReports(today: string, includeToday: boolean, sinceDay: string): { chatId: number; day: string }[] {
    return this.db
      .query<{ chatId: number; day: string }, [string, string, number, string]>(
        `SELECT DISTINCT e.chat_id AS chatId, e.day AS day FROM entries e
         WHERE e.day >= ? AND (e.day < ? OR (? = 1 AND e.day = ?))
           AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.chat_id = e.chat_id AND r.day = e.day)
         ORDER BY e.day, e.chat_id`,
      )
      .all(sinceDay, today, includeToday ? 1 : 0, today)
  }

  markReportSent(chatId: number, day: string, sentAt: string): void {
    this.db.query('INSERT OR REPLACE INTO reports (chat_id, day, sent_at) VALUES (?, ?, ?)').run(chatId, day, sentAt)
  }

  getMeta(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value
  }

  setMeta(key: string, value: string): void {
    this.db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  private hydrate(rows: EntryRow[]): Entry[] {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const itemRows = this.db
      .query<ItemRow, number[]>(
        `SELECT entry_id, name, count, grams, kcal, protein_g, carbs_g, fat_g FROM items
         WHERE entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY entry_id, position`,
      )
      .all(...ids)
    const byEntry = new Map<number, FoodItem[]>()
    for (const i of itemRows) {
      const list = byEntry.get(i.entry_id) ?? []
      list.push({
        name: i.name, count: i.count, grams: i.grams, kcal: i.kcal, proteinG: i.protein_g, carbsG: i.carbs_g, fatG: i.fat_g,
      })
      byEntry.set(i.entry_id, list)
    }
    return rows.map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      messageId: r.message_id,
      userId: r.user_id,
      userName: r.user_name,
      day: r.day,
      createdAt: r.created_at,
      userNote: r.user_note,
      dish: r.dish,
      totalKcal: r.total_kcal,
      proteinG: r.protein_g,
      carbsG: r.carbs_g,
      fatG: r.fat_g,
      confidence: r.confidence,
      modelNote: r.model_note,
      items: byEntry.get(r.id) ?? [],
    }))
  }
}
