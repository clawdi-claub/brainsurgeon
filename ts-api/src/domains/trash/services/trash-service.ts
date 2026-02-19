import type { TrashedSession, TrashRepository } from '../repository/trash-repository.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('trash-service');

export class TrashService {
  constructor(private trashRepo: TrashRepository) {}

  async list(): Promise<TrashedSession[]> {
    log.debug('listing trashed sessions');
    return this.trashRepo.list();
  }

  async restore(agentId: string, sessionId: string): Promise<void> {
    log.debug({ agentId, sessionId }, 'restoring session from trash');
    await this.trashRepo.restore(agentId, sessionId);
    log.debug({ agentId, sessionId }, 'session restored from trash');
  }

  async deletePermanently(agentId: string, sessionId: string): Promise<void> {
    await this.trashRepo.deletePermanently(agentId, sessionId);
  }

  async cleanup(): Promise<number> {
    return this.trashRepo.cleanupExpired();
  }
}
