/**
 * Helpers for storing and querying pgvector columns.
 *
 * Prisma maps the Postgres `vector` and `halfvec` types as `Unsupported`, so
 * vector columns can't be read or written through the generated client — they
 * must go through raw SQL. This module centralises the (small) set of
 * primitives every raw vector query needs so the SQL surface stays auditable
 * in one place.
 *
 * All embedding columns in the schema are `halfvec(1024)` (see migration
 * 20260603100000_embeddings_ollama_1024). halfvec is pgvector's 16-bit
 * half-precision float vector type — half the storage of `vector`, and the
 * only one HNSW can index above 2000 dimensions. 1024 is the native output
 * dimension of `mxbai-embed-large` (the default Ollama model) and several
 * other strong retrieval models, so swapping models stays cheap.
 */

/**
 * Embedding dimension. mxbai-embed-large (default Ollama model) emits 1024
 * dims. If you switch to a model with a different dimensionality, change
 * EMBEDDING_DIM here, write a new halfvec(N) migration, and run
 * `npm run reembed:all` — vectors from a different model live in a different
 * vector space and can't be mixed.
 */
export const EMBEDDING_DIM = 1024;

/**
 * Render a JS embedding as a pgvector literal: `[v1,v2,...]`.
 *
 * Bind the result as a normal string parameter and cast it in SQL, e.g.
 *   prisma.$executeRaw`... = ${toSqlVector(vec)}::halfvec ...`
 * so the value still travels as a bound parameter (no SQL injection) while
 * Postgres performs the text→halfvec coercion.
 *
 * The literal format is the same for `vector` and `halfvec`; the destination
 * column type and the explicit `::halfvec` cast determine which type is
 * stored. We keep the function name `toSqlVector` because it's the generic
 * "render a vector literal" helper, not because the column type is `vector`.
 */
export function toSqlVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
