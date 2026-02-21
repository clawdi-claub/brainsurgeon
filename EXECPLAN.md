# BrainSurgeon Extension Production Restore

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

Reference: This document follows the ExecPlan format defined in `~/.openclaw/workspace-shared/PLANS.md`.

## Purpose / Big Picture

The BrainSurgeon OpenClaw extension was disabled after it crashed the gateway repeatedly. After this plan completes, the extension will load without errors, register the `restore_remote` tool, and allow agents to restore extracted session content via OpenClaw's tool system. A user will be able to trigger a restore by calling `restore_remote` with a session ID and entry ID, and see the extracted content reappear in the session.

## Progress

- [x] (2026-02-21 03:15Z) Investigated journalctl errors — found activate() crash loop
- [x] (2026-02-21 03:20Z) Audited extension vs API codebase — found 8 mismatches
- [x] (2026-02-21 03:25Z) Documented all mismatches in preliminary analysis
- [ ] Fix extension code — file extension, API endpoints, config handling
- [ ] Update API to support sessionKey resolution
- [ ] Integration test — verify full restore flow
- [ ] Deploy extension to production

## Surprises & Discoveries

- Observation: The old extension used `activate()` pattern but OpenClaw expects `register(api)`
  Evidence: Journal shows `plugin register returned a promise; async registration is ignored` — OpenClaw does not await the promise, causing undefined API access

- Observation: Extension looks for `.jsonl` files but API stores `.json` files
  Evidence: Line 111: `extractedPath = ...${entryId}.jsonl` vs API: `${entryId}.json`

- Observation: Extension config schema has 6 fields, API only has 1 matching field
  Evidence: Extension expects `enableAutoPrune`, `autoPruneThreshold` — API has `enabled`, `keep_recent`

- Observation: Extension tries to POST to `/prune` but actual endpoint is `/sessions/:agent/:id/prune`
  Evidence: Routes show `app.post('/:agent/:id/prune'...)` in routes.ts

- Observation: Extension receives `sessionKey` (e.g., `agent:crix:direct:123`) but API needs file-based session ID
  Evidence: Extension passes `sessionKey` to API, but API does not accept this parameter

## Decision Log

- Decision: Extension will remain disabled until all fixes are complete and tested locally
  Rationale: The crash loop in journalctl shows the old code destabilizes the gateway; no partial fixes
  Date/Author: 2026-02-21 / crix-claub

- Decision: Fix extension before modifying API (even where API changes would help)
  Rationale: Extension has more bugs; fixing it first isolates remaining API work
  Date/Author: 2026-02-21 / crix-claub

- Decision: Remove `extension.yaml` entirely
  Rationale: OpenClaw Plugin SDK only reads `openclaw.plugin.json` and `package.json`; extension.yaml contains invalid legacy format
  Date/Author: 2026-02-21 / crix-claub

## Outcomes & Retrospective

(Pending completion)

## Context and Orientation

BrainSurgeon is a session management system with three components:

1. **TypeScript API** — A REST API server (port 8000) that manages session pruning, extraction, and restoration. Located at `ts-api/`. Uses Hono web framework.

2. **WebUI** — A static HTML/JS frontend served at brain.lpc.one. Located at `web/`. Calls the TypeScript API.

3. **OpenClaw Extension** — A plugin for OpenClaw that registers a tool (`restore_remote`) and hooks into session lifecycle events. Located at `extensions/brainsurgeon/`.

The extension was disabled because it repeatedly crashed OpenClaw with:
```
TypeError: Cannot read properties of undefined (reading 'info')
    at activate (/.../brainsurgeon/index.ts:367:11)
```

This happened because the extension used the wrong plugin API pattern.

Key files in the extension:
- `extensions/brainsurgeon/index.ts` — Main plugin code (TypeScript)
- `extensions/brainsurgeon/openclaw.plugin.json` — Plugin metadata for OpenClaw
- `extensions/brainsurgeon/package.json` — NPM package metadata, must have `"type": "module"`

Key files in the API:
- `ts-api/src/app.ts` — Main application, mounts routes
- `ts-api/src/domains/session/api/routes.ts` — Session endpoints including prune/restore
- `ts-api/src/domains/prune/extraction/extraction-storage.ts` — File storage for extracted content

