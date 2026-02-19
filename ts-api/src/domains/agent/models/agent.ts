// Agent domain - list and manage agents

export interface Agent {
  id: string;
  name?: string;
  description?: string;
  sessionCount: number;
  totalTokens?: number;
  lastActive?: number;
}

export interface AgentRepository {
  list(): Promise<Agent[]>;
  get(agentId: string): Promise<Agent | null>;
  exists(agentId: string): Promise<boolean>;
}
