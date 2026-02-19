// Message bus types for Extension ↔ API communication
// SQLite-based for ACID guarantees and persistence

export type MessageType = 
  | 'session.updated'      // Transcript updated
  | 'session.compacted'    // Session compacted
  | 'prune.request'        // Request pruning
  | 'prune.response'       // Pruning complete
  | 'restore.request'      // Request restore_response
  | 'restore.response';    // Restore complete

export interface Message {
  id: string;
  type: MessageType;
  payload: unknown;
  timestamp: number;
  source: 'extension' | 'api';
  processed: boolean;
  processedAt?: number;
}

export type SessionUpdatedPayload = {
  agentId: string;
  sessionId: string;
  entryCount: number;
  lastEntryType: string;
};

export type SessionCompactedPayload = {
  agentId: string;
  sessionId: string;
  entriesBefore: number;
  entriesAfter: number;
};

export type PruneRequestPayload = {
  agentId: string;
  sessionId: string;
  threshold?: number;  // Messages since tool response
};

export type PruneResponsePayload = {
  agentId: string;
  sessionId: string;
  externalized: number;
  success: boolean;
  error?: string;
};

export type RestoreRequestPayload = {
  agentId: string;
  sessionId: string;
  toolCallId: string;
};

export type RestoreResponsePayload = {
  agentId: string;
  sessionId: string;
  toolCallId: string;
  success: boolean;
  error?: string;
};

export interface MessageHandler<T = unknown> {
  (message: Message & { payload: T }): Promise<void> | void;
}

export interface MessageBus {
  // Publish message to bus
  publish<T>(type: MessageType, payload: T): Promise<void>;
  
  // Subscribe to message type
  subscribe<T>(type: MessageType, handler: MessageHandler<T>): () => void;
  
  // Get unprocessed messages (for replay on restart)
  getUnprocessed(): Promise<Message[]>;
  
  // Mark message as processed
  markProcessed(id: string): Promise<void>;
  
  // Start processing loop
  start(): Promise<void>;
  
  // Stop processing loop
  stop(): Promise<void>;
}
