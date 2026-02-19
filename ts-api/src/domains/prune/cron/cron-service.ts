/**
 * Smart Pruning Cron Service
 * Manages scheduled execution of smart pruning and retention cleanup
 */

import cron from 'node-cron';
import type { BrainSurgeonConfigService } from '../../config/service/config-service.js';
import type { SmartPruningConfig } from '../../config/model/config.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('cron-service');

export interface CronJob {
  name: string;
  expression: string;
  task: () => Promise<void>;
  isRunning: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
}

export interface CronService {
  start(): void;
  stop(): void;
  getJobs(): CronJob[];
  runJobNow(name: string): Promise<void>;
  reloadConfig(config: SmartPruningConfig): void;
}

/**
 * Smart Pruning Cron Service
 * Manages two cron jobs:
 * 1. Auto-trigger: Runs smart pruning based on auto_cron schedule
 * 2. Retention cleanup: Deletes old extracted files based on retention_cron
 */
export class SmartPruningCronService implements CronService {
  private jobs: Map<string, cron.ScheduledTask> = new Map();
  private jobStatus: Map<string, CronJob> = new Map();
  private configService: BrainSurgeonConfigService;
  private pruningExecutor: PruningExecutor;
  private isStarted = false;

  constructor(
    configService: BrainSurgeonConfigService,
    pruningExecutor: PruningExecutor
  ) {
    this.configService = configService;
    this.pruningExecutor = pruningExecutor;
  }

  /**
   * Start the cron service with current config
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      log.debug('cron service already started');
      return;
    }

    const config = await this.configService.getFullConfig();
    
    // Schedule auto-trigger job
    if (config.enabled) {
      this.scheduleJob('auto-trigger', config.auto_cron, async () => {
        await this.runSmartPruning(config);
      });
    }

    // Schedule retention cleanup job
    this.scheduleJob('retention-cleanup', config.retention_cron, async () => {
      await this.runRetentionCleanup(config);
    });

    this.isStarted = true;
    log.info('cron service started');
  }

  /**
   * Stop all cron jobs
   */
  stop(): void {
    for (const [name, task] of this.jobs) {
      task.stop();
      log.debug({ job: name }, 'stopped cron job');
    }
    this.jobs.clear();
    this.isStarted = false;
    log.info('cron service stopped');
  }

  /**
   * Reload configuration and reschedule jobs
   */
  async reloadConfig(config: SmartPruningConfig): Promise<void> {
    log.info('reloading cron config');
    
    // Stop existing jobs
    this.stop();
    
    // Restart with new config
    if (config.enabled) {
      this.scheduleJob('auto-trigger', config.auto_cron, async () => {
        await this.runSmartPruning(config);
      });
    }
    
    this.scheduleJob('retention-cleanup', config.retention_cron, async () => {
      await this.runRetentionCleanup(config);
    });
    
    this.isStarted = true;
    log.info('cron config reloaded');
  }

  /**
   * Get status of all jobs
   */
  getJobs(): CronJob[] {
    return Array.from(this.jobStatus.values());
  }

  /**
   * Manually trigger a job
   */
  async runJobNow(name: string): Promise<void> {
    const job = this.jobStatus.get(name);
    if (!job) {
      throw new Error(`Unknown job: ${name}`);
    }

    log.info({ job: name }, 'manual job trigger');
    await job.task();
  }

  /**
   * Schedule a cron job
   */
  private scheduleJob(
    name: string,
    expression: string,
    task: () => Promise<void>
  ): void {
    // Stop existing job if any
    const existing = this.jobs.get(name);
    if (existing) {
      existing.stop();
    }

    // Validate cron expression
    if (!cron.validate(expression)) {
      log.error({ job: name, expression }, 'invalid cron expression');
      return;
    }

    // Create scheduled task
    const scheduledTask = cron.schedule(expression, async () => {
      const job = this.jobStatus.get(name);
      if (job?.isRunning) {
        log.debug({ job: name }, 'skipping — already running');
        return;
      }

      try {
        this.jobStatus.set(name, { ...job!, isRunning: true, lastRun: new Date() });
        log.debug({ job: name }, 'starting job');
        await task();
        log.debug({ job: name }, 'job completed');
      } catch (err: any) {
        log.error({ job: name, err }, 'job failed');
      } finally {
        const updated = this.jobStatus.get(name)!;
        this.jobStatus.set(name, { ...updated, isRunning: false });
      }
    });

    // Store job status
    this.jobStatus.set(name, {
      name,
      expression,
      task,
      isRunning: false,
      lastRun: null,
      nextRun: this.getNextRunDate(expression),
    });

    this.jobs.set(name, scheduledTask);
    scheduledTask.start();
    
    log.info({ job: name, expression }, 'scheduled cron job');
  }

  /**
   * Run smart pruning across all sessions
   */
  private async runSmartPruning(config: SmartPruningConfig): Promise<void> {
    const startTime = Date.now();
    log.info('starting smart prune run');
    
    try {
      const result = await this.pruningExecutor.runSmartPruning(config);
      
      // Update last_run_at timestamp
      await this.configService.saveFullConfig({
        ...config,
        last_run_at: new Date().toISOString(),
      });
      
      const duration = Date.now() - startTime;
      log.info({
        durationMs: duration,
        sessionsScanned: result.sessionsScanned,
        entriesExtracted: result.entriesExtracted,
        bytesSaved: result.bytesSaved,
      }, 'smart prune completed');
    } catch (err: any) {
      log.error({ err }, 'smart prune failed');
      throw err;
    }
  }

  /**
   * Run retention cleanup
   */
  private async runRetentionCleanup(config: SmartPruningConfig): Promise<void> {
    const startTime = Date.now();
    log.info('starting retention cleanup');
    
    try {
      const result = await this.pruningExecutor.runRetentionCleanup(config.retention);
      
      // Update last_retention_run_at timestamp
      await this.configService.saveFullConfig({
        ...config,
        last_retention_run_at: new Date().toISOString(),
      });
      
      const duration = Date.now() - startTime;
      log.info({
        durationMs: duration,
        filesDeleted: result.filesDeleted,
        bytesReclaimed: result.bytesReclaimed,
      }, 'retention cleanup completed');
    } catch (err: any) {
      log.error({ err }, 'retention cleanup failed');
      throw err;
    }
  }

  /**
   * Calculate next run date from cron expression
   */
  private getNextRunDate(expression: string): Date | null {
    try {
      // Simple approximation - parse cron and add to current time
      // For more accurate prediction, use a cron parser library
      return null; // Will be updated on first run
    } catch {
      return null;
    }
  }
}

/**
 * Interface for pruning operations
 * Implemented by the actual pruning service
 */
export interface PruningExecutor {
  runSmartPruning(config: SmartPruningConfig): Promise<{
    sessionsScanned: number;
    entriesExtracted: number;
    bytesSaved: number;
  }>;
  
  runRetentionCleanup(retention: string): Promise<{
    filesDeleted: number;
    bytesReclaimed: number;
  }>;
}
