"""BrainSurgeon API - Session management for OpenClaw."""

import json
import os
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configuration - OpenClaw agents directory
OPENCLAW_ROOT = Path(os.environ.get("OPENCLAW_ROOT", "~/.openclaw")).expanduser()
AGENTS_DIR = OPENCLAW_ROOT / "agents"
TRASH_DIR = OPENCLAW_ROOT / "trash"
TRASH_RETENTION_DAYS = 14

app = FastAPI(title="BrainSurgeon", version="1.1.0")

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
    model: Optional[str] = None  # Current/active model
    models: Optional[list[str]] = None  # All models used
    is_stale: bool = False  # True if inactive for >24h
    status: str = "active"  # active, stale, archived


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


class DeleteWithSummaryRequest(BaseModel):
    generate_summary: bool = True


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
        return {"size": 0, "messages": 0, "tool_calls": 0, "tool_outputs": 0, "entries": [], "models": [], "model": None}

    size = filepath.stat().st_size
    messages = 0
    tool_calls = 0
    tool_outputs = 0
    entries = []
    models = set()

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
                    # Extract model from message
                    model = msg.get("model")
                    if model:
                        models.add(model)
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
        "models": list(models),
        "model": list(models)[-1] if models else None,  # Last model = current
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

            # Determine if stale (inactive for >24h)
            is_stale = False
            status = "active"
            if updated:
                try:
                    updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                    now = datetime.now(timezone.utc)
                    if (now - updated_dt) > timedelta(hours=24):
                        is_stale = True
                        status = "stale"
                except:
                    pass

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
                model=analysis.get("model"),
                models=analysis.get("models", []),
                is_stale=is_stale,
                status=status,
            ))
            total_size += analysis["size"]

    return SessionList(
        sessions=sorted(sessions, key=lambda s: s.updated or "", reverse=True),
        agents=get_agents(),
        total_size=total_size,
    )


