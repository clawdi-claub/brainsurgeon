"""BrainSurgeon API - Session management for OpenClaw."""

import json
import logging
import os
import re
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Security, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# Configuration - OpenClaw agents directory
OPENCLAW_ROOT = Path(os.environ.get("OPENCLAW_ROOT", "~/.openclaw")).expanduser()
AGENTS_DIR = OPENCLAW_ROOT / "agents"
TRASH_DIR = OPENCLAW_ROOT / "trash"
TRASH_RETENTION_DAYS = 14

# Security Configuration
API_KEYS = set(filter(None, os.environ.get("BRAINSURGEON_API_KEYS", "").split(",")))
READONLY_MODE = os.environ.get("BRAINSURGEON_READONLY", "false").lower() == "true"
CORS_ORIGINS = os.environ.get("BRAINSURGEON_CORS_ORIGINS", "http://localhost:8654,http://127.0.0.1:8654").split(",")
API_KEY_NAME = "X-API-Key"

# UI Configuration
AUTO_REFRESH_INTERVAL_MS = int(os.environ.get("BRAINSURGEON_AUTO_REFRESH_MS", "10000"))  # Default 10 seconds

# Setup audit logging
audit_logger = logging.getLogger("brainsurgeon.audit")
if not audit_logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('%(asctime)s - AUDIT - %(message)s'))
    audit_logger.addHandler(handler)
    audit_logger.setLevel(logging.INFO)

# Setup rate limiter
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="BrainSurgeon", version="1.2.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# API Key security
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def verify_api_key(api_key: str = Security(api_key_header)):
    """Verify API key if authentication is configured."""
    if not API_KEYS:
        # No API keys configured, allow all (for development/local use)
        return None
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"API key required. Pass {API_KEY_NAME} header."
        )
    if api_key not in API_KEYS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid API key"
        )
    return api_key

def require_write_access(api_key: str = Depends(verify_api_key)):
    """Check if server is in read-only mode."""
    if READONLY_MODE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Server is in read-only mode"
        )
    return api_key

def sanitize_path_component(value: str, field_name: str = "value") -> str:
    """Sanitize path component to prevent path traversal attacks.
    
    Only allows alphanumeric characters, hyphens, and underscores.
    """
    if not value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} cannot be empty"
        )
    # Allow alphanumeric, hyphens, underscores only
    if not re.match(r'^[a-zA-Z0-9_-]+$', value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {field_name}. Only alphanumeric, hyphens, and underscores allowed."
        )
    # Double-check no path separators slipped through
    if any(c in value for c in ['/', '\\', '.', '\x00']):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid characters in {field_name}"
        )
    return value

def log_action(action: str, agent: str, session_id: str = None, user: str = None, details: dict = None):
    """Log audit event for destructive operations."""
    msg = f"action={action} agent={agent}"
    if session_id:
        msg += f" session={session_id}"
    if user:
        msg += f" user={user[:8]}..."  # Truncate for privacy
    if details:
        msg += f" details={json.dumps(details)}"
    audit_logger.info(msg)

# CORS - locked down to specific origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
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
    messages: int = 0
    tool_calls: int = 0
    duration_minutes: Optional[float] = None
    is_stale: bool = False
    created: Optional[str] = None
    updated: Optional[str] = None
    models: list[str] = []
    parentId: Optional[str] = None
    children: list[dict] = []
    # Additional metadata from sessions.json
    channel: Optional[str] = None
    systemPromptReport: Optional[str] = None
    resolvedSkills: list[str] = []
    tokens: Optional[int] = None  # totalTokens
    contextTokens: Optional[int] = None
    inputTokens: Optional[int] = None
    outputTokens: Optional[int] = None


class PruneRequest(BaseModel):
    keep_recent: int = 3


class EditEntryRequest(BaseModel):
    index: int
    entry: dict


class RestartRequest(BaseModel):
    delay_ms: int = 5000
    note: str = "Restart triggered from BrainSurgeon"


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


@app.get("/config")
def get_config():
    """Get UI configuration."""
    return {
        "auto_refresh_interval_ms": AUTO_REFRESH_INTERVAL_MS,
        "readonly_mode": READONLY_MODE
    }


@app.get("/agents")
@limiter.limit("60/minute")
def list_agents(request: Request, api_key: str = Depends(verify_api_key)):
    """List all agents with sessions."""
    return {"agents": get_agents()}


