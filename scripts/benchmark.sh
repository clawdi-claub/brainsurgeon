#!/usr/bin/env bash
#
# BrainSurgeon Smart Pruning Benchmark
# Measures token savings from extraction
#

set -e

API_URL="${BRAINSURGEON_URL:-http://localhost:8000}"
API_KEY="${BRAINSURGEON_API_KEY:-}"
AGENT_ID="benchmark-agent"
SESSION_ID="benchmark-$(date +%s)"

echo "🧠 BrainSurgeon Smart Pruning Benchmark"
echo "========================================="
echo "API: $API_URL"
echo "Agent: $AGENT_ID"
echo "Session: $SESSION_ID"
echo ""

# Helper function for API calls
api_call() {
    local method="$1"
    local path="$2"
    local body="${3:-}"
    
    local headers=()
    if [[ -n "$API_KEY" ]]; then
        headers+=(-H "X-API-Key: $API_KEY")
    fi
    
    if [[ "$method" == "POST" || "$method" == "PUT" ]]; then
        headers+=(-H "Content-Type: application/json")
        curl -s "${headers[@]}" -X "$method" "${API_URL}${path}" -d "$body"
    else
        curl -s "${headers[@]}" -X "$method" "${API_URL}${path}"
    fi
}

# Create test session with various content types
echo "📊 Creating test session with sample data..."

# Create a session with mixed content
cat > /tmp/benchmark_session.jsonl << 'EOF'
{"__id":"msg-001","type":"message","role":"user","content":"Hello, can you help me analyze this data?","timestamp":1706745600000}
{"__id":"msg-002","type":"message","role":"assistant","content":"I'd be happy to help analyze your data. Let me start by understanding what we're working with. This is a longer response that demonstrates how the system handles multi-line content and various formatting options.","timestamp":1706745605000}
{"__id":"msg-003","type":"tool_call","tool_calls":[{"id":"call-001","type":"function","function":{"name":"exec","arguments":"{\"command\":\"ls -la\",\"description\":\"List files\"}"}}],"timestamp":1706745610000}
{"__id":"msg-004","type":"tool_result","tool_call_id":"call-001","role":"tool","content":"total 128\\ndrwxr-xr-x  5 user user  4096 Jan 31 10:00 .\\ndrwxr-xr-x  3 user user  4096 Jan 31 09:00 ..\\n-rw-r--r--  1 user user  2048 Jan 31 10:00 config.json\\n-rw-r--r--  1 user user  8192 Jan 31 09:30 data.csv\\n-rw-r--r--  1 user user  4096 Jan 31 09:45 notes.md\\n","timestamp":1706745615000}
{"__id":"msg-005","type":"message","role":"assistant","content":"I can see you have several files in your directory. The data.csv file looks promising for analysis. Let me examine it more closely.","timestamp":1706745620000}
{"__id":"msg-006","type":"tool_call","tool_calls":[{"id":"call-002","type":"function","function":{"name":"read","arguments":"{\"file_path\":\"data.csv\"}"}}],"timestamp":1706745625000}
{"__id":"msg-007","type":"tool_result","tool_call_id":"call-002","role":"tool","content":"This is a very long CSV file with thousands of rows of data. Each row contains multiple columns with various data types including strings, numbers, dates, and categorical values. The file is large enough that it would benefit from extraction to keep the main session file lean and fast to load. This demonstrates the value of smart pruning for managing large content.","timestamp":1706745630000}
{"__id":"msg-008","type":"message","role":"assistant","content":"Excellent! I can see this is a substantial dataset. Let me provide you with a summary analysis of the key patterns and insights I've identified from examining the data.","timestamp":1706745635000}
EOF

# Calculate original size
ORIGINAL_SIZE=$(wc -c < /tmp/benchmark_session.jsonl)
ORIGINAL_LINES=$(wc -l < /tmp/benchmark_session.jsonl)

echo "Original session: $ORIGINAL_LINES lines, $(numfmt --to=iec $ORIGINAL_SIZE)"
echo ""

# Simulate extraction
echo "🔬 Simulating smart pruning..."

# Extract large content (tool results with >500 chars)
EXTRACTED_SIZE=0
EXTRACTED_COUNT=0

while IFS= read -r line; do
    type=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null)
    content=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('content','')[:100])" 2>/dev/null)
    
    if [[ "$type" == "tool_result" ]] && [[ ${#content} -gt 500 ]]; then
        EXTRACTED_SIZE=$((EXTRACTED_SIZE + ${#line}))
        EXTRACTED_COUNT=$((EXTRACTED_COUNT + 1))
    fi
done < /tmp/benchmark_session.jsonl

# Calculate savings
REMAINING_SIZE=$((ORIGINAL_SIZE - EXTRACTED_SIZE))
SAVINGS_PCT=$(echo "scale=1; 100 * $EXTRACTED_SIZE / $ORIGINAL_SIZE" | bc 2>/dev/null || echo "N/A")

echo ""
echo "📊 Results"
echo "=========="
echo "Entries extracted: $EXTRACTED_COUNT"
echo "Bytes extracted:   $(numfmt --to=iec $EXTRACTED_SIZE)"
echo "Remaining size:    $(numfmt --to=iec $REMAINING_SIZE)"
echo "Space saved:       ${SAVINGS_PCT}%"
echo ""

# Context window impact (approximate)
echo "🧠 Context Window Impact"
echo "========================="
# Rough estimate: ~4 chars per token
ORIGINAL_TOKENS=$((ORIGINAL_SIZE / 4))
REMAINING_TOKENS=$((REMAINING_SIZE / 4))
SAVED_TOKENS=$((EXTRACTED_SIZE / 4))

echo "Original tokens:  ~$(numfmt --to=iec $ORIGINAL_TOKENS)"
echo "Remaining tokens: ~$(numfmt --to=iec $REMAINING_TOKENS)"
echo "Tokens saved:     ~$(numfmt --to=iec $SAVED_TOKENS)"
echo ""

# Cleanup
rm -f /tmp/benchmark_session.jsonl

echo "✅ Benchmark complete"
