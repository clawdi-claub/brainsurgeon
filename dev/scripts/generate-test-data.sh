#!/bin/bash
# generate-test-data.sh — Generate realistic test sessions for BrainSurgeon

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$(dirname "$SCRIPT_DIR")"
AGENTS_DIR="${1:-$DEV_DIR/data/agents}"

echo "🧪 BrainSurgeon Test Data Generator"
echo "====================================="
echo ""

# Config
NUM_AGENTS=${NUM_AGENTS:-3}
SESSIONS_PER_AGENT=${SESSIONS_PER_AGENT:-5}
ENTRIES_PER_SESSION=${ENTRIES_PER_SESSION:-20}

# Generate random session ID
generate_session_id() {
    echo "session-$(date +%s)-$(head /dev/urandom | tr -dc 'a-f0-9' | head -c 8)"
}

# Generate random entry ID
generate_entry_id() {
    echo "entry-$(head /dev/urandom | tr -dc 'a-f0-9' | head -c 12)"
}

# Generate a timestamp
generate_timestamp() {
    date -Iseconds 2>/dev/null || echo "2026-02-21T10:00:00Z"
}

# Create test agent
create_test_agent() {
    local agent_num=$1
    local agent_dir="$AGENTS_DIR/test-agent-$agent_num/sessions"
    mkdir -p "$agent_dir"
    
    # Use temp file for sessions.json
    local sessions_json="$agent_dir/sessions.json"
    echo "{" > "$sessions_json"
    
    local first_session=true
    
    for s in $(seq 1 $SESSIONS_PER_AGENT); do
        local session_id=$(generate_session_id)
        local session_file="$agent_dir/${session_id}.jsonl"
        
        echo "📝 Creating session: test-agent-$agent_num / $session_id"
        
        # Generate entries for this session
        for e in $(seq 1 $ENTRIES_PER_SESSION); do
            local entry_id=$(generate_entry_id)
            local timestamp=$(generate_timestamp)
            local entry_type="user_message"
            
            # Alternate entry types
            case $((e % 4)) in
                0) entry_type="user_message" ;;
                1) entry_type="assistant_message" ;;
                2) entry_type="tool_call" ;;
                3) entry_type="tool_result" ;;
            esac
            
            # Create entry JSON (compact, one per line)
            case $entry_type in
                user_message)
                    printf '{"__id":"%s","id":"msg-%s","sessionId":"%s","type":"user_message","text":"Test message %d from agent %d session %d","timestamp":"%s","channel":"telegram","senderId":"6377178111"}\n' "$entry_id" "$entry_id" "$session_id" "$e" "$agent_num" "$s" "$timestamp" >> "$session_file"
                    ;;
                assistant_message)
                    printf '{"__id":"%s","id":"msg-%s","sessionId":"%s","type":"assistant_message","text":"Response %d from agent %d. Here is some thinking: ","timestamp":"%s","model":"kimi-k2.5"}\n' "$entry_id" "$entry_id" "$session_id" "$e" "$agent_num" "$timestamp" >> "$session_file"
                    ;;
                tool_call)
                    printf '{"__id":"%s","id":"tc-%s","sessionId":"%s","type":"tool_call","toolName":"exec","timestamp":"%s","input":{"command":"ls -la ~/","timeout":30}}\n' "$entry_id" "$entry_id" "$session_id" "$timestamp" >> "$session_file"
                    ;;
                tool_result)
                    printf '{"__id":"%s","id":"tr-%s","sessionId":"%s","type":"tool_result","toolName":"exec","timestamp":"%s","output":"total 128\\ndrwxr-xr-x  15 openclaw openclaw 4096 Feb 21 10:30 .","success":true}\n' "$entry_id" "$entry_id" "$session_id" "$timestamp" >> "$session_file"
                    ;;
            esac
        done
        
        # Add to sessions.json
        local now=$(date +%s)000
        if [ "$first_session" = true ]; then
            first_session=false
        else
            echo "," >> "$sessions_json"
        fi
        
        cat >> "$sessions_json" << EOF
  "test-agent-$agent_num:$session_id": {
    "sessionId": "$session_id",
    "updatedAt": $now,
    "systemSent": false,
    "abortedLastRun": false,
    "chatType": "test",
    "sessionFile": "$agent_dir/${session_id}.jsonl",
    "compactionCount": 0
  }
EOF
    done
    
    echo "}" >> "$sessions_json"
    
    # Create agent metadata
    cat > "$AGENTS_DIR/test-agent-$agent_num/agent.json" << EOF
{
  "id": "test-agent-$agent_num",
  "name": "Test Agent $agent_num",
  "created": "2026-02-01T00:00:00Z",
  "lastActive": "$(date -Iseconds)"
}
EOF
}

# Main
echo "📁 Output directory: $AGENTS_DIR"
echo "👥 Agents: $NUM_AGENTS"
echo "📄 Sessions per agent: $SESSIONS_PER_AGENT"
echo "📝 Entries per session: $ENTRIES_PER_SESSION"
echo ""

# Create directory
mkdir -p "$AGENTS_DIR"

# Generate test data for each agent
for i in $(seq 1 $NUM_AGENTS); do
    create_test_agent $i
done

echo ""
echo "✅ Generated test data:"
echo "   $NUM_AGENTS agents"
echo "   $((NUM_AGENTS * SESSIONS_PER_AGENT)) sessions"
echo "   $((NUM_AGENTS * SESSIONS_PER_AGENT * ENTRIES_PER_SESSION)) entries"
echo ""
echo "📂 Location: $AGENTS_DIR"
echo ""
echo "💡 Use this data with the dev environment:"
echo "   cd $DEV_DIR"
echo "   docker compose -f docker-compose.dev.yml up -d brainsurgeon-api-dev"
echo ""