## Plan of Work

### Milestone 1: Fix Extension File Extension Mismatch

The extension looks for files with `.jsonl` extension, but the API stores them as `.json`. This means restore operations will always fail because the file will never be found.

Edit `extensions/brainsurgeon/index.ts` around line 111. Change the extractedPath construction from:

    const extractedPath = path.join(sessionsDir, 'extracted', sessionId, `${entryId}.jsonl`);

To:

    const extractedPath = path.join(sessionsDir, 'extracted', sessionId, `${entryId}.json`);

This aligns with the API's storage path defined in `extraction-storage.ts`.

### Milestone 2: Remove Invalid Config Fields from Extension

The extension reads config from `api.pluginConfig` expecting fields that do not exist in the API config schema. Remove all invalid fields and hardcode sensible defaults.

Edit `extensions/brainsurgeon/index.ts` function `getPluginConfig()`. The current code expects these fields from the API:
- `agentsDir` — Not in API; hardcode default
- `apiUrl` — Not in API; hardcode default  
- `enableAutoPrune` — Not in API; remove
- `autoPruneThreshold` — Not in API; remove
- `keepRestoreRemoteCalls` — ✅ This exists in API as `keep_restore_remote_calls`
- `busDbPath` — Not in API; hardcode default

Replace the entire function with simplified config that only uses actual API-provided values or hardcoded defaults:

    function getPluginConfig(api: PluginApi) {
      const pc = api.pluginConfig || {};
      return {
        agentsDir: '/home/openclaw/.openclaw/agents',
        apiUrl: 'http://localhost:8000',
        keepRestoreRemoteCalls: pc.keep_restore_remote_calls ?? false,
      };
    }

### Milestone 3: Fix API Endpoint Paths

The extension calls `/prune` and `/compact` but the actual API routes require session identifiers.

Edit `extensions/brainsurgeon/index.ts` in the `register()` function. The hook handlers need to resolve sessionKey to sessionId before calling the API.

For the `after_tool_call` hook, the `ctx` object may contain agentId and sessionKey. SessionKey format is `agent:{agentId}:{kind}:{label}`. The file-based session ID is a separate UUID.

**Decision:** For now, the extension will not auto-trigger prune. The hook handler should simply log the event but not call the API, until session ID resolution is implemented.

Comment out the prune/compact API calls in the hook handlers:

    // TODO: Requires sessionKey -> sessionId resolution
    // await callBrainSurgeonApi(cfg.apiUrl, 'POST', `/sessions/${agentId}/${sessionId}/prune`, ...)

The `restore_remote` tool handles this differently — it receives agentId and sessionId directly from the user.

### Milestone 4: Remove extension.yaml

The file `extensions/brainsurgeon/extension.yaml` contains invalid legacy format not recognized by OpenClaw Plugin SDK. Delete this file entirely.

    rm extensions/brainsurgeon/extension.yaml

### Milestone 5: Update openclaw.plugin.json

Ensure the plugin metadata matches what OpenClaw expects. The `configSchema` should be minimal since we handle validation in code.

Current content should be:

    {
      "id": "brainsurgeon",
      "configSchema": {
        "type": "object",
        "properties": {}
      }
    }

### Milestone 6: Verify Extension Loads Locally

Before deploying to production extension directory, test the fixed extension in a safe location.

Copy the fixed extension to a test location:

    cp -r extensions/brainsurgeon /tmp/brainsurgeon-test

Check TypeScript compiles (basic syntax check):

    cd /tmp/brainsurgeon-test && npx tsc --noEmit index.ts 2>&1 | head -20

If TypeScript is not available, verify by reading the code:
- No async `activate()` function
- Only `register(api)` function
- All `api.log` changed to `api.logger`
- All `api.config` changed to `api.pluginConfig`

### Milestone 7: Deploy Extension

Once locally verified, deploy to the production extension directory:

    cp -r ~/projects/brainsurgeon/extensions/brainsurgeon ~/.openclaw/extensions/

