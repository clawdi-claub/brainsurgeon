# 🧠 BrainSurgeon

> AI session memory surgery - extract, compress, restore.

BrainSurgeon is an OpenClaw plugin that intelligently manages agent session memory through extraction, compression, and restoration. It helps AI agents remember important context while keeping token usage efficient.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker Pulls](https://img.shields.io/docker/pulls/lpc/brainsurgeon.svg)](https://hub.docker.com/r/lpc/brainsurgeon)

## ✨ Features

- **Smart Pruning**: Automatically extracts and removes verbose thinking from sessions
- **Session Compression**: Reduces session size by 60-90% while preserving key information
- **One-Click Restore**: Instantly restore extracted content when needed
- **API-First**: Full REST API for programmatic access
- **Self-Hosted**: Run entirely on your own infrastructure
- **OpenClaw Plugin**: Native integration with OpenClaw agents

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Start the API and WebUI
docker run -d \
  --name brainsurgeon \
  -p 8000:8000 \
  -v ~/.openclaw:/openclaw:ro \
  -e AGENTS_DIR=/openclaw/agents \
  -e DATA_DIR=/openclaw \
  lpc/brainsurgeon

# Access the WebUI
open http://localhost:8000
```

### Option 2: Docker Compose

```yaml
version: '3.8'
services:
  brainsurgeon:
    image: lpc/brainsurgeon
    ports:
      - "8000:8000"
    volumes:
      - ~/.openclaw:/openclaw:ro
    environment:
      - AGENTS_DIR=/openclaw/agents
      - DATA_DIR=/openclaw
```

### Option 3: Development

```bash
# Clone and setup
git clone https://github.com/lpc-one/brainsurgeon.git
cd brainsurgeon

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run
npm start
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `8000` |
| `AGENTS_DIR` | Path to OpenClaw agents directory | `/openclaw/agents` |
| `DATA_DIR` | Path to OpenClaw data directory | `/openclaw` |
| `BRAINSURGEON_API_KEYS` | API key for authentication (optional) | none |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |

### OpenClaw Plugin Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["brainsurgeon"],
    "entries": {
      "brainsurgeon": {
        "enabled": true,
        "config": {
          "agentsDir": "/path/to/agents",
          "apiUrl": "http://localhost:8000",
          "enableAutoPrune": false,
          "autoPruneThreshold": 3
        }
      }
    }
  }
}
```

## 📡 API Reference

### Authentication

If `BRAINSURGEON_API_KEYS` is set, include your API key:

```bash
curl -H "X-API-Key: your-api-key" http://localhost:8000/api/agents
```

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all agents |
| `GET` | `/api/agents/:agentId/sessions` | List sessions for an agent |
| `GET` | `/api/session/:sessionId` | Get session details |
| `POST` | `/api/session/extract` | Extract content from session |
| `POST` | `/api/session/restore` | Restore extracted content |
| `POST` | `/api/session/prune` | Prune a session |
| `GET` | `/api/auth-info` | Check if API key is required |

## 🧪 Testing

### Run the test suite

```bash
cd ts-api
npm test
```

### Manual smoke test

```bash
# Start the service
docker run -d -p 8000:8000 lpc/brainsurgeon

# Check health
curl http://localhost:8000/api/health

# List agents (requires API key if set)
curl -H "X-API-Key: your-key" http://localhost:8000/api/agents
```

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   OpenClaw     │────▶│  BrainSurgeon    │────▶│   Extracted     │
│   Agents       │     │  API Server      │     │   Storage       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌──────────────────┐
                        │   WebUI          │
                        │   (Optional)     │
                        └──────────────────┘
```

## 📊 Token Savings Benchmark

Smart pruning typically saves **60-90%** on token usage for long-running sessions:

| Session Type | Original Tokens | After Pruning | Savings |
|-------------|-----------------|---------------|---------|
| Debug session (100 msgs) | ~50,000 | ~5,000 | 90% |
| Analysis session (50 msgs) | ~25,000 | ~8,000 | 68% |
| Chat session (30 msgs) | ~15,000 | ~6,000 | 60% |

*Benchmark methodology: Real agent sessions with varying complexity. Token counts based on OpenAI pricing model.*

## 🤖 For AI Agents

Agents can use the `restore_remote` tool to restore extracted content:

```json
{
  "tool": "restore_remote",
  "args": {
    "sessionKey": "agent:your-agent:main",
    "session": "session-id",
    "entry": "entry-id"
  }
}
```

## 🔒 Security

- API key authentication for production deployments
- Read-only access to OpenClaw agents directory
- No external network calls by default
- All data stays on your infrastructure

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🆘 Support

- Issues: https://github.com/lpc-one/brainsurgeon/issues
- Discussions: https://github.com/lpc-one/brainsurgeon/discussions

---

<p align="center">Made with 🧠 by <a href="https://lpc.one">LPC</a></p>