def generate_session_summary(entries: list[dict]) -> dict:
    """Generate an intelligent summary of a session before deletion."""
    summary = {
        "session_type": "chat",
        "topics": [],
        "tools_used": set(),
        "models_used": set(),
        "key_actions": [],
        "errors": [],
        "duration_estimate": None,
        "message_count": 0,
        "assistant_messages": 0,
        "user_messages": 0,
        "tool_calls": 0,
        "has_git_commits": False,
        "files_created": set(),
        "files_modified": set(),
    }
    
    first_timestamp = None
    last_timestamp = None
    topic_keywords = []
    
    for entry in entries:
        entry_type = entry.get("type", "")
        
        # Track timestamps for duration
        ts = entry.get("timestamp")
        if ts:
            if not first_timestamp:
                first_timestamp = ts
            last_timestamp = ts
        
        # Track custom types
        if entry_type == "custom":
            custom_type = entry.get("customType", "")
            if custom_type == "model-snapshot":
                data = entry.get("data", {})
                model_id = data.get("modelId")
                if model_id:
                    summary["models_used"].add(model_id)
        
        # Track message entries
        if entry_type == "message":
            summary["message_count"] += 1
            msg = entry.get("message", {})
            role = msg.get("role", "")
            content = msg.get("content", "")
            
            if role == "assistant":
                summary["assistant_messages"] += 1
                # Check for tool calls
                if msg.get("tool_calls"):
                    summary["tool_calls"] += len(msg.get("tool_calls", []))
                    # Extract tool names
                    for tc in msg.get("tool_calls", []):
                        tool_name = tc.get("name") or tc.get("function", {}).get("name")
                        if tool_name:
                            summary["tools_used"].add(tool_name)
                
                # Extract topics from content
                if isinstance(content, list):
                    for item in content:
                        if item.get("type") == "text":
                            text = item.get("text", "")
                            # Look for task indicators
                            if any(kw in text.lower() for kw in ["implement", "build", "create", "fix", "add", "update"]):
                                # Extract first sentence as action
                                first_sentence = text.split('.')[0][:100]
                                if len(first_sentence) > 20:
                                    summary["key_actions"].append(first_sentence)
                        elif item.get("type") == "thinking":
                            thinking = item.get("thinking", "")
                            # Extract topics from thinking
                            if len(thinking) > 50:
                                # Look for keywords indicating work
                                for kw in ["task", "feature", "implement", "build", "create", "fix"]:
                                    if kw in thinking.lower():
                                        topic = thinking[:150].strip()
                                        if topic not in topic_keywords:
                                            topic_keywords.append(topic)
                                        break
                
                # Check for errors
                if msg.get("errorMessage") or msg.get("stopReason") == "error":
                    error_msg = msg.get("errorMessage", "Unknown error")
                    summary["errors"].append(error_msg[:200])
            
            elif role == "user":
                summary["user_messages"] += 1
                # Extract user's intent
                if isinstance(content, list):
                    for item in content:
                        if item.get("type") == "text":
                            text = item.get("text", "")
                            # Check for file operations
                            if any(kw in text.lower() for kw in ["create", "write", "edit", "modify"]):
                                # Simple file detection
                                words = text.split()
                                for word in words:
                                    if '.' in word and '/' in word:
                                        if any(ext in word for ext in ['.py', '.js', '.ts', '.html', '.css', '.json', '.md', '.yml', '.yaml']):
                                            summary["files_created"].add(word.strip('.,;:!?'))
                            
        # Track tool results for git/file operations
        if entry_type == "tool_result":
            content = entry.get("content", "")
            if isinstance(content, list):
                for item in content:
                    if item.get("type") == "text":
                        text = item.get("text", "")
                        if "commit" in text.lower() and any(kw in text for kw in ["created", "modified", "deleted"]):
                            summary["has_git_commits"] = True
    
    # Calculate duration
    if first_timestamp and last_timestamp:
        try:
            from dateutil.parser import isoparse
            start = isoparse(first_timestamp.replace('Z', '+00:00'))
            end = isoparse(last_timestamp.replace('Z', '+00:00'))
            duration_mins = (end - start).total_seconds() / 60
            summary["duration_estimate"] = round(duration_mins, 1)
        except:
            pass
    
    # Convert sets to lists for JSON
    summary["tools_used"] = sorted(list(summary["tools_used"]))[:20]  # Top 20 tools
    summary["models_used"] = sorted(list(summary["models_used"]))
    summary["files_created"] = sorted(list(summary["files_created"]))[:10]
    summary["files_modified"] = sorted(list(summary["files_modified"]))[:10]
    summary["topics"] = topic_keywords[:5]  # Top 5 topics
    summary["key_actions"] = summary["key_actions"][:5]  # Top 5 actions
    summary["errors"] = summary["errors"][:5]  # Top 5 errors
    
    # Determine session type
    if summary["has_git_commits"]:
        summary["session_type"] = "development"
    elif summary["tool_calls"] > 5:
        summary["session_type"] = "tool_heavy"
    elif summary["message_count"] > 50:
        summary["session_type"] = "long_chat"
    
    return summary


