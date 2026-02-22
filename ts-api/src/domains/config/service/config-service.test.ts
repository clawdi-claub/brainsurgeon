/**
 * Config Service Tests
 * Tests migration, validation, and CRUD operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BrainSurgeonConfigService } from './config-service.js';
import type { SmartPruningConfig, ConfigRepository } from '../model/config.js';

// Minimal in-memory config repository for testing
class InMemoryConfigRepo implements ConfigRepository {
  private config: SmartPruningConfig = {
    enabled: true,
    trigger_rules: [
      { type: 'thinking', min_length: 500, keep_recent: 3 },
      { type: 'tool_result', min_length: 500, keep_recent: 3 },
    ],
    keep_recent: 3,
    min_value_length: 500,
    scan_interval_seconds: 30,
    auto_cron: '*/2 * * * *',
    last_run_at: null,
    retention: '24h',
    retention_cron: '0 */6 * * *',
    last_retention_run_at: null,
    keep_restore_remote_calls: false,
    keep_after_restore_seconds: 600,
  };

  async load(): Promise<SmartPruningConfig> {
    return { ...this.config };
  }

  async save(config: SmartPruningConfig): Promise<void> {
    this.config = { ...config };
  }
}

describe('BrainSurgeonConfigService', () => {
  let repo: InMemoryConfigRepo;
  let service: BrainSurgeonConfigService;

  beforeEach(() => {
    repo = new InMemoryConfigRepo();
    service = new BrainSurgeonConfigService(repo);
  });

  // =========================================================================
  // Migration: trigger_types → trigger_rules
  // =========================================================================

  describe('migration: trigger_types → trigger_rules', () => {
    it('converts trigger_types[] to trigger_rules[] on update', async () => {
      const update = await service.updateConfig({
        trigger_types: ['thinking', 'tool_result'],
        keep_recent: 5,
        min_value_length: 1000,
      });

      expect(update.trigger_rules).toHaveLength(2);
      expect(update.trigger_rules![0]).toMatchObject({
        type: 'thinking',
        keep_recent: 5,
        min_length: 1000,
      });
      expect(update.trigger_rules![1]).toMatchObject({
        type: 'tool_result',
        keep_recent: 5,
        min_length: 1000,
      });

      // trigger_types should be cleared after migration
      const full = await service.getFullConfig();
      expect(full.trigger_types).toBeUndefined();
    });

    it('uses global defaults when migrating without explicit keep_recent/min_length', async () => {
      // Pre-set config with specific defaults
      await repo.save({
        enabled: true,
        keep_recent: 7,
        min_value_length: 800,
        trigger_rules: [],
        scan_interval_seconds: 30,
        auto_cron: '*/2 * * * *',
        last_run_at: null,
        retention: '24h',
        retention_cron: '0 */6 * * *',
        last_retention_run_at: null,
        keep_restore_remote_calls: false,
        keep_after_restore_seconds: 600,
      });

      const update = await service.updateConfig({
        trigger_types: ['thinking'],
      });

      // Should use repo's current defaults
      expect(update.trigger_rules![0]).toMatchObject({
        type: 'thinking',
        keep_recent: 7,
        min_length: 800,
      });
    });

    it('preserves existing trigger_rules when not updating trigger_types', async () => {
      const original = await service.getFullConfig();
      const originalRules = original.trigger_rules;

      const update = await service.updateConfig({
        keep_recent: 10, // Only updating keep_recent, not rules
      });

      expect(update.trigger_rules).toEqual(originalRules);
    });

    it('allows explicit trigger_rules to override migration', async () => {
      const update = await service.updateConfig({
        trigger_types: ['thinking'], // Should be ignored
        trigger_rules: [
          { type: 'assistant', min_length: 200, keep_chars: 50 },
        ],
      });

      // Explicit rules win
      expect(update.trigger_rules).toHaveLength(1);
      expect(update.trigger_rules![0].type).toBe('assistant');
      expect(update.trigger_rules![0].keep_chars).toBe(50);
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================

  describe('validation', () => {
    it('rejects invalid trigger rule (missing type)', async () => {
      await expect(
        service.updateConfig({
          trigger_rules: [{ min_length: 500 } as any],
        })
      ).rejects.toThrow(/type is required/);
    });

    it('rejects invalid trigger rule (negative min_length)', async () => {
      await expect(
        service.updateConfig({
          trigger_rules: [{ type: 'thinking', min_length: -1 }],
        })
      ).rejects.toThrow(/min_length must be non-negative/);
    });

    it('rejects invalid trigger rule (negative keep_chars)', async () => {
      await expect(
        service.updateConfig({
          trigger_rules: [{ type: 'thinking', keep_chars: -5 }],
        })
      ).rejects.toThrow(/keep_chars must be non-negative/);
    });

    it('rejects invalid trigger rule (negative keep_recent)', async () => {
      await expect(
        service.updateConfig({
          trigger_rules: [{ type: 'thinking', keep_recent: -3 }],
        })
      ).rejects.toThrow(/keep_recent must be non-negative/);
    });

    it('rejects invalid trigger type', async () => {
      await expect(
        service.updateConfig({
          trigger_rules: [{ type: 'invalid_type' } as any],
        })
      ).rejects.toThrow(/invalid trigger type/);
    });

    it('allows wildcard type', async () => {
      const update = await service.updateConfig({
        trigger_rules: [{ type: '*', min_length: 100 }],
      });
      expect(update.trigger_rules![0].type).toBe('*');
    });

    it('allows pipe-delimited role', async () => {
      const update = await service.updateConfig({
        trigger_rules: [{ type: 'thinking', role: 'user|agent' }],
      });
      expect(update.trigger_rules![0].role).toBe('user|agent');
    });
  });

  // =========================================================================
  // CRUD
  // =========================================================================

  describe('getConfig', () => {
    it('returns public config fields only', async () => {
      const config = await service.getConfig();

      // Should have public fields
      expect(config).toHaveProperty('enabled');
      expect(config).toHaveProperty('trigger_rules');
      expect(config).toHaveProperty('keep_recent');
      expect(config).toHaveProperty('min_value_length');

      // Should NOT have internal fields
      expect(config).not.toHaveProperty('last_run_at');
      expect(config).not.toHaveProperty('last_retention_run_at');
    });

    it('includes trigger_rules in response', async () => {
      const config = await service.getConfig();
      expect(Array.isArray(config.trigger_rules)).toBe(true);
      expect(config.trigger_rules!.length).toBeGreaterThan(0);
    });
  });

  describe('getFullConfig', () => {
    it('returns all config fields including timestamps', async () => {
      const full = await service.getFullConfig();

      expect(full).toHaveProperty('enabled');
      expect(full).toHaveProperty('trigger_rules');
      expect(full).toHaveProperty('last_run_at');
      expect(full).toHaveProperty('last_retention_run_at');
    });
  });

  describe('updateConfig', () => {
    it('updates individual fields', async () => {
      const before = await service.getConfig();
      const beforeKeepRecent = before.keep_recent;

      const after = await service.updateConfig({
        keep_recent: beforeKeepRecent + 5,
      });

      expect(after.keep_recent).toBe(beforeKeepRecent + 5);
    });

    it('preserves unmentioned fields', async () => {
      const before = await service.getConfig();
      const beforeMinLength = before.min_value_length;

      await service.updateConfig({
        keep_recent: 99,
      });

      const after = await service.getConfig();
      expect(after.min_value_length).toBe(beforeMinLength);
    });
  });
});
