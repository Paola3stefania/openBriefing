#!/bin/bash
# View MCP server logs
# If MCP_LOG_FILE is set, shows that file
# Otherwise shows recent console output

LOG_FILE="${MCP_LOG_FILE:-logs/mcp-server.log}"

if [ -f "$LOG_FILE" ]; then
  echo "=== MCP Server Logs (from $LOG_FILE) ==="
  echo ""
  tail -100 "$LOG_FILE"
else
  echo "No log file found at: $LOG_FILE"
  echo ""
  echo "To enable file logging, set MCP_LOG_FILE environment variable:"
  echo "  export MCP_LOG_FILE=logs/mcp-server.log"
  echo ""
  echo "Or check Cursor's MCP server output panel for console logs."
fi

