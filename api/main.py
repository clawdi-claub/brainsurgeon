"""BrainSurgeon API - Session management for OpenClaw."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configuration - OpenClaw agents directory
OPENCLAW_ROOT = Path(os.environ.get("OPENCLAW_ROOT", "~/.openclaw")).expanduser()
AGENTS_DIR = OPENCLAW_ROOT / "agents"

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
    keep_recent: int = 3


class EditEntryRequest(BaseModel):
    index: int
    entry: dict


def get_agents() -> list[str]:
    """Get list of agent directories."""
    if not AGENTS_DIR.exists():
        return []
    return [d.name for d in AGENTS_DIR.iterdir() if d.is_dir()]


def get_agent_sessions(agent: str) -> list[dict]:
    """Get sessions for a specific agent from sessions.json."""
    sessions_file = AGENTS_DIR / agent / "sessions" / "sessions.json"
    if not sessions_file.exists():
        return []
    try:
        with open(sessions_file, "r") as f:
            data = json.load(f)
        # Convert dict to list of sessions with IDs
        sessions = []
        for key, value in data.items():
            session = dict(value)
            session["_key"] = key
            sessions.append(session)
        return sessions
    except (json.JSONDecodeError, IOError):
        return []


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
                
                # Handle OpenClaw session format
                entry_type = entry.get("type", "")
                
                if entry_type == "message":
                    msg = entry.get("message", {})
                    role = msg.get("role", "")
                    if role in ("user", "assistant"):
                        messages += 1
                    if role == "toolResult":
                        tool_outputs += 1
                    # Count tool calls in message content array
                    content = msg.get("content", [])
                    if isinstance(content, list):
                        for item in content:
                            if isinstance(item, dict) and item.get("type") == "toolCall":
                                tool_calls += 1
                    # Also check for tool_calls field
                    if msg.get("tool_calls"):
                        tool_calls += len(msg["tool_calls"])
                elif entry_type == "tool_call":
                    tool_calls += 1
                elif entry_type == "tool_result":
                    tool_outputs += 1
                elif entry_type == "tool":
                    tool_outputs += 1
                    
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
            if line:
                try:
                    entry = json.loads(line)
                    # Handle OpenClaw format - timestamp can be in different places
                    ts = entry.get("timestamp")
                    if ts:
                        entries.append(ts)
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
    return {"agents": get_agents()}


@app.get("/sessions", response_model=SessionList)
def list_sessions(agent: Optional[str] = None):
    """List sessions, optionally filtered by agent."""
    sessions = []
    total_size = 0

    agents_to_check = [agent] if agent else get_agents()

    for ag in agents_to_check:
        agent_sessions = get_agent_sessions(ag)
        for sess in agent_sessions:
            session_id = sess.get("sessionId", "unknown")
            sessions_dir = AGENTS_DIR / ag / "sessions"
            filepath = sessions_dir / f"{session_id}.jsonl"
            
            analysis = analyze_jsonl(filepath)
            created, updated, duration = get_session_timestamps(filepath)

            sessions.append(SessionInfo(
                id=session_id,
                agent=ag,
                label=sess.get("label", session_id[:8]),
                path=str(filepath),
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
        agents=get_agents(),
        total_size=total_size,
    )


@app.get("/sessions/{agent}/{session_id}", response_model=SessionDetail)
def get_session(agent: str, session_id: str):
    """Get full session details."""
    filepath = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    agent_sessions = get_agent_sessions(agent)
    label = session_id
    for sess in agent_sessions:
        if sess.get("sessionId") == session_id:
            label = sess.get("label", session_id)
            break

    analysis = analyze_jsonl(filepath)

    raw_content = ""
    if filepath.exists():
        with open(filepath, "r", encoding="utf-8") as f:
            raw_content = f.read()

    return SessionDetail(
        id=session_id,
        agent=agent,
        label=label,
        path=str(filepath),
        size=analysis["size"],
        raw_content=raw_content,
        entries=analysis["entries"],
    )


@app.delete("/sessions/{agent}/{session_id}")
def delete_session(agent: str, session_id: str):
    """Delete session file and sessions.json entry."""
    filepath = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"
    sessions_file = AGENTS_DIR / agent / "sessions" / "sessions.json"

    # Remove file
    if filepath.exists():
        filepath.unlink()

    # Update sessions.json
    if sessions_file.exists():
        try:
            with open(sessions_file, "r") as f:
                data = json.load(f)
            # Find and remove entry by sessionId
            keys_to_remove = [k for k, v in data.items() if v.get("sessionId") == session_id]
            for key in keys_to_remove:
                del data[key]
            with open(sessions_file, "w") as f:
                json.dump(data, f, indent=2)
        except (json.JSONDecodeError, IOError):
            pass

    return {"deleted": True, "id": session_id}


@app.post("/sessions/{agent}/{session_id}/prune")
def prune_session(agent: str, session_id: str, req: PruneRequest):
    """Prune tool call output, keeping only recent calls."""
    filepath = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    # Read all entries
    entries = []
    with open(filepath, "r", encoding="utf-8") as f:
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

    original_size = filepath.stat().st_size
    pruned_count = 0

    for idx in to_prune:
        entry = entries[idx]
        if "content" in entry:
            old_len = len(entry.get("content", ""))
            entry["content"] = f"[pruned {old_len} chars]"
            entry["_pruned"] = True
            pruned_count += 1

    # Write back
    with open(filepath, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    new_size = filepath.stat().st_size

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
    filepath = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    # Read all entries
    entries = []
    with open(filepath, "r", encoding="utf-8") as f:
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
    with open(filepath, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return {"updated": True, "index": index}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8654)
