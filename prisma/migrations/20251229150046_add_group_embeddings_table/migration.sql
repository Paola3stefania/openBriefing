-- CreateTable
CREATE TABLE IF NOT EXISTS "group_embeddings" (
    "group_id" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_embeddings_pkey" PRIMARY KEY ("group_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "group_embeddings_content_hash_idx" ON "group_embeddings"("content_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "group_embeddings_model_idx" ON "group_embeddings"("model");

-- AddForeignKey (only if constraint doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'group_embeddings_group_id_fkey'
    ) THEN
        ALTER TABLE "group_embeddings" ADD CONSTRAINT "group_embeddings_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- CreateTrigger (only if trigger doesn't exist)
DROP TRIGGER IF EXISTS update_group_embeddings_updated_at ON "group_embeddings";
CREATE TRIGGER update_group_embeddings_updated_at BEFORE UPDATE ON "group_embeddings"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add comments
COMMENT ON TABLE "group_embeddings" IS 'Stores embeddings for groups to enable fast semantic similarity calculations for feature matching';
COMMENT ON COLUMN "group_embeddings"."embedding" IS 'Array of floats (1536 dimensions) representing the group content embedding (includes title, issue, threads, and code context)';
COMMENT ON COLUMN "group_embeddings"."content_hash" IS 'MD5 hash of group content to detect changes and invalidate stale embeddings';
COMMENT ON COLUMN "group_embeddings"."model" IS 'OpenAI embedding model used (e.g., text-embedding-3-small)';


