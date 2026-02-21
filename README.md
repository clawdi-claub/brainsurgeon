# 🧠 BrainSurgeon

> AI session memory surgery — extract, compact, restore.

BrainSurgeon is an **OpenClaw** companion service + extension that helps you keep long-running agent sessions usable by **extracting verbose/low-value blobs** out of the JSONL, while keeping the important structure and letting you **restore on demand**.

- **Web UI** for browsing sessions, inspecting entries, restoring, and controlling extraction
- **REST API** for automation and integrations
- **OpenClaw extension** that exposes a single control tool: `purge_control`

## ✨ What it does

- **Smart Purge / Smart Pruning** (optional)
  - Continuously scans sessions
  - Extracts large values (default: long `thinking` + `tool_result` payloads)
  - Keeps N recent messages intact
  - Retention cleanup for old extracted blobs
- **Manual extraction & restore**
  - Restore previously extracted content into the session entry
  - Mark specific entries as **non-extractable** (`_extractable: false`)
- **Safety controls**
  - API key auth (`X-API-Key`)
  - Optional global **readonly mode** (`BRAINSURGEON_READONLY=true`)

## 🚀 Quick start (Docker)

BrainSurgeon needs access to your OpenClaw agents directory.

> If you want to use extraction/restore/pruning features, mount your OpenClaw data **read-write**.

```bash
# Build from this repo (recommended during development)
docker build -t brainsurgeon:local .

# Run
docker run -d --name brainsurgeon \
  -p 8000:8000 \
  -v ~/.openclaw:/openclaw:rw \
  -e AGENTS_DIR=/openclaw/agents \
  -e DATA_DIR=/openclaw/brainsurgeon \
  -e BRAINSURGEON_API_KEYS="change-me" \
  brainsurgeon:local

# Web UI
open http://localhost:8000

# API (auth-info is public)
curl http://localhost:8000/api/auth-info

# Agents (requires X-API-Key if keys are configured)
curl -H "X-API-Key: change-me" http://localhost:8000/api/agents
```

### Minimal Docker Compose (example)

```yaml
services:
  brainsurgeon:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ~/.openclaw:/openclaw:rw
    environment:
      - AGENTS_DIR=/openclaw/agents
      - DATA_DIR=/openclaw/brainsurgeon
      - BRAINSURGEON_API_KEYS=change-me
      # Optional:
      # - BRAINSURGEON_READONLY=true
```

## 🔧 Configuration

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | API server port | `8000` |
| `AGENTS_DIR` | Path to OpenClaw agents directory | `/home/openclaw/.openclaw/agents` |
| `DATA_DIR` | BrainSurgeon data dir (bus db, etc.) | `/home/openclaw/.openclaw/brainsurgeon` |
| `BRAINSURGEON_API_KEYS` | Comma-separated API keys. If set → auth required. | none |
| `BRAINSURGEON_READONLY` | If `true`, disables write operations. | `false` |
| `BRAINSURGEON_CORS_ORIGINS` | Comma-separated allowed origins | `http://localhost:8000,…` |
| `LOG_LEVEL` | Logging level | `info` |

### Smart Purge (runtime config)

Smart purge is controlled by a runtime config stored at:

- `{AGENTS_DIR}/../.brainsurgeon/config.json`

Use the API to view/update it:

```bash
# Read current config
curl -H "X-API-Key: change-me" http://localhost:8000/api/config

# Enable smart purge with sane defaults
curl -H "X-API-Key: change-me" -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "trigger_types": ["thinking", "tool_result"],
    "keep_recent": 3,
    "min_value_length": 500,
    "scan_interval_seconds": 30,
    "retention": "7d",
    "keep_after_restore_seconds": 600
  }' \
  http://localhost:8000/api/config
```

## 🧩 OpenClaw extension (`purge_control`)

The BrainSurgeon extension exposes **one** tool for agents:

- `purge_control`
  - `get_context` — view extraction/context stats
  - `restore` — restore extracted content for an entry
  - `set_extractable` — set `_extractable` for an entry

Example OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "allow": ["brainsurgeon"],
    "entries": {
      "brainsurgeon": {
        "enabled": true,
        "config": {
          "agentsDir": "/home/you/.openclaw/agents",
          "apiUrl": "http://localhost:8000",
          "apiKey": "change-me",
          "enableAutoPrune": true,
          "autoPruneThreshold": 3,
          "keepRestoreRemoteCalls": false
        }
      }
    }
  }
}
```

## 📡 API Reference (high level)

> All endpoints below live under `/api/*`. `GET /api/auth-info` is public; everything else requires `X-API-Key` when `BRAINSURGEON_API_KEYS` is set.

### Core

- `GET /api/health`
- `GET /api/auth-info`
- `GET /api/agents`

### Sessions

- `GET /api/sessions?agent=&status=`
- `GET /api/sessions/:agent/:id`
- `GET /api/sessions/:agent/:id/summary`
- `POST /api/sessions/:agent/:id/prune`
- `POST /api/sessions/:agent/:id/compact`
- `POST /api/sessions/:agent/:id/prune/smart`
- `POST /api/sessions/:agent/:id/prune/enhanced`
- `GET /api/sessions/:agent/:id/entries/:entryId/extracted`
- `POST /api/sessions/:agent/:id/entries/:entryId/restore`
- `GET /api/sessions/:agent/:id/context`
- `PUT /api/sessions/:agent/:id/entries/:entryId/meta` (currently supports `_extractable`)
- `DELETE /api/sessions/:agent/:id` (moves to trash)

### Cron / smart purge service

- `GET /api/cron/status`
- `GET /api/cron/jobs`
- `POST /api/cron/jobs/:name/run`
- `POST /api/cron/reload`

### Config

- `GET /api/config`
- `POST /api/config`
- `GET /api/config/env` (env-derived legacy values)

### Trash

- `GET /api/trash`
- `POST /api/trash/:agent/:id/restore`
- `DELETE /api/trash/:agent/:id`
- `POST /api/trash/cleanup`

## 🧪 Testing

```bash
cd ts-api
npm test
```

## 🔒 Security notes

- If you enable any write features (extract/restore/prune/meta), BrainSurgeon must have RW access to the relevant OpenClaw data.
- Use `BRAINSURGEON_READONLY=true` for a safe “viewer mode”.
- Keep your `BRAINSURGEON_API_KEYS` out of git and don’t expose the API without auth.

## 🆘 Support

- Issues: https://github.com/clawdi-claub/brainsurgeon/issues
- Discussions: https://github.com/clawdi-claub/brainsurgeon/discussions
