/**
 * Extracted file trash operations — move/restore/delete extracted dirs alongside sessions.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtractionStorage } from './extraction-storage.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('extraction-trash');

/**
 * Resolve the trash path for an extracted session dir.
 * Layout: {openclaw-root}/trash/{agent}_{sessionId}_extracted/
 */
function trashPath(agentsDir: string, agentId: string, sessionId: string): string {
  return join(agentsDir, '..', 'trash', `${agentId}_${sessionId}_extracted`);
}

/**
 * Move extracted files dir to trash.
 */
export async function moveExtractedToTrash(
  storage: ExtractionStorage,
  agentId: string,
  sessionId: string,
): Promise<void> {
  const srcDir = storage.extractedDir(agentId, sessionId);
  const destDir = trashPath(storage.getAgentsDir(), agentId, sessionId);
  const trashBase = join(destDir, '..');
  await mkdir(trashBase, { recursive: true });
  await rename(srcDir, destDir);
  log.debug({ agentId, sessionId, destDir }, 'moved extracted dir to trash');
}

/**
 * Restore extracted files dir from trash back to agents dir.
 * Returns true if restored, false if nothing to restore.
 */
export async function restoreExtractedFromTrash(
  storage: ExtractionStorage,
  agentId: string,
  sessionId: string,
): Promise<boolean> {
  const targetDir = storage.extractedDir(agentId, sessionId);
  const srcDir = trashPath(storage.getAgentsDir(), agentId, sessionId);

  try {
    const parentDir = join(targetDir, '..');
    await mkdir(parentDir, { recursive: true });
    await rename(srcDir, targetDir);
    log.debug({ agentId, sessionId }, 'restored extracted dir from trash');
    return true;
  } catch {
    return false;
  }
}

/**
 * Permanently delete extracted files from trash.
 * Returns true if deleted, false if nothing to delete.
 */
export async function deleteExtractedFromTrash(
  agentsDir: string,
  agentId: string,
  sessionId: string,
): Promise<boolean> {
  const dir = trashPath(agentsDir, agentId, sessionId);
  try {
    await rm(dir, { recursive: true, force: true });
    log.debug({ agentId, sessionId }, 'permanently deleted extracted dir from trash');
    return true;
  } catch {
    return false;
  }
}
