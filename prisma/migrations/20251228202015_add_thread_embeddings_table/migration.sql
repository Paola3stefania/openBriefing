-- CreateTable
CREATE TABLE IF NOT EXISTS "thread_embeddings" (
    "thread_id" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_embeddings_pkey" PRIMARY KEY ("thread_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thread_embeddings_content_hash_idx" ON "thread_embeddings"("content_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "thread_embeddings_model_idx" ON "thread_embeddings"("model");

-- AddForeignKey (only if constraint doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'thread_embeddings_thread_id_fkey'
    ) THEN
        ALTER TABLE "thread_embeddings" ADD CONSTRAINT "thread_embeddings_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "classified_threads"("thread_id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- CreateTrigger (only if trigger doesn't exist)
DROP TRIGGER IF EXISTS update_thread_embeddings_updated_at ON "thread_embeddings";
CREATE TRIGGER update_thread_embeddings_updated_at BEFORE UPDATE ON "thread_embeddings"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add comments
COMMENT ON TABLE "thread_embeddings" IS 'Stores embeddings for Discord threads to enable fast semantic similarity calculations';
COMMENT ON COLUMN "thread_embeddings"."embedding" IS 'Array of floats (1536 dimensions) representing the thread content embedding';
COMMENT ON COLUMN "thread_embeddings"."content_hash" IS 'MD5 hash of thread content to detect changes and invalidate stale embeddings';
COMMENT ON COLUMN "thread_embeddings"."model" IS 'OpenAI embedding model used (e.g., text-embedding-3-small)';

