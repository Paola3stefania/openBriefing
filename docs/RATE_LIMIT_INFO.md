# GitHub API Rate Limits

## Limits

- Without GitHub token: 60 requests/hour
- With GitHub token: 5000 requests/hour

When analyzing 20+ messages, you'll hit the limit without a token.

## Solution: Add GitHub Token

### Create Token

1. Go to: https://github.com/settings/tokens
2. Generate new token (classic)
3. No scope needed (public repo access is sufficient)
4. Copy the token

### Add to Config

**Option 1: `.env` file**
```
GITHUB_TOKEN=your_token_here
```

**Option 2: MCP server config**
Add to environment variables in your MCP server configuration.

## Rate Limit Handling

The system includes:
- Automatic delays between requests (2 seconds without token, 200ms with token)
- Error handling for rate limit errors
- Graceful degradation (continues processing other messages if some fail)

## Recommendations

- Use GitHub token for production use
- Process in smaller batches for large channels
- Start with 5-10 messages to test

## Capacity

- Without token: ~30-40 messages before hitting limits
- With token: Hundreds of messages quickly
