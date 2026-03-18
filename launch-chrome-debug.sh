#!/bin/bash
# Launches Chrome with remote debugging enabled for Claude Code testing
# Close all existing Chrome windows before running this

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-profile \
  "https://lovable.dev" &

echo "Chrome launched with remote debugging on port 9222"
echo "Now restart Claude Code and ask it to test the extension."
