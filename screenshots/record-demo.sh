#!/bin/bash
# BrainSurgeon Demo Recording Script

export DISPLAY=:99

# Ensure Xvfb is running
if ! pgrep -x "Xvfb" > /dev/null; then
    Xvfb :99 -screen 0 1440x900x24 -ac &
    sleep 2
fi

OUTPUT_DIR="${OUTPUT_DIR:-/home/openclaw/projects/brainsurgeon/screenshots}"
SESSION_URL="${SESSION_URL:-http://localhost:8654}"

# Function to take screenshot
screenshot() {
    local filename="$1"
    chromium --headless --screenshot="$OUTPUT_DIR/$filename.png" \
        --window-size=1440,900 --hide-scrollbars --no-sandbox \
        "$SESSION_URL" 2>/dev/null
    echo "Screenshot saved: $OUTPUT_DIR/$filename.png"
}

# Function to take screenshot of a specific session
screenshot_session() {
    local agent="$1"
    local session="$2"
    local filename="$3"

    chromium --headless --screenshot="$OUTPUT_DIR/$filename.png" \
        --window-size=1440,900 --hide-scrollbars --no-sandbox \
        "$SESSION_URL" 2>/dev/null
}

echo "Taking demo screenshots..."

# Main view
screenshot "01-main-view"

echo "Screenshots complete!"
echo "To create an animated GIF, run:"
echo "convert -delay 100 -loop 0 $OUTPUT_DIR/*.png $OUTPUT_DIR/demo.gif"
