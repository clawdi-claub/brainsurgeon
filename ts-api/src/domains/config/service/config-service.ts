import type { ConfigRepository } from '../repository/config-repository.js';
import type { 
  SmartPruningConfig, 
  ConfigResponse, 
  ConfigUpdateRequest,
  TriggerType,
  TriggerRule
} from '../model/config.js';
import { VALID_TRIGGER_TYPES, migrateTriggerTypesToRules, buildEffectiveRules } from '../model/config.js';
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
    
    // Migrate trigger_types to trigger_rules if needed
    if (update.trigger_types !== undefined && update.trigger_rules === undefined) {
      log.info({ trigger_types: update.trigger_types }, 'migrating trigger_types to trigger_rules');
      update.trigger_rules = migrateTriggerTypesToRules(
        update.trigger_types,
        update.keep_recent ?? current.keep_recent,
        update.min_value_length ?? current.min_value_length
      );
      // Clear trigger_types after migration
      update.trigger_types = undefined;
    }
    
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
    
    // Validate trigger_rules (new granular config)
    if (update.trigger_rules !== undefined) {
      this.validateTriggerRules(update.trigger_rules);
    }
    
    // Validate keep_recent
    if (update.keep_recent !== undefined) {
      if (typeof update.keep_recent !== 'number' || 
          update.keep_recent < 0 || 
          update.keep_recent > 100) {
        throw new ValidationError(
          'keep_recent must be a number between 0 and 100 (messages to keep in context)'
        );
      }
    }
    
    // Validate min_value_length
    if (update.min_value_length !== undefined) {
      if (typeof update.min_value_length !== 'number' || 
          update.min_value_length < 0 || 
          update.min_value_length > 100000) {
        throw new ValidationError(
          'min_value_length must be a number between 0 and 100000 (characters)'
        );
      }
    }
    
    // Validate scan_interval_seconds
    if (update.scan_interval_seconds !== undefined) {
      if (typeof update.scan_interval_seconds !== 'number' || 
          update.scan_interval_seconds < 10 || 
          update.scan_interval_seconds > 3600) {
        throw new ValidationError(
          'scan_interval_seconds must be a number between 10 and 3600 (10 seconds to 1 hour)'
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
    
    // Validate keep_after_restore_seconds
    if (update.keep_after_restore_seconds !== undefined) {
      if (typeof update.keep_after_restore_seconds !== 'number' || 
          update.keep_after_restore_seconds < 0 || 
          update.keep_after_restore_seconds > 86400) {
        throw new ValidationError(
          'keep_after_restore_seconds must be a number between 0 and 86400 (0 to 24 hours)'
        );
      }
    }
  }

  /**
   * Validate trigger rules array
   */
  private validateTriggerRules(rules: TriggerRule[]): void {
    if (!Array.isArray(rules)) {
      throw new ValidationError('trigger_rules must be an array');
    }

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      
      // Required: type
      if (!rule.type || typeof rule.type !== 'string') {
        throw new ValidationError(`trigger_rules[${i}]: type is required and must be a string`);
      }

      // Validate type is valid (or wildcard '*')
      if (rule.type !== '*' && !VALID_TRIGGER_TYPES.includes(rule.type as TriggerType)) {
        throw new ValidationError(
          `trigger_rules[${i}]: invalid trigger type '${rule.type}'. ` +
          `Valid values: ${VALID_TRIGGER_TYPES.join(', ')}, or '*' for wildcard`
        );
      }

      // Optional: min_length
      if (rule.min_length !== undefined) {
        if (typeof rule.min_length !== 'number' || rule.min_length < 0 || rule.min_length > 100000) {
          throw new ValidationError(
            `trigger_rules[${i}].min_length must be non-negative and at most 100000`
          );
        }
      }

      // Optional: keep_chars
      if (rule.keep_chars !== undefined) {
        if (typeof rule.keep_chars !== 'number' || rule.keep_chars < 0 || rule.keep_chars > 10000) {
          throw new ValidationError(
            `trigger_rules[${i}].keep_chars must be non-negative and at most 10000`
          );
        }
      }

      // Optional: role
      if (rule.role !== undefined && typeof rule.role !== 'string') {
        throw new ValidationError(`trigger_rules[${i}].role must be a string`);
      }

      // Optional: keep_recent
      if (rule.keep_recent !== undefined) {
        if (typeof rule.keep_recent !== 'number' || rule.keep_recent < 0 || rule.keep_recent > 100) {
          throw new ValidationError(
            `trigger_rules[${i}].keep_recent must be non-negative and at most 100`
          );
        }
      }

      // Validate generic matchers (string or number values only)
      const reservedKeys = ['type', 'min_length', 'keep_chars', 'role', 'keep_recent'];
      for (const key of Object.keys(rule)) {
        if (reservedKeys.includes(key)) continue;
        
        const value = rule[key];
        if (typeof value !== 'string' && typeof value !== 'number') {
          throw new ValidationError(
            `trigger_rules[${i}].${key} must be a string or number (generic matcher)`
          );
        }
      }
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
      trigger_rules: config.trigger_rules,
      trigger_types: config.trigger_types, // Include for backward compatibility
      keep_recent: config.keep_recent,
      min_value_length: config.min_value_length,
      scan_interval_seconds: config.scan_interval_seconds,
      auto_cron: config.auto_cron,
      retention: config.retention,
      retention_cron: config.retention_cron,
      keep_restore_remote_calls: config.keep_restore_remote_calls,
      keep_after_restore_seconds: config.keep_after_restore_seconds,
    };
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
