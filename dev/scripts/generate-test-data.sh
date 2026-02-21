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
    local offset=$1
    date -d "$offset minutes ago" -Iseconds 2>/dev/null || date -v-${offset}M -Iseconds 2>/dev/null || echo "2026-02-21T$((10 + RANDOM % 10)):$((RANDOM % 60)):$((RANDOM % 60))Z"
}

# Create test agent
create_test_agent() {
    local agent_dir="$AGENTS_DIR/test-agent-$1/sessions"
    mkdir -p "$agent_dir"
    
    for s in $(seq 1 $SESSIONS_PER_AGENT); do
        local session_id=$(generate_session_id)
        local session_file="$agent_dir/${session_id}.jsonl"
        
        echo "📝 Creating session: test-agent-$1 / $session_id"
        
        # Generate entries for this session
        for e in $(seq 1 $ENTRIES_PER_SESSION); do
            local entry_id=$(generate_entry_id)
            local timestamp=$(generate_timestamp $((s * 100 + e)))
            local entry_type="user_message"
            
            # Alternate entry types
            case $((e % 4)) in
                0) entry_type="user_message" ;;
                1) entry_type="assistant_message" ;;
                2) entry_type="tool_call" ;;
                3) entry_type="tool_result" ;;
            esac
            
            # Create entry JSON
            case $entry_type in
                user_message)
                    cat >> "$session_file" << EOF
{"__id":"$entry_id","id":"msg-$entry_id","sessionId":"$session_id","type":"user_message","text":"This is test message $e from test agent $1 session $s","timestamp":"$timestamp","channel":"telegram","senderId":"6377178111"}
EOF
                    ;;
                assistant_message)
                    cat >> "$session_file" << EOF
{"__id":"$entry_id","id":"msg-$entry_id","sessionId":"$session_id","type":"assistant_message","text":"This is assistant response $e for test agent $1 session $s. Here is some thinking: $(printf 'x%.0s' {1..500})","timestamp":"$timestamp","model":"kimi-k2.5"}
EOF
                    ;;
                tool_call)
                    cat >> "$session_file" << EOF
{"__id":"$entry_id","id":"tc-$entry_id","sessionId":"$session_id","type":"tool_call","toolName":"exec","timestamp":"$timestamp","input":{"command":"ls -la ~/","timeout":30}}
EOF
                    ;;
                tool_result)
                    cat >> "$session_file" << EOF
{"__id":"$entry_id","id":"tr-$entry_id","sessionId":"$session_id","type":"tool_result","toolName":"exec","timestamp":"$timestamp","output":"total 128\ndrwxr-xr-x  15 openclaw openclaw 4096 Feb 21 10:30 .\nddrwxr-xr-x  12 openclaw openclaw 4096 Feb 20 14:22 ..\n$(printf "drwxr-xr-x  3 openclaw openclaw 4096 Feb 21 %02d:%02d .\n" $((RANDOM % 24)) $((RANDOM % 60)))","success":true}
EOF
                    ;;
            esac
        done
    done
    
    # Create agent metadata
    cat > "$AGENTS_DIR/test-agent-$1/agent.json" << EOF
{
  "id": "test-agent-$1",
  "name": "Test Agent $1",
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
echo "   AGENTS_DIR=./data/agents docker-compose -f docker-compose.dev.yml up"
echo ""
