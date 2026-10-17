import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AI_SETTINGS, type AiConversation, type AiConversationSummary, type AiMessage, type AiSettings } from '@shared/ai.js'
import { aiConnectionSettingsSchema } from '@shared/ai-schema.js'

interface ConversationRow { id: string; title: string; preview: string; created_at: string; updated_at: string; revision: number }
interface MessageRow { json: string }
const summary = (row: ConversationRow): AiConversationSummary => ({ id: row.id, title: row.title, preview: row.preview, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision })

/** Separate, lazily opened local storage: AI history never delays the music database startup. */
export class AiStore {
  private readonly db: Database.Database
  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, token TEXT);
      CREATE TABLE IF NOT EXISTS ai_conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ai_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS ai_context (conversation_id TEXT PRIMARY KEY REFERENCES ai_conversations(id) ON DELETE CASCADE, through_message_id TEXT NOT NULL, summary TEXT NOT NULL);
    `)
    const columns = this.db.prepare('PRAGMA table_info(ai_settings)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'verified')) this.db.exec('ALTER TABLE ai_settings ADD COLUMN verified INTEGER NOT NULL DEFAULT 0')
    if (!columns.some(column => column.name === 'revision')) this.db.exec('ALTER TABLE ai_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    // Keep interrupted content and make retry available after a crash or forced exit.
    this.db.exec(`UPDATE ai_messages SET json = json_set(json, '$.status', 'cancelled', '$.error', '上次回复已中断，可以重试。', '$.revision', json_extract(json, '$.revision') + 1) WHERE json_extract(json, '$.status') = 'streaming'`)
  }
  settings(): { settings: AiSettings; token: string | null; verified: boolean; revision: number } {
    const row = this.db.prepare('SELECT json, token, verified, revision FROM ai_settings WHERE id=1').get() as { json: string; token: string | null; verified: number; revision: number } | undefined
    return { settings: row ? aiConnectionSettingsSchema.parse(JSON.parse(row.json)) : { ...DEFAULT_AI_SETTINGS }, token: row?.token ?? null, verified: !!row?.verified, revision: row?.revision ?? 0 }
  }
  saveSettings(settings: AiSettings, token: string | null, verified = false): void {
    this.db.prepare('INSERT INTO ai_settings(id,json,token,verified,revision) VALUES(1,?,?,?,1) ON CONFLICT(id) DO UPDATE SET json=excluded.json, token=excluded.token, verified=excluded.verified, revision=revision+1').run(JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model }), token, Number(verified))
  }
  context(id: string): { throughMessageId: string; summary: string } | null {
    const row = this.db.prepare('SELECT through_message_id, summary FROM ai_context WHERE conversation_id=?').get(id) as { through_message_id: string; summary: string } | undefined
    return row ? { throughMessageId: row.through_message_id, summary: row.summary } : null
  }
  saveContext(id: string, context: { throughMessageId: string; summary: string }): void {
    this.db.prepare('INSERT INTO ai_context(conversation_id,through_message_id,summary) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET through_message_id=excluded.through_message_id, summary=excluded.summary').run(id, context.throughMessageId, context.summary)
  }
  setVerified(revision: number, verified: boolean): boolean {
    return !!this.db.prepare('UPDATE ai_settings SET verified=? WHERE id=1 AND revision=?').run(Number(verified), revision).changes
  }
  list(): AiConversationSummary[] {
    return (this.db.prepare('SELECT * FROM ai_conversations ORDER BY updated_at DESC, rowid DESC').all() as ConversationRow[]).map(summary)
  }
  get(id: string): AiConversation | null {
    const row = this.db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(id) as ConversationRow | undefined
    return row ? { ...summary(row), messages: (this.db.prepare('SELECT json FROM ai_messages WHERE conversation_id=? ORDER BY seq').all(id) as MessageRow[]).map(item => JSON.parse(item.json) as AiMessage) } : null
  }
  create(): AiConversation {
    const id = randomUUID(), now = new Date().toISOString()
    this.db.prepare('INSERT INTO ai_conversations(id,title,preview,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, '新对话', '', now, now)
    return { id, title: '新对话', preview: '', createdAt: now, updatedAt: now, revision: 0, messages: [] }
  }
  rename(id: string, title: string): void {
    if (!this.db.prepare('UPDATE ai_conversations SET title=?, updated_at=?, revision=revision+1 WHERE id=?').run(title, new Date().toISOString(), id).changes) throw new Error('对话已不存在。')
  }
  delete(id: string): void { this.db.prepare('DELETE FROM ai_conversations WHERE id=?').run(id) }
  begin(id: string, user: AiMessage | null, assistant: AiMessage, replaceId?: string): AiConversation {
    this.db.transaction(() => {
      const conversation = this.get(id)
      if (!conversation) throw new Error('对话已不存在。')
      if (replaceId) this.db.prepare('DELETE FROM ai_messages WHERE id=? AND conversation_id=?').run(replaceId, id)
      if (user) {
        this.insert(user)
        if (!conversation.messages.length && conversation.title === '新对话') this.rename(id, user.text.replace(/\s+/g, ' ').slice(0, 48) || '图片对话')
        this.db.prepare('UPDATE ai_conversations SET preview=?,updated_at=? WHERE id=?').run(user.text.slice(0, 100) || `[图片] ${user.images[0]?.name ?? ''}`, assistant.createdAt, id)
      }
      this.insert(assistant)
      this.db.prepare('UPDATE ai_conversations SET revision=revision+1, updated_at=? WHERE id=?').run(assistant.createdAt, id)
    })()
    return this.get(id)!
  }
  private insert(message: AiMessage): void {
    this.db.prepare('INSERT INTO ai_messages(id,conversation_id,json) VALUES(?,?,?)').run(message.id, message.conversationId, JSON.stringify(message))
  }
  update(message: AiMessage): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE ai_messages SET json=? WHERE id=?').run(JSON.stringify(message), message.id)
      this.db.prepare('UPDATE ai_conversations SET updated_at=?, revision=revision+1 WHERE id=?').run(new Date().toISOString(), message.conversationId)
    })()
  }
  close(): void { this.db.close() }
}
