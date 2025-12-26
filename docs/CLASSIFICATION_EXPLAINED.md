# Message Classification

Analyzes Discord messages and matches them with GitHub issues using keyword-based similarity.

## Process

1. **Fetch Messages**: Reads N messages (default: 30) from the specified channel
2. **For Each Message**:
   - Extract keywords (removes stop words, keeps meaningful terms)
   - Search GitHub API using top 5 keywords
   - Calculate similarity score (0-100%) based on keyword overlap
   - Filter issues with similarity ≥ threshold (default: 20%)
   - Return top 5 matches per message

## Important Notes

- Does not compare against all GitHub issues at once
- Searches GitHub API using message keywords
- GitHub API returns up to 20 results per search
- Only issues matching keywords and above similarity threshold are returned

## Performance

- One GitHub API call per message
- Rate limit: 60 requests/hour (without token) or 5000/hour (with token)
- Includes 500ms delay between searches

## Similarity Threshold

- Default: 20%
- Lower = more matches (less accurate)
- Higher = fewer matches (more relevant)
- Adjust via `min_similarity` parameter

## Example

**Message:** "I'm having trouble with stripe plugin subscription webhooks"

**Process:**
1. Keywords: ["trouble", "stripe", "plugin", "subscription", "webhooks"]
2. GitHub search: `repo:{owner}/{repo} stripe plugin subscription webhooks type:issue`
3. Finds issue #5535: "Stripe - cancel at the period end not working"
4. Similarity: 45% (matched: "stripe", "plugin", "subscription")
5. Included in results if > 20% threshold

## Limitations

- Keyword-based only (not semantic)
- Max 20 results per GitHub API search
- One search per message (may miss related issues if keywords don't match)
- Rate limiting may require GitHub token for large batches

## Improving Results

- Lower similarity threshold (e.g., 15% instead of 20%)
- Use GitHub token for higher rate limits
- Process in smaller batches
- Use semantic classification (see SEMANTIC_CLASSIFICATION.md)
