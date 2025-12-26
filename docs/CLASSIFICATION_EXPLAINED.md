# Message Classification

Analyzes Discord messages and matches them with GitHub issues using keyword-based or semantic similarity.

## Process

The `classify_discord_messages` tool automatically:
1. **Syncs GitHub Issues**: Fetches all issues from the repository and caches them (incremental updates)
2. **Syncs Discord Messages**: Fetches messages from the channel and caches them (incremental updates)
3. **Classification**: 
   - Compares each message against all cached GitHub issues
   - Uses keyword-based matching (default) or semantic matching (if OpenAI API key is configured)
   - Calculates similarity score (0-100%) 
   - Filters issues with similarity ≥ threshold (default: 20%)
   - Returns top 5 matches per message

## Important Notes

- Issues are cached locally, so classification compares against all issues at once
- Messages are cached locally, so classification can process large batches efficiently
- Classification method: Keyword-based (default) or Semantic (if `OPENAI_API_KEY` is set)
- Semantic classification is enabled by default when OpenAI API key is configured

## Performance

- Issues are fetched once and cached (incremental updates on subsequent runs)
- Messages are fetched once and cached (incremental updates on subsequent runs)
- Classification compares all messages against all cached issues (no API calls during classification)
- Much faster than API-based search since everything is local

## Similarity Threshold

- Default: 20%
- Lower = more matches (less accurate)
- Higher = fewer matches (more relevant)
- Adjust via `min_similarity` parameter

## Example

**Message:** "I'm having trouble with stripe plugin subscription webhooks"

**Process:**
1. Issues are cached locally (e.g., 5000 issues from the repository)
2. Keywords: ["trouble", "stripe", "plugin", "subscription", "webhooks"]
3. Compares against all cached issues (no API calls needed)
4. Finds issue #5535: "Stripe - cancel at the period end not working"
5. Similarity: 45% (matched: "stripe", "plugin", "subscription")
6. Included in results if > 20% threshold

## Classification Methods

### Keyword-Based (Default)
- Fast and free
- Compares keywords and phrases extracted from messages and issues
- Weighted scoring system prioritizes technical terms
- Works offline after initial cache

### Semantic (LLM-Based)
- Enabled automatically when `OPENAI_API_KEY` is set
- Uses OpenAI embeddings for context-aware matching
- Better understanding of synonyms and related concepts
- See SEMANTIC_CLASSIFICATION.md for details

## Improving Results

- Lower similarity threshold (e.g., 15% instead of 20%)
- Enable semantic classification by setting `OPENAI_API_KEY`
- Process more messages using `classify_all` parameter
- Ensure issues and messages are up-to-date (classification auto-syncs)
