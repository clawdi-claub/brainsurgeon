/**
 * Smart Pruning Cron Service
 * Manages scheduled execution of smart pruning and retention cleanup
 */

import cron from 'node-cron';
import type { BrainSurgeonConfigService } from '../../config/service/config-service.js';
import type { SmartPruningConfig } from '../../config/model/config.js';

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
      console.log('[Cron] Already started');
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
    console.log('[Cron] Service started');
  }

  /**
   * Stop all cron jobs
   */
  stop(): void {
    for (const [name, task] of this.jobs) {
      task.stop();
      console.log(`[Cron] Stopped job: ${name}`);
    }
    this.jobs.clear();
    this.isStarted = false;
    console.log('[Cron] Service stopped');
  }

  /**
   * Reload configuration and reschedule jobs
   */
  async reloadConfig(config: SmartPruningConfig): Promise<void> {
    console.log('[Cron] Reloading config...');
    
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
    console.log('[Cron] Config reloaded');
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

    console.log(`[Cron] Manual run: ${name}`);
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
      console.error(`[Cron] Invalid expression for ${name}: ${expression}`);
      return;
    }

    // Create scheduled task
    const scheduledTask = cron.schedule(expression, async () => {
      const job = this.jobStatus.get(name);
      if (job?.isRunning) {
        console.log(`[Cron] Skipping ${name} - already running`);
        return;
      }

      try {
        this.jobStatus.set(name, { ...job!, isRunning: true, lastRun: new Date() });
        console.log(`[Cron] Starting: ${name}`);
        await task();
        console.log(`[Cron] Completed: ${name}`);
      } catch (err: any) {
        console.error(`[Cron] Failed: ${name}`, err.message);
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
    
    console.log(`[Cron] Scheduled: ${name} (${expression})`);
  }

  /**
   * Run smart pruning across all sessions
   */
  private async runSmartPruning(config: SmartPruningConfig): Promise<void> {
    const startTime = Date.now();
    console.log('[SmartPrune] Starting auto-trigger run...');
    
    try {
      const result = await this.pruningExecutor.runSmartPruning(config);
      
      // Update last_run_at timestamp
      await this.configService.saveFullConfig({
        ...config,
        last_run_at: new Date().toISOString(),
      });
      
      const duration = Date.now() - startTime;
      console.log(`[SmartPrune] Completed in ${duration}ms:`, {
        sessionsScanned: result.sessionsScanned,
        entriesExtracted: result.entriesExtracted,
        bytesSaved: result.bytesSaved,
      });
    } catch (err: any) {
      console.error('[SmartPrune] Failed:', err.message);
      throw err;
    }
  }

  /**
   * Run retention cleanup
   */
  private async runRetentionCleanup(config: SmartPruningConfig): Promise<void> {
    const startTime = Date.now();
    console.log('[Retention] Starting cleanup...');
    
    try {
      const result = await this.pruningExecutor.runRetentionCleanup(config.retention);
      
      // Update last_retention_run_at timestamp
      await this.configService.saveFullConfig({
        ...config,
        last_retention_run_at: new Date().toISOString(),
      });
      
      const duration = Date.now() - startTime;
      console.log(`[Retention] Completed in ${duration}ms:`, {
        filesDeleted: result.filesDeleted,
        bytesReclaimed: result.bytesReclaimed,
      });
    } catch (err: any) {
      console.error('[Retention] Failed:', err.message);
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
