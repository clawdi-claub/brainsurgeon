import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Message, MessageBus, MessageHandler, MessageType } from './types.js';
import { createLogger } from '../../shared/logging/logger.js';

const log = createLogger('message-bus');

// Use node:sqlite (built-in since Node 22.5+) — matches OpenClaw memory provider pattern:
// https://github.com/openclaw/openclaw/blob/main/src/memory/sqlite.ts
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

interface SqliteMessageRow {
  id: string;
  type: string;
  payload: string;
  timestamp: number;
  source: string;
  processed: number;
  processed_at: number | null;
  retry_count: number;
}

export class SqliteMessageBus implements MessageBus {
  private db: InstanceType<typeof DatabaseSync>;
  private handlers = new Map<MessageType, Set<MessageHandler<unknown>>>();
  private running = false;
  private processInterval: NodeJS.Timeout | null = null;
  private readonly maxRetries = 3;
  private readonly source: 'extension' | 'api';

  constructor(dbPath: string, source: 'extension' | 'api' = 'api') {
    this.db = new DatabaseSync(dbPath);
    this.source = source;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        processed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
      CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `);
    // WAL mode for concurrent readers
    this.db.exec('PRAGMA journal_mode=WAL');
  }

  async publish<T>(type: MessageType, payload: T): Promise<void> {
    const id = randomUUID();
    const timestamp = Date.now();

    log.debug({ type, source: this.source, id }, 'publishing message');

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, type, payload, timestamp, source, processed)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    stmt.run(id, type, JSON.stringify(payload), timestamp, this.source);
  }

  subscribe<T>(type: MessageType, handler: MessageHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as MessageHandler<unknown>);
    log.debug({ type, source: this.source }, 'subscribed to message type');

    return () => {
      this.handlers.get(type)?.delete(handler as MessageHandler<unknown>);
    };
  }

  async getUnprocessed(): Promise<Message[]> {
    const stmt = this.db.prepare(`
      SELECT id, type, payload, timestamp, source, processed, processed_at, retry_count
      FROM messages
      WHERE processed = 0
        AND retry_count < ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(this.maxRetries) as unknown as SqliteMessageRow[];

    return rows.map(row => ({
      id: row.id,
      type: row.type as MessageType,
      payload: JSON.parse(row.payload),
      timestamp: row.timestamp,
      source: row.source as 'extension' | 'api',
      processed: Boolean(row.processed),
      processedAt: row.processed_at ?? undefined,
    }));
  }

  async markProcessed(id: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE messages 
      SET processed = 1, processed_at = ?
      WHERE id = ?
    `);
    stmt.run(Date.now(), id);
  }

  async incrementRetry(id: string, error: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE messages 
      SET retry_count = retry_count + 1, error = ?
      WHERE id = ?
    `);
    stmt.run(error.slice(0, 1000), id);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.debug({ source: this.source }, 'message bus starting');

    // Process any unprocessed messages first (replay)
    await this.processMessages();

    // Start polling (100ms)
    this.processInterval = setInterval(() => {
      void this.processMessages();
    }, 100);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
    log.debug({ source: this.source }, 'message bus stopped');
  }

  private async processMessages(): Promise<void> {
    const messages = await this.getUnprocessed();

    for (const message of messages) {
      const handlers = this.handlers.get(message.type);

      if (!handlers || handlers.size === 0) {
        await this.markProcessed(message.id);
        continue;
      }

      for (const handler of handlers) {
        try {
          await handler(message);
        } catch (error) {
          log.error({ type: message.type, err: error }, 'message handler failed');
          await this.incrementRetry(message.id, String(error));
          continue;
        }
      }

      await this.markProcessed(message.id);
    }
  }

  close(): void {
    this.stop();
    this.db.close();
  }
}
