# UNMute

UNMute is an MCP server that integrates communication platforms (Discord, GitHub, and more) to help manage projects by classifying conversations, correlating discussions with issues, and exporting insights to project management tools.

## Current Integrations

- **Discord**: Read messages, classify conversations, detect threads
- **GitHub**: Search issues, correlate with Discord discussions
- **PM Tools**: Export classified data to Linear, Jira (via documentation-based feature extraction)

## Planned Integrations

- **Slack**: Message classification and issue correlation
- **Additional platforms**: Coming soon

## Non-Goals

UNMute intentionally does **not**:

- **Auto-close issues** - Linear owns the issue lifecycle. UNMute surfaces and groups signals, but closing happens via PR merge (Linear's native GitHub integration)
- **Infer PR fixes** - We don't guess which PR fixes which issue. Engineers explicitly reference Linear issue IDs (`LIN-123`) in PRs
- **Auto-merge duplicates** - Grouping is suggestive, not automatic. Humans confirm merges
- **Replace your PM tool** - UNMute feeds data into Linear/Jira; it doesn't replace them

See [docs/LINEAR_GITHUB_CONTRACT.md](docs/LINEAR_GITHUB_CONTRACT.md) for the full contract.

## Features

### Discord Integration

- Read messages from Discord channels
- Organize messages by threads
- Classify messages using keyword-based or semantic (LLM) matching
- Incremental message fetching with caching

### GitHub Integration

- Fetch repository issues and comments (with retry mechanism)
- Correlate Discord discussions with GitHub issues
- Cache issues for offline analysis
- Incremental issue updates

### Classification

- **Keyword-based**: Fast, free classification using keyword matching (default when OpenAI not configured)
- **Semantic (LLM-based)**: Context-aware classification using OpenAI embeddings (enabled by default when `OPENAI_API_KEY` is set)
- **Persistent embedding cache with lazy loading**: All embeddings (issues, threads, groups, code sections, features) are cached to database/disk and only recomputed when content changes (contentHash validation)
- Thread-aware classification
- Classification history tracking
- Automatically syncs issues and messages before classifying

**Similarity Scales:**

UNMute uses **two different similarity scales** depending on the operation:

1. **Issue Matching (Classification)** - **0-100 scale** (percentage-based)
   - `80-100`: **Strong match** - Thread is very likely related to this issue
   - `60-79`: **Moderate match** - Thread may be related, worth reviewing
   - `40-59`: **Weak match** - Possibly related, but needs verification
   - `0-39`: **Unlikely match** - Probably unrelated
   - **Default threshold: `60`** - Only matches >= 60 are considered for grouping
   - **Recommended tiers:**
     - `min_similarity: 80` - High confidence only (fewer false positives)
     - `min_similarity: 60` - Balanced (default, good precision/recall)
     - `min_similarity: 40` - More inclusive (may include false positives)

2. **Feature Matching (Group-to-Feature)** - **0.0-1.0 scale** (cosine similarity)
   - `0.7-1.0`: **Strong feature match** - Group clearly relates to this feature
   - `0.5-0.7`: **Moderate feature match** - Group may relate to this feature
   - `0.0-0.5`: **Weak feature match** - Unlikely to relate
   - **Default threshold: `0.5`** - Only matches >= 0.5 are considered
   - **Recommended tiers:**
     - `min_similarity: 0.7` - High confidence only
     - `min_similarity: 0.5` - Balanced (default)
     - `min_similarity: 0.3` - More inclusive

### Two Workflow Approaches

UNMute supports two approaches for organizing and exporting data:

#### Issue-Centric Workflow (Recommended)

GitHub issues are the primary entity. Discord threads are attached as context.

```
fetch_github_issues -> group_github_issues -> match_issues_to_features -> label_github_issues -> export_to_pm_tool
                                                                                                        |
                                           match_issues_to_threads (optional) ---------------------------+
```

- **Best for**: Teams that primarily track work via GitHub issues
- **Output**: 1 GitHub issue group = 1 Linear issue (with Discord context attached)

#### Thread-Centric Workflow

Discord threads are the primary entity. GitHub issues are used for grouping.

```
sync_and_classify -> suggest_grouping -> match_groups_to_features -> export_to_pm_tool
```

- **Best for**: Teams where Discord is the primary source of feedback
- **Output**: Discord thread groups = Linear issues

### Semantic Grouping

- **Issue-based grouping**: Group threads by their matched GitHub issues (fast, no LLM calls)
- **Feature matching**: Map groups to product features using three-tier matching:
  - **Rule-based matching**: Keyword/name matching (highest priority, works without embeddings)
  - **Semantic similarity**: Cosine similarity between embeddings (when embeddings available)
  - **Code-based matching**: Function-level code matching using saved code section embeddings
- **Cross-cutting detection**: Identify issues affecting multiple product features
- **Graceful degradation**: If embedding computation fails, still attempts rule-based and code-based matching

### PM Tool Export

- Extract product features from documentation (URLs or local file paths)
- Map conversations to features using semantic similarity
- Export to Linear, Jira, and other PM tools
- Export results saved to `results/` for tracking history

### Storage Backends

UNMute supports two storage backends:

- **JSON Files (Default)**: Simple file-based storage, perfect for testing and small datasets
  - No setup required
  - Data stored in `cache/` and `results/` directories
  - Works out of the box

- **PostgreSQL (Optional)**: Production-ready database storage
  - Better performance for large datasets
  - SQL queries for advanced analysis
  - Concurrent access support
  - Auto-detected when `DATABASE_URL` is set
  - **Required when configured**: When `DATABASE_URL` is set, all data is saved to PostgreSQL (no fallback to JSON)
  - See [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) for setup

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Configure environment variables (see `env.example`):
   - `DISCORD_TOKEN`: Discord bot token (required)
   - `GITHUB_OWNER`: GitHub organization/username (required)
   - `GITHUB_REPO`: GitHub repository name (required)
   - **GitHub Authentication** (choose one):
     - `GITHUB_TOKEN`: Personal access token (get from https://github.com/settings/tokens)
     - OR GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH` (see [docs/GITHUB_INTEGRATION.md](docs/GITHUB_INTEGRATION.md))
   - `OPENAI_API_KEY`: OpenAI API key (optional, for semantic classification)
   - `DOCUMENTATION_URLS`: URLs or file paths to product documentation (optional, for PM export)
   - `PM_TOOL_*`: PM tool configuration (optional, for PM export)

4. **(Optional) Set up PostgreSQL database:**
   
   ```bash
   # Create database
   createdb unmute_mcp
   
   # Set DATABASE_URL in .env
   DATABASE_URL=postgresql://user:password@localhost:5432/unmute_mcp
   
   # Run migrations
   npx prisma migrate deploy
   ```
   
   See [docs/DATABASE_SETUP.md](docs/DATABASE_SETUP.md) for detailed setup instructions.

5. Configure MCP server in `cursor-mcp-config.json` (or `~/.cursor/mcp.json`)

## Getting Started

After completing setup, follow these steps for your first run:

### 1. Validate Your Setup (Recommended)

Before running workflows, validate your configuration:

- **`validate_pm_setup`** - Validates PM tool (Linear/Jira) configuration, API keys, and environment variables. Run this first to ensure everything is configured correctly.

### 2. Discover Your Environment (Optional but Recommended)

Explore what's available before fetching data:

- **`list_servers`** - List Discord servers your bot can access
- **`list_channels`** - List channels in a Discord server (requires `server_id`)
- **`list_linear_teams`** - List Linear teams (if using Linear export, helps you find your `PM_TOOL_TEAM_ID`)

### 3. Fetch Initial Data

Fetch and cache data from your sources:

- **`fetch_github_issues`** - Fetch and cache GitHub issues (incremental, safe to rerun)
- **`fetch_discord_messages`** - Fetch and cache Discord messages (incremental, safe to rerun)

> **Note**: These tools are incremental - they only fetch new/updated data on subsequent runs, so they're safe to run multiple times.

### 4. Choose a Workflow

After fetching data, choose one of the workflows below (see [Usage Examples](#usage-examples) for details):

**Issue-Centric Workflow (Recommended)** - Best if you primarily track work via GitHub issues:
1. `group_github_issues`
2. `match_issues_to_features`
3. `label_github_issues`
4. `match_issues_to_threads` (optional - adds Discord context)
5. `export_to_pm_tool`

**Thread-Centric Workflow** - Best if Discord is your primary source of feedback:
1. `sync_and_classify` (auto-fetches messages and issues, then classifies)
2. `suggest_grouping`
3. `match_groups_to_features`
4. `export_to_pm_tool`

### Quick Start Summary

For a quick test run:

```bash
# 1. Validate setup
validate_pm_setup

# 2. (Optional) Discover servers/channels
list_servers
list_channels(server_id: "your-server-id")

# 3. Fetch data
fetch_github_issues
fetch_discord_messages

# 4. Run your chosen workflow (see Usage Examples below)
```

## MCP Tools

These tool names are **stable** and will not change. Semantics may evolve, but names are fixed.

### Primary Entry Points

| Tool | Description |
|------|-------------|
| `sync_and_classify` | **Thread-centric entry point** - Sync messages, sync issues, classify |
| `export_to_pm_tool` | **Issue-centric entry point** - Export GitHub issues to Linear/Jira with Discord context |

### Issue-Centric Workflow Tools

| Tool | Description |
|------|-------------|
| `group_github_issues` | Group related GitHub issues together (1 group = 1 Linear issue) |
| `match_issues_to_features` | Match GitHub issues to product features using embeddings |
| `label_github_issues` | Detect and assign labels (bug, security, regression, etc.) to issues |
| `match_issues_to_threads` | Match GitHub issues to related Discord threads |

### Thread-Centric Workflow Tools

| Tool | Description |
|------|-------------|
| `classify_discord_messages` | Classify Discord messages with GitHub issues (auto-syncs first) |
| `suggest_grouping` | Group threads by matched issues (runs classification if needed) |
| `match_groups_to_features` | Map thread groups to product features |

### Data Fetching Tools

| Tool | Description |
|------|-------------|
| `fetch_discord_messages` | Fetch and cache Discord messages (incremental) |
| `fetch_github_issues` | Fetch and cache GitHub issues (incremental) |

### Discovery Tools

| Tool | Description |
|------|-------------|
| `list_servers` | List Discord servers the bot can access |
| `list_channels` | List channels in a Discord server |
| `read_messages` | Read messages from a channel |
| `search_messages` | Search messages in a channel |
| `search_github_issues` | Search GitHub issues |
| `search_discord_and_github` | Search both Discord and GitHub |

### Embedding Tools

| Tool | Description |
|------|-------------|
| `compute_discord_embeddings` | Pre-compute embeddings for Discord threads |
| `compute_github_issue_embeddings` | Pre-compute embeddings for GitHub issues |
| `compute_feature_embeddings` | Compute embeddings for product features with code context |

### Code Indexing Tools

| Tool | Description |
|------|-------------|
| `index_codebase` | Index code from repository for a specific query |
| `index_code_for_features` | Proactively index code for all features |

### PM Tool Management

| Tool | Description |
|------|-------------|
| `manage_documentation_cache` | Manage documentation cache: `fetch`, `extract_features`, `compute_embeddings`, `list`, `clear` |
| `list_linear_teams` | List Linear teams (for configuration) |
| `validate_pm_setup` | Validate PM tool configuration |

### Linear-Specific Tools

| Tool | Description |
|------|-------------|
| `sync_linear_status` | Sync GitHub issue states to Linear tickets (GitHub -> Linear). Marks Linear as "Done" when GitHub issues are closed or have merged PRs. |
| `sync_pr_based_status` | Sync Linear issue status and assignee based on open PRs. Updates Linear to "In Progress" and assigns user when open PRs exist. Only assigns if PR author is an organization engineer. |
| `sync_combined` | Combined sync workflow: Runs both PR-based sync and Linear status sync in sequence. Step 1: Sets issues to "In Progress" when open PRs are found. Step 2: Marks issues as "Done" when closed/merged. |
| `classify_linear_issues` | Classify Linear issues into projects/features |
| `label_linear_issues` | Add missing labels to Linear issues using LLM |

### Validation Tools

| Tool | Description |
|------|-------------|
| `check_github_issues_completeness` | Verify all GitHub issues have been fetched |
| `check_discord_classification_completeness` | Verify all Discord messages have been classified |

## Usage Examples

> **Note**: For first-time users, we recommend completing the [Getting Started](#getting-started) steps above (validate setup, discover servers/channels) before running these workflows. The workflows below will fetch data automatically if needed.

### Issue-Centric Workflow (Recommended)

```bash
# 1. Fetch GitHub issues
fetch_github_issues

# 2. Group related issues
group_github_issues

# 3. Match issues to product features
match_issues_to_features

# 4. Add labels for priority
label_github_issues

# 5. Export to Linear
export_to_pm_tool
```

### Thread-Centric Workflow

```bash
# 1. Sync and classify Discord messages
sync_and_classify

# 2. Group threads by matched issues
suggest_grouping

# 3. Match groups to features
match_groups_to_features

# 4. Export to Linear
export_to_pm_tool
```

### Documentation Setup

```bash
# 1. Fetch documentation
manage_documentation_cache(action: "fetch")

# 2. Extract features from documentation
manage_documentation_cache(action: "extract_features")

# 3. Compute embeddings
manage_documentation_cache(action: "compute_embeddings")
```

### PR-Based Status Sync

Sync Linear issue status and assignee based on open PRs connected to GitHub issues. When an open PR exists for a GitHub issue that has a Linear ticket, this tool:
- Updates Linear issue status to "In Progress"
- Assigns the Linear issue to the PR author (if they're an organization engineer)

**Prerequisites:**
- User mappings: GitHub username → Linear user ID (auto-built from CSV if available, see [docs/CSV_SETUP.md](docs/CSV_SETUP.md))
- Organization engineer list: Defines which GitHub users should trigger assignments

**Usage:**

```bash
# Dry run to see what would be updated
sync_pr_based_status(dry_run: true)

# Run sync (auto-builds mappings from CSV if MEMBERS_CSV_PATH is set)
sync_pr_based_status(dry_run: false)

# Manual user mappings (optional, overrides CSV)
sync_pr_based_status(
  dry_run: false,
  user_mappings: [
    {"githubUsername": "engineer1", "linearUserId": "linear-user-id-1"},
    {"githubUsername": "engineer2", "linearUserId": "linear-user-id-2"}
  ],
  organization_engineers: ["engineer1", "engineer2"],
  default_assignee_id: "optional-default-linear-user-id"
)
```

**Configuration Options:**
- `MEMBERS_CSV_PATH`: Path to CSV file with organization members (see [docs/CSV_SETUP.md](docs/CSV_SETUP.md))
- `ORGANIZATION_ENGINEERS`: Comma-separated list or JSON array of GitHub usernames
- `USER_MAPPINGS`: JSON array of `{githubUsername, linearUserId}` mappings

**Difference from `sync_linear_status`:**
- `sync_linear_status`: Checks if issues are closed/merged → marks Linear as "Done"
- `sync_pr_based_status`: Checks for open PRs → marks Linear as "In Progress" and assigns users

### Combined Sync Workflow

The `sync_combined` tool runs both PR-based sync and Linear status sync in sequence, providing a complete sync workflow in a single operation:

**Step 1: PR-based sync**
- Checks for open PRs connected to GitHub issues
- Sets Linear issues to "In Progress" status
- Assigns Linear issues to PR authors (if organization engineers)

**Step 2: Linear status sync**
- Checks if GitHub issues are closed or have merged PRs
- Marks Linear issues as "Done" when issues are closed/merged

This workflow ensures Linear issues accurately reflect the current state of GitHub work:
- Issues with open PRs → "In Progress" with assignment
- Issues that are closed/merged → "Done"

**Usage:**

```bash
# Dry run to see what would be updated
sync_combined(dry_run: true)

# Run combined sync (auto-builds mappings from CSV if MEMBERS_CSV_PATH is set)
sync_combined(dry_run: false)

# With manual configuration
sync_combined(
  dry_run: false,
  force: false,  # If true, re-checks all issues including those already marked as "done"
  user_mappings: [
    {"githubUsername": "engineer1", "linearUserId": "linear-user-id-1"}
  ],
  organization_engineers: ["engineer1", "engineer2"],
  default_assignee_id: "optional-default-linear-user-id"
)
```

**When to use:**
- **Recommended for regular syncs**: Use `sync_combined` for your regular synchronization workflow to keep Linear in sync with GitHub
- **Individual tools**: Use `sync_pr_based_status` or `sync_linear_status` individually if you only need one type of sync

**Configuration Options:**
- Same as `sync_pr_based_status` (see above)
- `force`: If true, re-checks all issues including those already marked as "done" (only affects Step 2)

## Using from Another Repository

You can configure UNMute to be available when working in another repository (like Better Auth).

### Setup

Add to `cursor-mcp-config.json` (or `~/.cursor/mcp.json`) in your repository:

```json
{
  "mcpServers": {
    "UnMute": {
      "command": "/absolute/path/to/discord-mcp/run-mcp.sh",
      "env": {
        "DISCORD_TOKEN": "your_discord_bot_token",
        "GITHUB_TOKEN": "your_github_token",
        "GITHUB_OWNER": "your-org",
        "GITHUB_REPO": "your-repo",
        "OPENAI_API_KEY": "your_openai_key",
        "DATABASE_URL": "postgresql://user:password@localhost:5432/unmute_mcp",
        "DOCUMENTATION_URLS": "https://your-docs.com/docs",
        "PM_TOOL_TYPE": "linear",
        "PM_TOOL_API_KEY": "your_linear_api_key",
        "PM_TOOL_TEAM_ID": "your_linear_team_id"
      }
    }
  }
}
```

**Required variables** (minimum):
- `DISCORD_TOKEN` - Discord bot token
- `GITHUB_OWNER` - GitHub org/username
- `GITHUB_REPO` - GitHub repository name

**Recommended variables**:
- `GITHUB_TOKEN` or GitHub App credentials - For higher rate limits
- `OPENAI_API_KEY` - For semantic classification
- `DATABASE_URL` - For production use (PostgreSQL)

See `env.example` for all available variables.

## Project Structure

```
unmute-mcp/
├── src/
│   ├── mcp/               # MCP server and tool handlers
│   ├── connectors/        # External service connectors (GitHub, Discord)
│   ├── core/              # Core business logic (classify, correlate)
│   ├── storage/           # Data persistence (cache, db, json)
│   ├── export/            # PM tool export system (Linear, Jira)
│   ├── sync/              # Status synchronization
│   ├── types/             # Type definitions
│   └── config/            # Configuration
├── scripts/               # CLI utilities
├── docs/                  # Documentation
├── cache/                 # Cached data (gitignored)
├── results/               # Output files (gitignored)
├── prisma/                # Database schema and migrations
└── dist/                  # Compiled output
```

## Documentation

See the `docs/` folder for detailed documentation:

- `GITHUB_INTEGRATION.md`: GitHub authentication setup (Token or GitHub App)
- `DATABASE_SETUP.md`: PostgreSQL database setup
- `LINEAR_GITHUB_CONTRACT.md`: How UNMute integrates with Linear's GitHub integration
- `LINEAR_TEAM_SETUP.md`: Setting up Linear teams and projects
- `CSV_SETUP.md`: Organization members CSV setup for PR-based sync user mappings
- `explain-permissions.md`: Discord bot permissions setup

## License

MIT License - see [LICENSE](LICENSE) for details.
