# UNMute

MCP server that classifies Discord conversations, correlates with GitHub issues, and exports to PM tools (Linear/Jira).

## Setup

1. Install: `npm install && npm run build`
2. Configure: Copy `env.example` to `.env` and set:
   - `DISCORD_TOKEN` (required)
   - `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` (required)
   - `OPENAI_API_KEY` (optional, for semantic classification)
   - `DATABASE_URL` (optional, for PostgreSQL storage)
   - `PM_TOOL_*` (optional, for Linear/Jira export)
3. Database (optional): `createdb unmute_mcp && npx prisma migrate deploy`

See `cursor-mcp-config.json.example` for MCP configuration.

## Quick Start

**Recommended: Use the complete workflow:**
```bash
sync_classify_and_export  # Does everything: fetch → embed → group → label → match → export → sync
```

This single tool runs the complete workflow:
1. Fetch GitHub issues
2. Check Discord messages
3. Compute all embeddings (issues, threads, features, groups)
4. Group related issues
5. Match Discord threads to issues
6. Label issues
7. Match to features (ungrouped issues, grouped issues, and groups)
8. Export to Linear
9. Sync Linear status
10. Sync PR-based status

## All Tools

### Complete Workflow
- `sync_classify_and_export` - **Complete workflow** (recommended): Fetch, compute embeddings, group, label, match features, export, sync status

### Data Fetching
- `fetch_github_issues` - Fetch and cache GitHub issues (incremental)
- `fetch_discord_messages` - Fetch and cache Discord messages (incremental)

### Discovery
- `list_servers` - List Discord servers
- `list_channels` - List Discord channels
- `list_linear_teams` - List Linear teams
- `read_messages` - Read messages from a channel
- `search_messages` - Search Discord messages
- `search_github_issues` - Search GitHub issues
- `search_discord_and_github` - Search both Discord and GitHub

### Grouping & Classification
- `group_github_issues` - Group related GitHub issues (issue-centric)
- `suggest_grouping` - Group Discord threads by matched issues (thread-centric)
- `classify_discord_messages` - Classify Discord messages with GitHub issues

### Feature Matching
- `match_issues_to_features` - Match GitHub issues to product features
- `match_ungrouped_issues_to_features` - Match ungrouped issues to features
- `match_database_groups_to_features` - Match groups to features (issue-centric)
- `match_groups_to_features` - Match groups to features (thread-centric, JSON-based)

### Thread/Issue Matching
- `match_issues_to_threads` - Match GitHub issues to Discord threads

### Labeling
- `label_github_issues` - Detect and assign labels to GitHub issues (bug, security, etc.)
- `label_linear_issues` - Add labels to Linear issues

### Embeddings
- `compute_discord_embeddings` - Compute Discord thread embeddings
- `compute_github_issue_embeddings` - Compute GitHub issue embeddings
- `compute_feature_embeddings` - Compute feature embeddings (with code context)
- `compute_group_embeddings` - Compute group embeddings

### Code Indexing
- `index_codebase` - Index code for a specific query
- `index_code_for_features` - Index code for all features

### Documentation
- `manage_documentation_cache` - Manage documentation cache (fetch, extract features, compute embeddings, list, clear)

### Export & Sync
- `export_to_pm_tool` - Export to Linear/Jira
- `sync_linear_status` - Sync GitHub → Linear (closed/merged → Done)
- `sync_pr_based_status` - Sync PRs → Linear (open PRs → In Progress with assignee)
- `sync_combined` - Combined sync (PR sync + status sync)

### Linear Management
- `classify_linear_issues` - Classify Linear issues into projects/features

### Validation & Stats
- `validate_pm_setup` - Validate PM tool configuration
- `validate_export_sync` - Compare DB export tracking with Linear issues
- `export_stats` - View comprehensive statistics
- `check_github_issues_completeness` - Verify all issues fetched
- `check_discord_classification_completeness` - Verify all messages classified

## Documentation

- [Environment Variables](docs/ENVIRONMENT_VARIABLES.md)
- [Database Setup](docs/DATABASE_SETUP.md)
- [GitHub Integration](docs/GITHUB_INTEGRATION.md)
- [Linear Setup](docs/LINEAR_TEAM_SETUP.md)