Add to `~/.openclaw/openclaw.json` plugin allow list:

    # Edit ~/.openclaw/openclaw.json
    # Add "brainsurgeon" to plugins.allow array

Restart OpenClaw gateway:

    openclaw gateway restart

Wait 10 seconds, then check logs:

    openclaw logs | grep -i brainsurgeon

Expected output:

    [plugins] BrainSurgeon plugin registering...
    [plugins] BrainSurgeon plugin registered successfully

No errors about `activate`, no "promise ignored" warnings.

### Milestone 8: Integration Test

Verify the full restore flow works:

1. Start a new session with an agent
2. Use extract functionality (from WebUI or manually via API)
3. Verify `[[extracted]]` placeholder appears in session
4. Call `restore_remote` tool with the session ID and entry ID
5. Verify content is restored and placeholder replaced

## Concrete Steps

All commands assume working directory is `~/projects/brainsurgeon` unless specified.

Step 1 — Edit file extension:

    sed -i 's/\${entryId}\.jsonl/${entryId}.json/' extensions/brainsurgeon/index.ts

Step 2 — Edit config function (manual edit required, too complex for sed):

    # Open extensions/brainsurgeon/index.ts
    # Replace getPluginConfig function body as described in Milestone 2

Step 3 — Remove invalid hook calls:

    # Open extensions/brainsurgeon/index.ts
    # Comment out the api.on('after_tool_call', ...) handler
    # Comment out the api.on('before_compaction', ...) handler
    # Or replace with logging-only versions

Step 4 — Delete extension.yaml:

    rm extensions/brainsurgeon/extension.yaml

Step 5 — Copy to production and restart:

    cp -r extensions/brainsurgeon ~/.openclaw/extensions/
    openclaw gateway restart
    sleep 10
    openclaw logs | grep -i brainsurgeon

## Validation and Acceptance

Acceptance criteria — the extension is working when:

1. OpenClaw logs show: `BrainSurgeon plugin registered successfully` with no errors
2. `openclaw tools list` shows `restore_remote` as an available tool
3. Calling `restore_remote` from a session finds and restores extracted content
4. No crashes in `journalctl` when searching for openclaw

Verification commands:

    # Check logs for successful registration
    openclaw logs | grep -A3 "BrainSurgeon"

    # Check for errors
    openclaw logs | grep -i "brainsurgeon.*error"

    # Check journal for crashes
    journalctl --since "5 minutes ago" | grep -i "brainsurgeon"

## Idempotence and Recovery

Each milestone can be retried safely. The extension directory can be wiped and recopied:

    rm -rf ~/.openclaw/extensions/brainsurgeon
    cp -r ~/projects/brainsurgeon/extensions/brainsurgeon ~/.openclaw/extensions/

If the extension crashes OpenClaw:

1. Remove from allow list in `~/.openclaw/openclaw.json`
2. Restart: `openclaw gateway restart`
3. Fix code in project repository
4. Redeploy

Always keep a working copy in `~/projects/brainsurgeon/extensions/brainsurgeon/` separate from the deployed copy.

## Artifacts and Notes

Journal errors from crashed extension:

    Feb 21 00:13: ... TypeError: Cannot read properties of undefined (reading 'info')
        at activate (/.../index.ts:367:11)

This confirms the old code used wrong API pattern. The new code uses `register(api)` not `activate()`.

File extension mismatch evidence:

    Extension: .../extracted/{sessionId}/${entryId}.jsonl
    API:       .../extracted/{sessionId}/${entryId}.json

## Interfaces and Dependencies

The extension implements this interface for OpenClaw:

    interface OpenClawPluginDefinition {
      id: string;
      name: string;
      description: string;
      version: string;
      register(api: OpenClawPluginApi): void | Promise<void>;
    }

The API parameter provides:

    interface OpenClawPluginApi {
      logger: { info(msg: string): void; error(msg: string): void; debug?(msg: string): void };
      pluginConfig?: Record<string, any>;
      registerTool(factory: (ctx: any) => ToolDefinition | null): void;
      on(hookName: string, handler: Function): void;
      resolvePath(input: string): string;
    }

---

Document revision: Initial creation 2026-02-21 03:25Z
