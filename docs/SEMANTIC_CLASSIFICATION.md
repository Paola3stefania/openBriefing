# Semantic Classification

LLM-based semantic similarity matching using OpenAI embeddings for better context understanding compared to keyword-based matching.

## How It Works

1. Converts text to embeddings using OpenAI's `text-embedding-3-small` model
2. Calculates cosine similarity between message and issue embeddings
3. Understands context and synonyms (e.g., "authentication problem" matches "sign-in issue")

## Configuration

### Enable

1. Add to `.env`:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   ```
2. Semantic classification is automatically enabled when `OPENAI_API_KEY` is set
3. To disable even with API key:
   ```
   USE_SEMANTIC_CLASSIFICATION=false
   ```

### Cost

- Model: `text-embedding-3-small`
- Pricing: ~$0.02 per 1M tokens
- Embeddings are cached during classification
- Processed in batches with delays to respect rate limits (5000 requests/minute)

## Usage

The `classify_discord_messages` tool automatically uses semantic classification if `OPENAI_API_KEY` is configured. No code changes needed.

## Comparison

**Keyword-Based:**
- Fast and free
- Requires exact or similar keyword matches
- Limited synonym understanding
- Good for exact technical term matching

**Semantic (LLM-Based):**
- More accurate for complex discussions
- Understands context and relationships
- Requires OpenAI API key (costs apply)
- Better for nuanced technical conversations

## Fallback

If `OPENAI_API_KEY` is not set or semantic classification fails, the system automatically falls back to keyword-based classification.

## Similarity Scores

0-100 scale:
- 0-20: Weak match
- 20-40: Moderate match
- 40-60: Good match
- 60-80: Strong match
- 80-100: Very strong match

The `min_similarity` parameter filters results by this score (default: 20).
