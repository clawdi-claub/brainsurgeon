import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Message, MessageBus, MessageHandler, MessageType } from './types.js';

interface SqliteMessageRow {
  id: string;
  type: string;
  payload: string;
  timestamp: number;
  source: string;
  processed: number;
  processed_at: number | null;
}

export class SqliteMessageBus implements MessageBus {
  private db: Database.Database;
  private handlers = new Map<MessageType, Set<MessageHandler<unknown>>>();
  private running = false;
  private processInterval: NodeJS.Timeout | null = null;
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
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
  }

  async publish<T>(type: MessageType, payload: T): Promise<void> {
    const message: Message = {
      id: randomUUID(),
      type,
      payload,
      timestamp: Date.now(),
      source: this.isExtension() ? 'extension' : 'api',
      processed: false,
    };

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, type, payload, timestamp, source, processed)
      VALUES (?, ?, ?, ?, ?, 0)
    `);

    stmt.run(message.id, message.type, JSON.stringify(message.payload), message.timestamp, message.source);
  }

  subscribe<T>(type: MessageType, handler: MessageHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as MessageHandler<unknown>);

    return () => {
      this.handlers.get(type)?.delete(handler as MessageHandler<unknown>);
    };
  }

  async getUnprocessed(): Promise<Message[]> {
    const stmt = this.db.prepare(`
      SELECT id, type, payload, timestamp, source, processed, processed_at as processedAt
      FROM messages
      WHERE processed = 0
        AND retry_count < ?
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all(this.maxRetries) as SqliteMessageRow[];
    
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
    
    stmt.run(error.slice(0, 1000), id); // Limit error length
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Process any unprocessed messages first (replay)
    await this.processMessages();

    // Start polling
    this.processInterval = setInterval(() => {
      void this.processMessages();
    }, 100); // 100ms polling
  }

  async stop(): Promise<void> {
    this.running = false;
    
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
  }

  private async processMessages(): Promise<void> {
    const messages = await this.getUnprocessed();
    
    for (const message of messages) {
      const handlers = this.handlers.get(message.type);
      
      if (!handlers || handlers.size === 0) {
        // No handler, mark as processed to avoid reprocessing
        await this.markProcessed(message.id);
        continue;
      }

      for (const handler of handlers) {
        try {
          await handler(message);
        } catch (error) {
          console.error(`Message handler failed for ${message.type}:`, error);
          await this.incrementRetry(message.id, String(error));
          continue; // Don't mark processed, will retry
        }
      }

      await this.markProcessed(message.id);
    }
  }

  private isExtension(): boolean {
    // Detect if running in extension context vs API context
    // Extension runs in OpenClaw, API runs as standalone process
    return typeof process.env.OPENCLAW_EXTENSION !== 'undefined';
  }

  close(): void {
    this.db.close();
  }
}
