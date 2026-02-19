import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { SmartPruningConfig } from '../model/config.js';

export interface ConfigRepository {
  load(): Promise<SmartPruningConfig>;
  save(config: SmartPruningConfig): Promise<void>;
  exists(): Promise<boolean>;
}

/**
 * File-based config repository
 * Stores config at {agentsDir}/../.brainsurgeon/config.json
 */
export class FileSystemConfigRepository implements ConfigRepository {
  private configPath: string;

  constructor(agentsDir: string) {
    // Config stored at {agentsDir}/../.brainsurgeon/config.json
    this.configPath = join(agentsDir, '..', '.brainsurgeon', 'config.json');
  }

  async load(): Promise<SmartPruningConfig> {
    try {
      const content = await readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(content) as Partial<SmartPruningConfig>;
      
      // Merge with defaults (handles missing fields / migration)
      return this.mergeWithDefaults(parsed);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // Config file doesn't exist - return defaults
        return this.mergeWithDefaults({});
      }
      throw new Error(`Failed to load config: ${err.message}`);
    }
  }

  async save(config: SmartPruningConfig): Promise<void> {
    // Ensure directory exists
    await mkdir(dirname(this.configPath), { recursive: true });
    
    // Write with pretty formatting for human readability
    const content = JSON.stringify(config, null, 2);
    await writeFile(this.configPath, content, 'utf8');
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.configPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Merge partial config with defaults
   * Handles migration when new fields are added
   */
  private mergeWithDefaults(partial: Partial<SmartPruningConfig>): SmartPruningConfig {
    return {
      enabled: partial.enabled ?? false,
      trigger_types: partial.trigger_types ?? ['thinking', 'tool_result'],
      age_threshold_hours: partial.age_threshold_hours ?? 24,
      auto_cron: partial.auto_cron ?? '*/2 * * * *',
      last_run_at: partial.last_run_at ?? null,
      retention: partial.retention ?? '24h',
      retention_cron: partial.retention_cron ?? '0 */6 * * *',
      last_retention_run_at: partial.last_retention_run_at ?? null,
      keep_restore_remote_calls: partial.keep_restore_remote_calls ?? false,
    };
  }
}
