// @ts-check
/**
 * Maintenance: removes expired gateway-created attachment batches (CAW_UPLOAD_RETENTION_DAYS) from every workspace root.
 * Only files the gateway created under .caw-uploads are ever touched. Run with `npm run maintenance:prune`, using the same
 * environment as the service (for example: set -a; . ~/.config/claude-official-web/env; set +a).
 *
 * Exit codes: 0 success, 1 unexpected failure, 2 invalid configuration.
 */
import { createAttachments } from '../src/attachments.mjs';
import { ConfigError, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { createStateStore } from '../src/state.mjs';
import { createWorkspaces } from '../src/workspaces.mjs';

try {
  const config = loadConfig(process.env);
  const log = createLogger({ level: 'info' });
  const stateStore = createStateStore(config.stateDir);
  const workspaces = createWorkspaces(config);
  const attachments = createAttachments({ config, log, workspaces, stateStore });
  const { removed } = await attachments.cleanup();
  console.log(`PRUNE_OK removed=${removed} retentionDays=${config.uploadRetentionDays}`);
  process.exitCode = 0;
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`invalid configuration: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(`prune failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
