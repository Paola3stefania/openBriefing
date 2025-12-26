# GitHub Integration

Discord MCP server integrates with GitHub to search repository issues and correlate them with Discord discussions.

## Tools

### `search_github_issues`

Search GitHub issues in the configured repository (set via `GITHUB_OWNER` and `GITHUB_REPO`).

**Parameters:**
- `query` (required): Search query
- `state` (optional): "open", "closed", or "all" (default: "all")

**Returns:**
- Total count and list of matching issues with number, title, state, URL, author, dates, labels, and body preview

### `search_discord_and_github`

Search both Discord messages and GitHub issues for a topic.

**Parameters:**
- `query` (required): Search query
- `channel_id` (optional): Discord channel ID (uses default if not provided)
- `discord_limit` (optional): Number of messages to search (1-100, default: 50)
- `github_state` (optional): Issue state filter (default: "all")

**Returns:**
- Combined results from Discord and GitHub

## Configuration

### GitHub Token (Optional)

For higher rate limits (5000 requests/hour vs 60 without token):

1. Create token at: https://github.com/settings/tokens
2. Add to `.env`:
   ```
   GITHUB_TOKEN=your_token_here
   ```
3. Or add to MCP server config environment variables

Without a token, rate limit is 60 requests/hour. With a token, 5000 requests/hour.