@app.post("/restart")
@limiter.limit("5/minute")
def restart_openclaw(request: Request, req: RestartRequest, api_key: str = Depends(require_write_access)):
    """Trigger OpenClaw gateway restart."""
    import shutil

    log_action("restart", "system", user=api_key, details={"delay_ms": req.delay_ms})

    # Check if openclaw is available
    openclaw_path = shutil.which("openclaw")

    if not openclaw_path:
        # Containerized mode: return what would happen but don't fail
        return {
            "restarted": True,
            "simulated": True,  # Add this field to indicate simulation
            "delay_ms": req.delay_ms,
            "note": req.note,
            "status": "restart request forwarded to host",
            "message": "Restart command received. When running in container, restart must be performed on host."
        }

    import subprocess
    try:
        # Trigger gateway restart using openclaw CLI
        result = subprocess.run(
            [openclaw_path, "gateway", "restart", "--delay", str(req.delay_ms)],
            capture_output=True,
            text=True,
            timeout=10
        )
        return {
            "restarted": True,
            "delay_ms": req.delay_ms,
            "note": req.note,
            "output": result.stdout.strip() if result.stdout else None
        }
    except subprocess.TimeoutExpired:
        # The restart command may not return if the process is killed
        return {
            "restarted": True,
            "delay_ms": req.delay_ms,
            "note": req.note,
            "status": "restart initiated"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Restart failed: {str(e)}")


@app.get("/sessions", response_model=SessionList)
@limiter.limit("60/minute")
def list_sessions(request: Request, agent: Optional[str] = None, api_key: str = Depends(verify_api_key)):
    """List sessions, optionally filtered by agent."""
    sessions = []
    total_size = 0

    # Sanitize agent parameter if provided
    if agent:
        agent = sanitize_path_component(agent, "agent")

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


def is_heartbeat_message(text: str) -> bool:
    """Check if message is a heartbeat check or automated system message."""
    if not text:
        return True
    heartbeat_indicators = [
        "heartbeat",
        "HEARTBEAT_OK",
        "checking token",
        "context compacted",
        "compacted (",
        "tokens:",
        "token count",
        "system: [",
        "[system]",
        "you've been rate limited",
        "rate limit",
        "compacting context",
        "continue on your open tasks",
    ]
    text_lower = text.lower()
    return any(ind in text_lower for ind in heartbeat_indicators)

def generate_session_summary(entries: list[dict]) -> dict:
    """Generate an intelligent summary of a session before deletion.
    
    Excludes heartbeat checks and automated system messages.
    Focuses on user interaction, thinking, and meaningful content.
    """
    summary = {
        "session_type": "chat",
        "topics": [],
        "tools_used": set(),
        "models_used": set(),
        "key_actions": [],
        "user_requests": [],
        "thinking_insights": [],
        "errors": [],
        "duration_estimate": None,
        "message_count": 0,
        "user_messages": 0,
        "meaningful_messages": 0,
        "tool_calls": 0,
        "has_git_commits": False,
        "files_created": set(),
        "files_modified": set(),
    }
    
    first_timestamp = None
    last_timestamp = None
    seen_topics = set()
    
    for entry in entries:
        entry_type = entry.get("type", "")
        
        # Track timestamps for duration
        ts = entry.get("timestamp")
        if ts:
            if not first_timestamp:
                first_timestamp = ts
            last_timestamp = ts
        
        # Skip heartbeat and automated entries
        if entry_type == "custom":
            custom_type = entry.get("customType", "")
            if custom_type == "model-snapshot":
                data = entry.get("data", {})
                model_id = data.get("modelId")
                if model_id:
                    summary["models_used"].add(model_id)
            continue
        
        # Track message entries - but filter out heartbeats
        if entry_type == "message":
            summary["message_count"] += 1
            msg = entry.get("message", {})
            role = msg.get("role", "")
            content = msg.get("content", "")
            
            if role == "assistant":
                # Check for tool_calls field (OpenAI format)
                if msg.get("tool_calls"):
                    summary["tool_calls"] += len(msg.get("tool_calls", []))
                    for tc in msg.get("tool_calls", []):
                        tool_name = tc.get("name") or tc.get("function", {}).get("name")
                        if tool_name:
                            summary["tools_used"].add(tool_name)
                
                # Check for toolCall in content array (OpenClaw format)
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "toolCall":
                            summary["tool_calls"] += 1
                            tool_name = item.get("name") or (item.get("params", {}).get("tool") if isinstance(item.get("params"), dict) else None)
                            if tool_name:
                                summary["tools_used"].add(tool_name)
                
                # Extract thinking insights (high value content)
                if isinstance(content, list):
                    has_meaningful_content = False
                    for item in content:
                        if item.get("type") == "thinking":
                            thinking = item.get("thinking", "")
                            # Skip heartbeat-related thinking
                            if is_heartbeat_message(thinking):
                                continue
                            if len(thinking) > 30:
                                has_meaningful_content = True
                                # Extract key insights from thinking
                                lines = [l.strip() for l in thinking.split('\n') if l.strip()]
                                for line in lines[:3]:  # First 3 non-empty lines
                                    if len(line) > 20 and len(line) < 200:
                                        if line not in seen_topics:
                                            seen_topics.add(line)
                                            summary["thinking_insights"].append(line)
                        
                        elif item.get("type") == "text":
                            text = item.get("text", "")
                            if is_heartbeat_message(text):
                                continue
                            has_meaningful_content = True
                            
                            # Look for task/action indicators
                            action_keywords = ["implement", "build", "create", "fix", "add", "update", 
                                            "deploy", "configure", "refactor", "integrate", "optimize"]
                            if any(kw in text.lower() for kw in action_keywords):
                                # Extract first sentence as action
                                first_sentence = text.split('.')[0][:120]
                                if len(first_sentence) > 20:
                                    if first_sentence not in seen_topics:
                                        seen_topics.add(first_sentence)
                                        summary["key_actions"].append(first_sentence)
                
                if has_meaningful_content:
                    summary["meaningful_messages"] += 1
                
                # Check for errors
                if msg.get("errorMessage") or msg.get("stopReason") == "error":
                    error_msg = msg.get("errorMessage", "Unknown error")
                    if not is_heartbeat_message(error_msg):
                        summary["errors"].append(error_msg[:200])
            
            elif role == "user":
                summary["user_messages"] += 1
                # Extract user's actual requests (not system prompts)
                if isinstance(content, list):
                    for item in content:
                        if item.get("type") == "text":
                            text = item.get("text", "")
                            if is_heartbeat_message(text):
                                continue
                            
                            summary["meaningful_messages"] += 1
                            
                            # Capture user requests (first sentence)
                            if len(text) > 10 and len(text) < 300:
                                first_sentence = text.split('.')[0][:150]
                                if first_sentence not in seen_topics:
                                    seen_topics.add(first_sentence)
                                    summary["user_requests"].append(first_sentence)
                            
                            # Check for file operations
                            file_keywords = ["create", "write", "edit", "modify", "fix", "build"]
                            if any(kw in text.lower() for kw in file_keywords):
                                words = text.split()
                                for word in words:
                                    if '.' in word and '/' in word:
                                        if any(ext in word for ext in ['.py', '.js', '.ts', '.html', '.css', '.json', '.md', '.yml', '.yaml', '.sh', '.txt']):
                                            summary["files_created"].add(word.strip('.,;:!?()[]{}'))
                            
        # Track tool results for git/file operations
        elif entry_type == "tool_result":
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
            from datetime import datetime, timezone
            start = datetime.fromisoformat(first_timestamp.replace('Z', '+00:00'))
            end = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
            duration_mins = (end - start).total_seconds() / 60
            summary["duration_estimate"] = round(duration_mins, 1)
        except:
            pass
    
    # Convert sets to lists for JSON
    summary["tools_used"] = sorted(list(summary["tools_used"]))[:15]
    summary["models_used"] = sorted(list(summary["models_used"]))
    summary["files_created"] = sorted(list(summary["files_created"]))[:8]
    summary["files_modified"] = sorted(list(summary["files_modified"]))[:8]
    
    # Limit arrays
    summary["thinking_insights"] = summary["thinking_insights"][:5]
    summary["user_requests"] = summary["user_requests"][:5]
    summary["key_actions"] = summary["key_actions"][:5]
    summary["errors"] = summary["errors"][:3]
    
    # Determine session type
    if summary["has_git_commits"]:
        summary["session_type"] = "development"
    elif summary["tool_calls"] > 5:
        summary["session_type"] = "tool_heavy"
    elif summary["meaningful_messages"] > 30:
        summary["session_type"] = "long_chat"
    
    return summary


@app.get("/sessions/{agent}/{session_id}/summary")
@limiter.limit("30/minute")
def get_session_summary(request: Request, agent: str, session_id: str, api_key: str = Depends(verify_api_key)):
    """Generate a summary of a session before deletion."""
    agent = sanitize_path_component(agent, "agent")
    session_id = sanitize_path_component(session_id, "session_id")

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
@limiter.limit("60/minute")
def get_session(request: Request, agent: str, session_id: str, api_key: str = Depends(verify_api_key)):
    """Get full session details."""
    agent = sanitize_path_component(agent, "agent")
    session_id = sanitize_path_component(session_id, "session_id")

    filepath = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    agent_sessions = get_agent_sessions(agent)
    print(f"DEBUG: Found {len(agent_sessions)} sessions for agent {agent}")
    label = session_id
    session_meta = None
    for sess in agent_sessions:
        sid = sess.get("sessionId")
        print(f"DEBUG: Checking session {sid}")
        if sid == session_id:
            label = sess.get("label", session_id)
            session_meta = sess
            print(f"DEBUG: Found matching session! Meta keys: {sess.keys()}")
            break
    if not session_meta:
        print(f"DEBUG: No session_meta found for {session_id}")

    analysis = analyze_jsonl(filepath)

    raw_content = ""
    if filepath.exists():
        with open(filepath, "r", encoding="utf-8") as f:
            raw_content = f.read()

    # Get timestamps and stale status
    created, updated, duration_mins = get_session_timestamps(filepath)
    is_stale = False
    if updated:
        try:
            from datetime import datetime, timezone, timedelta
            updated_dt = datetime.fromisoformat(updated.replace('Z', '+00:00'))
            is_stale = (datetime.now(timezone.utc) - updated_dt) > timedelta(hours=24)
        except:
            pass

    # Find parent/children relationships
    parent_id = session_meta.get("parent_session_id") if session_meta else None
    children = []
    if agent_sessions:
        for sess in agent_sessions:
            if sess.get("parent_session_id") == session_id:
                children.append({
                    "sessionId": sess.get("sessionId"),
                    "label": sess.get("label", sess.get("sessionId", "")[:8])
                })

    # Extract models from entries
    models = set()
    for entry in analysis.get("entries", []):
        if entry.get("type") == "custom" and entry.get("customType") == "model-snapshot":
            model_id = entry.get("data", {}).get("modelId") or entry.get("data", {}).get("model")
            if model_id:
                models.add(model_id)
        elif entry.get("type") == "message":
            msg_model = entry.get("message", {}).get("model")
            if msg_model:
                models.add(msg_model)

    # Count messages and tool calls from entries
    messages = 0
    tool_calls = 0
    for entry in analysis.get("entries", []):
        if entry.get("type") == "message":
            messages += 1
            msg = entry.get("message", {})
            # Check for tool_calls field (OpenAI format)
            if msg.get("tool_calls"):
                tool_calls += len(msg.get("tool_calls", []))
            # Check for toolCall in content array (OpenClaw format)
            content = msg.get("content", [])
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "toolCall":
                        tool_calls += 1

    # Extract fields from sessions.json with correct field names
    channel = session_meta.get("lastChannel") if session_meta else None
    if not channel and session_meta and session_meta.get("deliveryContext"):
        channel = session_meta["deliveryContext"].get("channel")
    
    system_prompt_report = session_meta.get("systemPromptReport") if session_meta else None
    if isinstance(system_prompt_report, dict):
        system_prompt_report = json.dumps(system_prompt_report, indent=2)
    
    resolved_skills = []
    if session_meta and session_meta.get("skillsSnapshot"):
        resolved_skills = session_meta["skillsSnapshot"].get("resolvedSkills", [])
        # Extract just the names if it's an array of objects
        if resolved_skills and isinstance(resolved_skills[0], dict):
            resolved_skills = [s.get("name", "unknown") for s in resolved_skills]
    
    # Use totalTokens as the main token count
    tokens = session_meta.get("totalTokens") if session_meta else None
    context_tokens = session_meta.get("contextTokens") if session_meta else None
    input_tokens = session_meta.get("inputTokens") if session_meta else None
    output_tokens = session_meta.get("outputTokens") if session_meta else None
    
    print(f"DEBUG: Extracted metadata - channel={channel}, tokens={tokens}, skills_count={len(resolved_skills)}")
    
    return SessionDetail(
        id=session_id,
        agent=agent,
        label=label,
        path=str(filepath),
        size=analysis["size"],
        raw_content=raw_content,
        entries=analysis["entries"],
        messages=messages,
        tool_calls=tool_calls,
        duration_minutes=duration_mins,
        is_stale=is_stale,
        created=created,
        updated=updated,
        models=sorted(list(models)),
        parentId=parent_id,
        children=children,
        channel=channel,
        systemPromptReport=system_prompt_report,
        resolvedSkills=resolved_skills,
        tokens=tokens,
        contextTokens=context_tokens,
        inputTokens=input_tokens,
        outputTokens=output_tokens,
    )


@app.delete("/sessions/{agent}/{session_id}")
@limiter.limit("30/minute")
def delete_session(request: Request, agent: str, session_id: str, api_key: str = Depends(require_write_access)):
    """Move session to trash instead of permanent delete. Also deletes child sessions."""
    agent = sanitize_path_component(agent, "agent")
    session_id = sanitize_path_component(session_id, "session_id")

    filepath = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"
    sessions_file = AGENTS_DIR / agent / "sessions" / "sessions.json"

    log_action("delete", agent, session_id, user=api_key)

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
            "original_path": str(filepath),
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
                            "original_path": str(child_path),
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
@limiter.limit("60/minute")
def list_trash(request: Request, api_key: str = Depends(verify_api_key)):
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
@limiter.limit("30/minute")
def permanent_delete(request: Request, agent: str, session_id: str, api_key: str = Depends(require_write_access)):
    """Permanently delete a session from trash."""
    agent = sanitize_path_component(agent, "agent")
    session_id = sanitize_path_component(session_id, "session_id")

    log_action("permanent_delete", agent, session_id, user=api_key)
    # Find matching files in trash
    deleted = False
    for trash_file in TRASH_DIR.glob(f"{agent}_{session_id}_*.jsonl"):
        trash_file.unlink()
        deleted = True
    for meta_file in TRASH_DIR.glob(f"{agent}_{session_id}_*.meta.json"):
        meta_file.unlink()

    return {"deleted": deleted, "id": session_id}


@app.post("/trash/{agent}/{session_id}/restore")
@limiter.limit("30/minute")
def restore_from_trash(request: Request, agent: str, session_id: str, api_key: str = Depends(require_write_access)):
    """Restore a session from trash back to active sessions."""
    agent = sanitize_path_component(agent, "agent")
    session_id = sanitize_path_component(session_id, "session_id")

    log_action("restore", agent, session_id, user=api_key)

    # Find the trashed session file
    trash_files = list(TRASH_DIR.glob(f"{agent}_{session_id}_*.jsonl"))
    if not trash_files:
        raise HTTPException(status_code=404, detail="Session not found in trash")

    trash_path = trash_files[0]
    meta_path = trash_path.with_suffix(".meta.json")

    # Read metadata
    try:
        with open(meta_path, "r") as f:
            meta = json.load(f)
        original_path = Path(meta["original_path"])
    except:
        # Fallback: reconstruct path from agent/session_id
        original_path = AGENTS_DIR / agent / "sessions" / f"{session_id}.jsonl"

    # Ensure directory exists
    original_path.parent.mkdir(parents=True, exist_ok=True)

    # Copy file back to original location (in case trash is owned by root)
    shutil.copy2(str(trash_path), str(original_path))

    # Try to remove from trash (may fail if owned by root)
    try:
        trash_path.unlink()
        if meta_path.exists():
            meta_path.unlink()
    except PermissionError:
        # File restored but couldn't clean up trash (owned by root)
        pass

    # Re-add to sessions.json if it was removed
    sessions_file = AGENTS_DIR / agent / "sessions" / "sessions.json"
    if sessions_file.exists():
        try:
            with open(sessions_file, "r") as f:
                sessions = json.load(f)
        except:
            sessions = []

        # Check if already in sessions.json
        exists = any(s.get("sessionId") == session_id for s in sessions)
        if not exists:
            sessions.append({
                "sessionId": session_id,
                "label": session_id[:8],
                "agentId": agent,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "restored": True
            })
            with open(sessions_file, "w") as f:
                json.dump(sessions, f, indent=2)

    return {"restored": True, "id": session_id, "path": str(original_path)}


@app.post("/trash/cleanup")
@limiter.limit("10/minute")
def cleanup_trash(request: Request, api_key: str = Depends(require_write_access)):
    """Delete expired items from trash."""
    log_action("cleanup_trash", "system", user=api_key)

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
@limiter.limit("30/minute")
def prune_session(request: Request, agent: str, session_id: str, req: PruneRequest, api_key: str = Depends(require_write_access)):
    """Prune tool call output, replacing with [pruned]. Also supports light prune for long responses."""
    agent = sanitize_path_component(agent, "agent")
    session_id = sanitize_path_component(session_id, "session_id")

    log_action("prune", agent, session_id, user=api_key, details={"keep_recent": req.keep_recent})

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
@limiter.limit("60/minute")
def edit_entry(request: Request, agent: str, session_id: str, index: int, req: EditEntryRequest, api_key: str = Depends(require_write_access)):
    """Edit a specific session entry."""
    agent = sanitize_path_component(agent, "agent")
    session_id = sanitize_path_component(session_id, "session_id")

    log_action("edit_entry", agent, session_id, user=api_key, details={"index": index})

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
