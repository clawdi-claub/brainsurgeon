import { Hono } from 'hono';
import type { CronService } from '../cron/cron-service.js';
import type { BrainSurgeonConfigService } from '../../config/service/config-service.js';

export function createCronRoutes(
  cronService: CronService,
  configService: BrainSurgeonConfigService
) {
  const app = new Hono();

  /**
   * GET /api/cron/jobs
   * List all cron jobs and their status
   */
  app.get('/jobs', (c) => {
    const jobs = cronService.getJobs().map(job => ({
      name: job.name,
      expression: job.expression,
      is_running: job.isRunning,
      last_run: job.lastRun?.toISOString() || null,
      next_run: job.nextRun?.toISOString() || null,
    }));

    return c.json({ jobs });
  });

  /**
   * POST /api/cron/jobs/:name/run
   * Manually trigger a cron job
   */
  app.post('/jobs/:name/run', async (c) => {
    const name = c.req.param('name');
    
    try {
      await cronService.runJobNow(name);
      return c.json({ 
        success: true, 
        message: `Job "${name}" executed successfully`,
        name,
      });
    } catch (err: any) {
      return c.json({ 
        success: false, 
        error: err.message,
        name,
      }, 400);
    }
  });

  /**
   * POST /api/cron/reload
   * Reload cron configuration and reschedule jobs
   */
  app.post('/reload', async (c) => {
    try {
      const config = await configService.getFullConfig();
      await cronService.reloadConfig(config);
      
      return c.json({ 
        success: true, 
        message: 'Cron configuration reloaded',
        enabled: config.enabled,
        auto_cron: config.auto_cron,
        retention_cron: config.retention_cron,
      });
    } catch (err: any) {
      return c.json({ 
        success: false, 
        error: err.message,
      }, 500);
    }
  });

  /**
   * GET /api/cron/status
   * Quick status check for cron service
   */
  app.get('/status', (c) => {
    const jobs = cronService.getJobs();
    
    return c.json({
      active: jobs.length > 0,
      job_count: jobs.length,
      jobs: jobs.map(j => ({
        name: j.name,
        is_running: j.isRunning,
        last_run: j.lastRun?.toISOString() || null,
      })),
    });
  });

  return app;
}
