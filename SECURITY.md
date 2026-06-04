# Security Notes

## Token Management

This tool requires sensitive credentials that should **NEVER** be committed to version control:

### Sensitive Values

1. **DATABASE_URL** - Postgres connection string (may embed a password)
   - Required; never commit it. Cloud providers (Neon/Supabase/Vercel) include credentials in the URL.

2. **GITHUB_TOKEN** (optional) - for `investigate_issue` / `learn_from_pr` reads
   - Get from: https://github.com/settings/tokens
   - Recommended for higher API rate limits (5000/hour vs 60/hour)

3. **OPENAI_API_KEY** (optional) - only if `EMBEDDING_PROVIDER`/`LLM_PROVIDER=openai`
   - The default Ollama stack is local and needs no key.

### Security Best Practices

1. **Never commit tokens to git**
   - All sensitive files are in `.gitignore`:
     - `.env` - Contains your tokens
     - `cursor-mcp-config.json` - May contain tokens
     - `results/` - May contain cached data

2. **Use environment variables**
   - Store tokens in `.env` file (not committed)
   - Or set as environment variables in your shell/system

3. **Rotate tokens if exposed**
   - If a credential is ever committed, immediately revoke and regenerate it
   - GitHub: Revoke in GitHub Settings → Developer settings → Personal access tokens
   - Database: rotate the Postgres password / connection string

4. **Use minimal permissions**
   - GitHub token: Only grant `public_repo` scope (or specific repo access)

5. **Don't share tokens**
   - Each user should have their own tokens
   - Use `.env.example` as a template, not with real values

### Files to Never Commit

- `.env` - Your local environment variables
- `cursor-mcp-config.json` - Your local Cursor MCP configuration
- `results/*.json` - Generated cache files (may contain issue data)

### Example Setup

1. Copy the example file:
   ```bash
   cp env.example .env
   ```

2. Edit `.env` with your tokens (never commit this file)

3. For Cursor MCP, manually set tokens in `cursor-mcp-config.json` or your global MCP config