@app.get("/sessions/{agent}/{session_id}/summary")
def get_session_summary(agent: str, session_id: str):
    """Generate a summary of a session before deletion."""
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
                    continue
    
    summary = generate_session_summary(entries)
    
    return {
        "session_id": session_id,
        "agent": agent,
        "summary": summary,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


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
    """Move session to trash instead of permanent delete. Also deletes child sessions."""
    filepath = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"
    sessions_file = AGENTS_DIR / agent / "sessions" / "sessions.json"

    # Create trash directory if needed
    TRASH_DIR.mkdir(parents=True, exist_ok=True)

    # Move file to trash (with timestamp to avoid collisions)
    if filepath.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        trash_path = TRASH_DIR / f"{agent}_{session_id}_{timestamp}.jsonl"
        shutil.move(str(filepath), str(trash_path))
        
        # Also write metadata file for retention tracking
        metadata = {
            "original_agent": agent,
            "original_session_id": session_id,
            "trashed_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=TRASH_RETENTION_DAYS)).isoformat(),
        }
        metadata_path = TRASH_DIR / f"{agent}_{session_id}_{timestamp}.meta.json"
        with open(metadata_path, "w") as f:
            json.dump(metadata, f)

    # Also delete child sessions (sessions that have this as parent)
    if sessions_file.exists():
        try:
            with open(sessions_file, "r") as f:
                data = json.load(f)
            # Find entries with this session as parent
            keys_to_remove = [k for k, v in data.items() if v.get("sessionId") == session_id or v.get("parent_session_id") == session_id]
            for key in keys_to_remove:
                child_sid = data[key].get("sessionId")
                if child_sid:
                    child_path = AGENTS_DIR / agent / "sessions" / f"{child_sid}.jsonl"
                    if child_path.exists():
                        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                        trash_path = TRASH_DIR / f"{agent}_{child_sid}_{timestamp}.jsonl"
                        shutil.move(str(child_path), str(trash_path))
                        metadata = {
                            "original_agent": agent,
                            "original_session_id": child_sid,
                            "trashed_at": datetime.now(timezone.utc).isoformat(),
                            "expires_at": (datetime.now(timezone.utc) + timedelta(days=TRASH_RETENTION_DAYS)).isoformat(),
                            "parent_session_id": session_id,
                        }
                        metadata_path = TRASH_DIR / f"{agent}_{child_sid}_{timestamp}.meta.json"
                        with open(metadata_path, "w") as f:
                            json.dump(metadata, f)
                del data[key]
            with open(sessions_file, "w") as f:
                json.dump(data, f, indent=2)
        except (json.JSONDecodeError, IOError):
            pass

    return {"deleted": True, "id": session_id, "moved_to_trash": True}


@app.get("/trash")
def list_trash():
    """List sessions in trash."""
    if not TRASH_DIR.exists():
        return {"sessions": []}
    
    sessions = []
    for meta_file in TRASH_DIR.glob("*.meta.json"):
        try:
            with open(meta_file, "r") as f:
                meta = json.load(f)
            sessions.append(meta)
        except:
            continue
    
    return {"sessions": sorted(sessions, key=lambda s: s.get("trashed_at", ""), reverse=True)}


@app.delete("/trash/{agent}/{session_id}")
def permanent_delete(agent: str, session_id: str):
    """Permanently delete a session from trash."""
    # Find matching files in trash
    deleted = False
    for trash_file in TRASH_DIR.glob(f"{agent}_{session_id}_*.jsonl"):
        trash_file.unlink()
        deleted = True
    for meta_file in TRASH_DIR.glob(f"{agent}_{session_id}_*.meta.json"):
        meta_file.unlink()
    
    return {"deleted": deleted, "id": session_id}


@app.post("/trash/cleanup")
def cleanup_trash():
    """Delete expired items from trash."""
    if not TRASH_DIR.exists():
        return {"cleaned": 0}
    
    now = datetime.now(timezone.utc)
    cleaned = 0
    
    for meta_file in TRASH_DIR.glob("*.meta.json"):
        try:
            with open(meta_file, "r") as f:
                meta = json.load(f)
            expires_at = datetime.fromisoformat(meta["expires_at"].replace("Z", "+00:00"))
            if expires_at < now:
                # Delete the session file
                session_file = meta_file.with_suffix(".jsonl")
                if session_file.exists():
                    session_file.unlink()
                meta_file.unlink()
                cleaned += 1
        except:
            continue
    
    return {"cleaned": cleaned}


@app.post("/sessions/{agent}/{session_id}/prune")
def prune_session(agent: str, session_id: str, req: PruneRequest):
    """Prune tool call output, replacing with [pruned]. Also supports light prune for long responses."""
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

    original_size = filepath.stat().st_size
    pruned_count = 0
    
    # Determine prune mode based on keep_recent:
    # keep_recent = -1 means "light prune" (summarize long responses)
    # keep_recent = 0 means remove ALL tool content
    # keep_recent > 0 means keep that many recent calls
    
    prune_mode = req.keep_recent if req.keep_recent > 0 else 3  # default
    light_prune = req.keep_recent == -1
    
    # Find tool-related entries
    # In OpenClaw format: role=tool or role=toolResult in message content
    tool_indices = []
    for i, e in enumerate(entries):
        entry_type = e.get("type", "")
        if entry_type == "tool":
            tool_indices.append(i)
        elif entry_type == "tool_result":
            tool_indices.append(i)
        elif entry_type == "message":
            msg = e.get("message", {})
            role = msg.get("role", "")
            if role in ("tool", "toolResult"):
                tool_indices.append(i)
            # Also check for tool calls in content array
            content = msg.get("content", [])
            if isinstance(content, list):
                for j, item in enumerate(content):
                    if isinstance(item, dict):
                        if item.get("type") == "toolCall":
                            # Mark this entry as containing tool calls
                            e["_has_tool_calls"] = True
                        if item.get("type") == "toolResult":
                            e["_has_tool_results"] = True

    # Calculate which entries to prune
    if light_prune:
        # Light prune: summarize long content, replace with [pruned]
        for i, entry in enumerate(entries):
            entry_type = e.get("type", "")
            
            # Prune message content for assistant responses that are too long
            if entry_type == "message":
                msg = entry.get("message", {})
                if msg.get("role") == "assistant":
                    content = msg.get("content", "")
                    if isinstance(content, str) and len(content) > 5000:
                        # Replace with summary
                        summary = content[:500] + f"\n\n[... {len(content) - 5000} chars pruned ...]"
                        msg["content"] = summary
                        entry["message"] = msg
                        entry["_pruned"] = True
                        entry["_pruned_type"] = "light"
                        pruned_count += 1
    else:
        # Full prune mode
        to_keep = set()
        
        # Find indices to keep (recent tool calls)
        if prune_mode > 0:
            recent_tools = tool_indices[-prune_mode:] if len(tool_indices) > prune_mode else tool_indices
            to_keep = set(recent_tools)
        
        # Replace pruned entries with [pruned]
        for i, entry in enumerate(entries):
            entry_type = entry.get("type", "")
            
            if entry_type == "tool":
                if i not in to_keep:
                    entry["type"] = "tool"
                    entry["content"] = "[pruned]"
                    entry["name"] = "[pruned]"
                    entry["_pruned"] = True
                    entry["_pruned_type"] = "full"
                    pruned_count += 1
            elif entry_type == "tool_result":
                if i not in to_keep:
                    entry["type"] = "tool_result"
                    entry["content"] = "[pruned]"
                    entry["_pruned"] = True
                    entry["_pruned_type"] = "full"
                    pruned_count += 1
            elif entry_type == "message":
                msg = entry.get("message", {})
                role = msg.get("role", "")
                
                # Prune tool calls in content array
                if role == "assistant" and msg.get("tool_calls"):
                    # Keep tool calls but mark as pruned if not in keep set
                    if i not in to_keep:
                        msg["tool_calls"] = [{"_pruned": True, "type": "toolCall", "id": "[pruned]", "name": "[pruned]"}]
                        entry["message"] = msg
                        entry["_pruned"] = True
                        entry["_pruned_type"] = "full"
                        pruned_count += 1
                
                # Prune tool results
                if role == "toolResult":
                    if i not in to_keep:
                        msg["content"] = "[pruned]"
                        entry["message"] = msg
                        entry["_pruned"] = True
                        entry["_pruned_type"] = "full"
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
        "mode": "light" if light_prune else "full",
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
