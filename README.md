# BrainSurgeon 🧠

OpenClaw extension for surgical session management.

A web UI to browse, view, edit, prune, and delete OpenClaw agent sessions.

## Features

- Per-agent session browser
- Session stats (size, duration, tool calls, tokens)
- View: Parsed JSONL session viewer
- Delete: Remove session file + sessions.json entry
- Prune: Strip tool call output to reduce size
- Edit: Modify individual session entries

## Structure

```
brainsurgeon/
├── api/              # FastAPI backend
├── web/              # Frontend (static or React)
├── extension.yaml    # OpenClaw extension manifest
└── README.md
```

## Install

```bash
ln -s ~/projects/brainsurgeon ~/.openclaw/extensions/brainsurgeon
```
