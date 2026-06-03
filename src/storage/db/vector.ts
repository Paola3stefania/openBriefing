/**
 * Helpers for storing and querying pgvector columns.
 *
 * Prisma maps the Postgres `vector` type as `Unsupported`, so vector columns
 * can't be read or written through the generated client — they must go through
 * raw SQL. This module centralises the (small) set of primitives every raw
 * vector query needs so the SQL surface stays auditable in one place.
 *
 * Currently used by the agent-memory "brain" (memory_entry_embeddings). When
 * the classification embedding tables (issues/threads/groups/docs/code/
 * features) are migrated off JSONB they should reuse these helpers too.
 */

/**
 * Embedding dimension. text-embedding-3-small / ada-002 both emit 1536 dims.
 * If you switch to a model with a different dimensionality, the migration that
 * defines the `vector(N)` columns must change to match.
 */
export const EMBEDDING_DIM = 1536;

/**
 * Render a JS embedding as a pgvector literal: `[v1,v2,...]`.
 *
 * Bind the result as a normal string parameter and cast it in SQL, e.g.
 *   prisma.$executeRaw`... = ${toSqlVector(vec)}::vector ...`
 * so the value still travels as a bound parameter (no SQL injection) while
 * Postgres performs the text→vector coercion.
 */
export function toSqlVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
