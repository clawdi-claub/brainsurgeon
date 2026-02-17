# BrainSurgeon 🧠

OpenClaw extension for surgical session management.

A web UI to browse, view, edit, prune, and delete OpenClaw agent sessions.

![Features](./screenshot.png)

## Features

- **Browse**: Per-agent session browser with stats (size, duration, tool calls, tokens)
- **View**: Parsed JSONL session viewer with filtering
- **Edit**: Modify individual session entries
- **Prune**: Strip tool call output to reduce session size
- **Delete**: Remove session files with optional summary generation
- **Search**: Find sessions by label or content
- **Stats**: Token usage, model breakdown, duration tracking

## Quick Start

### Prerequisites

- OpenClaw installed and running
- Docker (recommended) or Python 3.12+
- Access to your OpenClaw data directory (usually `~/.openclaw`)

### Install as OpenClaw Extension

```bash
# Clone or download this repository
git clone https://github.com/yourusername/brainsurgeon.git
cd brainsurgeon

# Link to OpenClaw extensions directory
ln -s "$(pwd)" ~/.openclaw/extensions/brainsurgeon

# Start the API server (see options below)
```

### Option 1: Run with Docker (Recommended)

```bash
# Build and start
docker-compose up --build -d

# Or build without cache if updating
docker-compose build --no-cache
docker-compose up -d

# View logs
docker-compose logs -f
```

The UI will be available at `http://localhost:8654`

### Option 2: Run with Python

```bash
# Install dependencies
pip install fastapi uvicorn pydantic

# Run the API
python -m uvicorn api.main:app --host 0.0.0.0 --port 8654

# Or with environment variable for OpenClaw path
OPENCLAW_ROOT=/path/to/.openclaw python -m uvicorn api.main:app --host 0.0.0.0 --port 8654
```

### Configuration

BrainSurgeon uses these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_ROOT` | `~/.openclaw` | Path to your OpenClaw data directory |
| `PORT` | `8654` | Port to run the API server |

## Usage

Once running, open your browser to `http://localhost:8654`

### Session Browser
- Select an agent from the dropdown to view their sessions
- Sessions are sorted by most recent activity
- Click any session to view details

### Session Detail View
- View all messages in a parsed, readable format
- See metadata: tokens used, model, duration, channel
- Edit individual entries by clicking the edit button
- Prune tool outputs to reduce file size
- Delete the session entirely

### Pruning
Pruning removes tool call output content (keeps the calls themselves). This is useful for reducing session size while keeping conversation context.

### Deleting
Deletion moves sessions to a trash folder and removes them from OpenClaw's index. Sessions can be recovered from trash within the retention period.

## File Structure

```
brainsurgeon/
├── api/              # FastAPI backend
│   └── main.py       # Main API endpoints
├── web/              # Static frontend
│   ├── index.html    # Main UI
│   └── app.js        # Frontend logic
├── extension.yaml    # OpenClaw extension manifest
├── Dockerfile        # Container build
├── docker-compose.yml # Docker Compose config
└── README.md         # This file
```

## API Endpoints

- `GET /agents` - List all agents
- `GET /sessions/{agent}` - List sessions for an agent
- `GET /sessions/{agent}/{session_id}` - Get session details
- `POST /sessions/{agent}/{session_id}/edit` - Edit session entry
- `POST /sessions/{agent}/{session_id}/prune` - Prune tool outputs
- `DELETE /sessions/{agent}/{session_id}` - Delete session
- `POST /sessions/{agent}/{session_id}/restore` - Restore from trash
- `GET /trash` - List trashed sessions
- `DELETE /trash/{filename}` - Permanently delete from trash

## Safety

- **Backup recommended**: BrainSurgeon modifies session files. Consider backing up your `~/.openclaw/agents/` directory.
- **Undo available**: Deleted sessions go to trash and can be restored.
- **Edit carefully**: Editing session entries modifies the underlying JSONL files.

## Development

```bash
# Run in development mode with auto-reload
python -m uvicorn api.main:app --reload --port 8654

# Run tests (if available)
pytest
```

## Troubleshooting

**Sessions not showing up?**
- Check that `OPENCLAW_ROOT` points to your actual OpenClaw directory
- Verify the agents directory exists: `$OPENCLAW_ROOT/agents/`

**Permission denied when editing/deleting?**
- Ensure BrainSurgeon has write access to your OpenClaw directory
- When using Docker, the volume mount needs proper permissions

**UI not loading?**
- Check that the API is running: `curl http://localhost:8654/agents`
- Verify the port isn't already in use: `lsof -i :8654`

## License

MIT

## Contributing

Issues and pull requests welcome. This is a community tool for managing OpenClaw sessions.
