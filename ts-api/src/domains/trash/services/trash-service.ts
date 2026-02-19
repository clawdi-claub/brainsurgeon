import type { TrashedSession, TrashRepository } from '../repository/trash-repository.js';

export class TrashService {
  constructor(private trashRepo: TrashRepository) {}

  async list(): Promise<TrashedSession[]> {
    return this.trashRepo.list();
  }

  async restore(agentId: string, sessionId: string): Promise<void> {
    await this.trashRepo.restore(agentId, sessionId);
  }

  async deletePermanently(agentId: string, sessionId: string): Promise<void> {
    await this.trashRepo.deletePermanently(agentId, sessionId);
  }
}
