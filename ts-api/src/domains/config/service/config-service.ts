import type { ConfigRepository } from '../repository/config-repository.js';
import type { 
  SmartPruningConfig, 
  ConfigResponse, 
  ConfigUpdateRequest,
  TriggerType 
} from '../model/config.js';
import { VALID_TRIGGER_TYPES } from '../model/config.js';
import { parseDuration, isValidDuration } from '../../../shared/utils/duration-parser.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('config-service');

export interface ConfigService {
  getConfig(): Promise<ConfigResponse>;
  updateConfig(update: ConfigUpdateRequest): Promise<ConfigResponse>;
  getFullConfig(): Promise<SmartPruningConfig>; // For internal use (includes timestamps)
  saveFullConfig(config: SmartPruningConfig): Promise<void>; // For internal updates
}

export class BrainSurgeonConfigService implements ConfigService {
  constructor(private repository: ConfigRepository) {}

  async getConfig(): Promise<ConfigResponse> {
    log.debug('loading config');
    const full = await this.repository.load();
    return this.toResponse(full);
  }

  async updateConfig(update: ConfigUpdateRequest): Promise<ConfigResponse> {
    log.debug({ update }, 'updating config');
    // Validate the update
    this.validateUpdate(update);
    
    // Load current config
    const current = await this.repository.load();
    
    // Apply updates
    const updated: SmartPruningConfig = {
      ...current,
      ...update,
      // Preserve timestamps unless explicitly cleared
      last_run_at: update.enabled === false ? null : current.last_run_at,
    };
    
    // Save
    await this.repository.save(updated);
    
    return this.toResponse(updated);
  }

  async getFullConfig(): Promise<SmartPruningConfig> {
    return this.repository.load();
  }

  async saveFullConfig(config: SmartPruningConfig): Promise<void> {
    await this.repository.save(config);
  }

  /**
   * Validate config update request
   * Throws ValidationError with specific message if invalid
   */
  private validateUpdate(update: ConfigUpdateRequest): void {
    // Validate trigger_types
    if (update.trigger_types !== undefined) {
      if (!Array.isArray(update.trigger_types)) {
        throw new ValidationError('trigger_types must be an array');
      }
      
      const invalid = update.trigger_types.filter(
        t => !VALID_TRIGGER_TYPES.includes(t as TriggerType)
      );
      
      if (invalid.length > 0) {
        throw new ValidationError(
          `Invalid trigger_types: ${invalid.join(', ')}. ` +
          `Valid values: ${VALID_TRIGGER_TYPES.join(', ')}`
        );
      }
    }
    
    // Validate age_threshold_hours
    if (update.age_threshold_hours !== undefined) {
      if (typeof update.age_threshold_hours !== 'number' || 
          update.age_threshold_hours < 0 || 
          update.age_threshold_hours > 720) {
        throw new ValidationError(
          'age_threshold_hours must be a number between 0 and 720 (30 days)'
        );
      }
    }
    
    // Validate auto_cron (basic cron validation)
    if (update.auto_cron !== undefined) {
      if (!this.isValidCron(update.auto_cron)) {
        throw new ValidationError(
          'auto_cron must be a valid cron expression (e.g., "*/2 * * * *")'
        );
      }
    }
    
    // Validate retention_cron
    if (update.retention_cron !== undefined) {
      if (!this.isValidCron(update.retention_cron)) {
        throw new ValidationError(
          'retention_cron must be a valid cron expression (e.g., "0 */6 * * *")'
        );
      }
    }
    
    // Validate retention using duration parser
    if (update.retention !== undefined) {
      if (!isValidDuration(update.retention)) {
        throw new ValidationError(
          'retention must be a duration string like "24h", "1d", "7d", "30m". ' +
          'Minimum: 30 minutes (30m), Maximum: 52 weeks (52w)'
        );
      }
    }
    
    // Validate enabled
    if (update.enabled !== undefined && typeof update.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean');
    }
    
    // Validate keep_restore_remote_calls
    if (update.keep_restore_remote_calls !== undefined && 
        typeof update.keep_restore_remote_calls !== 'boolean') {
      throw new ValidationError('keep_restore_remote_calls must be a boolean');
    }
  }

  /**
   * Basic cron expression validation
   * Supports standard 5-part cron: "* * * * *"
   */
  private isValidCron(cron: string): boolean {
    if (typeof cron !== 'string') return false;
    
    // Allow @daily, @hourly, etc.
    if (cron.startsWith('@')) {
      const presets = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly', '@minutely'];
      return presets.includes(cron);
    }
    
    // Standard 5-part cron
    const parts = cron.split(/\s+/);
    if (parts.length !== 5) return false;
    
    // Each part should be valid cron syntax (basic check)
    const validPattern = /^[\d*,/-]+$/;
    return parts.every(p => validPattern.test(p) || p === '*');
  }

  /**
   * Convert full config to API response (omits internal timestamps)
   */
  private toResponse(config: SmartPruningConfig): ConfigResponse {
    return {
      enabled: config.enabled,
      trigger_types: config.trigger_types,
      age_threshold_hours: config.age_threshold_hours,
      auto_cron: config.auto_cron,
      retention: config.retention,
      retention_cron: config.retention_cron,
      keep_restore_remote_calls: config.keep_restore_remote_calls,
    };
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
