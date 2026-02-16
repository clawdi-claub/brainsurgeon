"""BrainSurgeon API - Session management for OpenClaw."""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configuration
OPENCLAW_DATA = Path(os.environ.get("OPENCLAW_DATA", "~/.openclaw/data")).expanduser()
SESSIONS_JSON = OPENCLAW_DATA / "sessions.json"

app = FastAPI(title="BrainSurgeon", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SessionInfo(BaseModel):
    id: str
    agent: str
    label: str
    path: str
    size: int
    messages: int
    tool_calls: int
    tool_outputs: int
    created: Optional[str] = None
    updated: Optional[str] = None
    duration_minutes: Optional[float] = None


class SessionList(BaseModel):
    sessions: list[SessionInfo]
    agents: list[str]
    total_size: int


class SessionDetail(BaseModel):
    id: str
    agent: str
    label: str
    path: str
    size: int
    raw_content: str
    entries: list[dict]


class PruneRequest(BaseModel):
    keep_recent: int = 3  # Keep last N tool calls


class EditEntryRequest(BaseModel):
    index: int
    entry: dict


def parse_sessions_json():
    """Load sessions.json and return sessions dict."""
    if not SESSIONS_JSON.exists():
        return {"agents": {}}
    with open(SESSIONS_JSON, "r") as f:
        return json.load(f)


def get_session_path(agent: str, session_id: str) -> Path:
    """Get the full path to a session file."""
    return OPENCLAW_DATA / agent / f"{session_id}.jsonl"


def analyze_jsonl(filepath: Path) -> dict:
    """Analyze a JSONL session file."""
    if not filepath.exists():
        return {"size": 0, "messages": 0, "tool_calls": 0, "tool_outputs": 0, "entries": []}

    size = filepath.stat().st_size
    messages = 0
    tool_calls = 0
    tool_outputs = 0
    entries = []

    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                entries.append(entry)
                if entry.get("role") in ("user", "assistant"):
                    messages += 1
                if entry.get("role") == "tool":
                    tool_outputs += 1
                if entry.get("tool_calls"):
                    tool_calls += len(entry["tool_calls"])
                elif entry.get("name") and entry.get("role") == "tool":
                    # Tool result without explicit tool_calls
                    pass
            except json.JSONDecodeError:
                continue

    return {
        "size": size,
        "messages": messages,
        "tool_calls": tool_calls,
        "tool_outputs": tool_outputs,
        "entries": entries,
    }


def get_session_timestamps(filepath: Path) -> tuple[Optional[str], Optional[str], Optional[float]]:
    """Get created, updated timestamps and duration from session file."""
    if not filepath.exists():
        return None, None, None

    entries = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("timestamp"):
                    entries.append(entry["timestamp"])
            except:
                continue

    if not entries:
        return None, None, None

    try:
        created = entries[0]
        updated = entries[-1]
        start = datetime.fromisoformat(created.replace("Z", "+00:00"))
        end = datetime.fromisoformat(updated.replace("Z", "+00:00"))
        duration = (end - start).total_seconds() / 60
        return created, updated, duration
    except:
        return entries[0], entries[-1], None


@app.get("/agents")
def list_agents():
    """List all agents with sessions."""
    data = parse_sessions_json()
    return {"agents": list(data.get("agents", {}).keys())}


@app.get("/sessions", response_model=SessionList)
def list_sessions(agent: Optional[str] = None):
    """List sessions, optionally filtered by agent."""
    data = parse_sessions_json()
    sessions = []
    total_size = 0

    agents_to_check = [agent] if agent else list(data.get("agents", {}).keys())

    for ag in agents_to_check:
        agent_data = data.get("agents", {}).get(ag, {})
        for sess_id, sess_info in agent_data.get("sessions", {}).items():
            path = get_session_path(ag, sess_id)
            analysis = analyze_jsonl(path)
            created, updated, duration = get_session_timestamps(path)

            sessions.append(SessionInfo(
                id=sess_id,
                agent=ag,
                label=sess_info.get("label", sess_id),
                path=str(path),
                size=analysis["size"],
                messages=analysis["messages"],
                tool_calls=analysis["tool_calls"],
                tool_outputs=analysis["tool_outputs"],
                created=created,
                updated=updated,
                duration_minutes=duration,
            ))
            total_size += analysis["size"]

    return SessionList(
        sessions=sorted(sessions, key=lambda s: s.updated or "", reverse=True),
        agents=list(data.get("agents", {}).keys()),
        total_size=total_size,
    )


@app.get("/sessions/{agent}/{session_id}", response_model=SessionDetail)
def get_session(agent: str, session_id: str):
    """Get full session details."""
    path = get_session_path(agent, session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    data = parse_sessions_json()
    agent_data = data.get("agents", {}).get(agent, {})
    sess_info = agent_data.get("sessions", {}).get(session_id, {})

    analysis = analyze_jsonl(path)

    raw_content = ""
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            raw_content = f.read()

    return SessionDetail(
        id=session_id,
        agent=agent,
        label=sess_info.get("label", session_id),
        path=str(path),
        size=analysis["size"],
        raw_content=raw_content,
        entries=analysis["entries"],
    )


@app.delete("/sessions/{agent}/{session_id}")
def delete_session(agent: str, session_id: str):
    """Delete session file and sessions.json entry."""
    path = get_session_path(agent, session_id)

    # Remove file
    if path.exists():
        path.unlink()

    # Update sessions.json
    data = parse_sessions_json()
    if agent in data.get("agents", {}):
        data["agents"][agent].get("sessions", {}).pop(session_id, None)
        with open(SESSIONS_JSON, "w") as f:
            json.dump(data, f, indent=2)

    return {"deleted": True, "id": session_id}


@app.post("/sessions/{agent}/{session_id}/prune")
def prune_session(agent: str, session_id: str, req: PruneRequest):
    """Prune tool call output, keeping only recent calls."""
    path = get_session_path(agent, session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    # Read all entries
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except:
                    entries.append({"_raw": line})

    # Find tool call indices (role=tool)
    tool_indices = [i for i, e in enumerate(entries) if e.get("role") == "tool"]

    # Keep only recent tool calls
    to_prune = tool_indices[:-req.keep_recent] if len(tool_indices) > req.keep_recent else []

    original_size = path.stat().st_size
    pruned_count = 0

    for idx in to_prune:
        entry = entries[idx]
        if "content" in entry:
            old_len = len(entry.get("content", ""))
            entry["content"] = f"[pruned {old_len} chars]"
            entry["_pruned"] = True
            pruned_count += 1
        # Keep tool_call_id for pairing

    # Write back
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    new_size = path.stat().st_size

    return {
        "pruned": True,
        "entries_pruned": pruned_count,
        "original_size": original_size,
        "new_size": new_size,
        "saved_bytes": original_size - new_size,
    }


@app.put("/sessions/{agent}/{session_id}/entries/{index}")
def edit_entry(agent: str, session_id: str, index: int, req: EditEntryRequest):
    """Edit a specific session entry."""
    path = get_session_path(agent, session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    # Read all entries
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except:
                    entries.append({"_raw": line})

    if index < 0 or index >= len(entries):
        raise HTTPException(status_code=400, detail="Invalid entry index")

    # Update entry
    entries[index] = req.entry

    # Write back
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return {"updated": True, "index": index}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8654)
