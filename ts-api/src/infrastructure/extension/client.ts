// OpenClaw Extension client
// Subscribes to session events and forwards via message bus

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { MessageBus } from '../bus/types.js';

interface ExtensionConfig {
  openclawPath: string;
  agentId: string;
}

/**
 * Extension client that connects to OpenClaw Gateway
 * Subscribes to session events: transcript updates, compaction
 * Forwards events via message bus to API
 */
export class OpenClawExtensionClient {
  private bus: MessageBus;
  private config: ExtensionConfig;
  private running = false;

  constructor(bus: MessageBus, config: ExtensionConfig) {
    this.bus = bus;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Subscribe to events from OpenClaw
    // In production, this would use OpenClaw's event system
    // For now, we poll or use file watching
    
    // TODO: Implement actual OpenClaw event subscription
    // This requires Gateway API access or extension hooks

    // Stub — will be removed (kb-115)
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /**
   * Trigger compact session via OpenClaw Gateway
   * This requires OpenClaw CLI or Gateway API access
   */
  async requestCompact(agentId: string, sessionId: string): Promise<void> {
    // Stub implementation
    // Would call: openclaw session compact --agent {agentId} --session {sessionId}
    // Stub — will be removed (kb-115)
  }

  /**
   * Restore externalized response via tool call
   * Injects restore_response tool call into session
   */
  async restoreResponse(agentId: string, sessionId: string, toolCallId: string): Promise<void> {
    // Publish to bus - API will handle the actual rehydration
    await this.bus.publish('restore.request', {
      agentId,
      sessionId,
      toolCallId,
    });
  }
}
