-- Lazy code indexing tables
-- Only index code when searched/needed, at function/class level granularity

-- Code searches (tracks what was searched)
CREATE TABLE IF NOT EXISTS "code_searches" (
    "id" TEXT NOT NULL,
    "search_query" TEXT NOT NULL,
    "repository_url" TEXT NOT NULL,
    "search_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_searches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "code_searches_search_query_repository_url_key" 
ON "code_searches"("search_query", "repository_url");

CREATE INDEX IF NOT EXISTS "code_searches_repository_url_idx" 
ON "code_searches"("repository_url");

CREATE INDEX IF NOT EXISTS "code_searches_created_at_idx" 
ON "code_searches"("created_at" DESC);

-- Code files (files found in searches)
CREATE TABLE IF NOT EXISTS "code_files" (
    "id" TEXT NOT NULL,
    "code_search_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_content" TEXT NOT NULL,
    "language" TEXT,
    "content_hash" TEXT NOT NULL,
    "last_indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "code_files_code_search_id_file_path_key" 
ON "code_files"("code_search_id", "file_path");

CREATE INDEX IF NOT EXISTS "code_files_code_search_id_idx" 
ON "code_files"("code_search_id");

CREATE INDEX IF NOT EXISTS "code_files_file_path_idx" 
ON "code_files"("file_path");

CREATE INDEX IF NOT EXISTS "code_files_content_hash_idx" 
ON "code_files"("content_hash");

CREATE INDEX IF NOT EXISTS "code_files_last_indexed_at_idx" 
ON "code_files"("last_indexed_at");

ALTER TABLE "code_files" 
ADD CONSTRAINT "code_files_code_search_id_fkey" 
FOREIGN KEY ("code_search_id") REFERENCES "code_searches"("id") 
ON DELETE CASCADE ON UPDATE CASCADE;

-- Code sections (function/class level granularity)
CREATE TABLE IF NOT EXISTS "code_sections" (
    "id" TEXT NOT NULL,
    "code_file_id" TEXT NOT NULL,
    "section_type" TEXT NOT NULL,
    "section_name" TEXT NOT NULL,
    "section_content" TEXT NOT NULL,
    "start_line" INTEGER,
    "end_line" INTEGER,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_sections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "code_sections_code_file_id_idx" 
ON "code_sections"("code_file_id");

CREATE INDEX IF NOT EXISTS "code_sections_section_type_idx" 
ON "code_sections"("section_type");

CREATE INDEX IF NOT EXISTS "code_sections_section_name_idx" 
ON "code_sections"("section_name");

CREATE INDEX IF NOT EXISTS "code_sections_content_hash_idx" 
ON "code_sections"("content_hash");

ALTER TABLE "code_sections" 
ADD CONSTRAINT "code_sections_code_file_id_fkey" 
FOREIGN KEY ("code_file_id") REFERENCES "code_files"("id") 
ON DELETE CASCADE ON UPDATE CASCADE;

-- Code file embeddings
CREATE TABLE IF NOT EXISTS "code_file_embeddings" (
    "code_file_id" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_file_embeddings_pkey" PRIMARY KEY ("code_file_id")
);

CREATE INDEX IF NOT EXISTS "code_file_embeddings_content_hash_idx" 
ON "code_file_embeddings"("content_hash");

CREATE INDEX IF NOT EXISTS "code_file_embeddings_model_idx" 
ON "code_file_embeddings"("model");

ALTER TABLE "code_file_embeddings" 
ADD CONSTRAINT "code_file_embeddings_code_file_id_fkey" 
FOREIGN KEY ("code_file_id") REFERENCES "code_files"("id") 
ON DELETE CASCADE ON UPDATE CASCADE;

-- Code section embeddings
CREATE TABLE IF NOT EXISTS "code_section_embeddings" (
    "code_section_id" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_section_embeddings_pkey" PRIMARY KEY ("code_section_id")
);

CREATE INDEX IF NOT EXISTS "code_section_embeddings_content_hash_idx" 
ON "code_section_embeddings"("content_hash");

CREATE INDEX IF NOT EXISTS "code_section_embeddings_model_idx" 
ON "code_section_embeddings"("model");

ALTER TABLE "code_section_embeddings" 
ADD CONSTRAINT "code_section_embeddings_code_section_id_fkey" 
FOREIGN KEY ("code_section_id") REFERENCES "code_sections"("id") 
ON DELETE CASCADE ON UPDATE CASCADE;

-- Feature to code section mappings
CREATE TABLE IF NOT EXISTS "feature_code_mappings" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "code_section_id" TEXT NOT NULL,
    "similarity" DECIMAL(5,4) NOT NULL,
    "match_type" TEXT NOT NULL,
    "search_query" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_code_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "feature_code_mappings_feature_id_code_section_id_key" 
ON "feature_code_mappings"("feature_id", "code_section_id");

CREATE INDEX IF NOT EXISTS "feature_code_mappings_feature_id_idx" 
ON "feature_code_mappings"("feature_id");

CREATE INDEX IF NOT EXISTS "feature_code_mappings_code_section_id_idx" 
ON "feature_code_mappings"("code_section_id");

CREATE INDEX IF NOT EXISTS "feature_code_mappings_similarity_idx" 
ON "feature_code_mappings"("similarity" DESC);

CREATE INDEX IF NOT EXISTS "feature_code_mappings_match_type_idx" 
ON "feature_code_mappings"("match_type");

ALTER TABLE "feature_code_mappings" 
ADD CONSTRAINT "feature_code_mappings_feature_id_fkey" 
FOREIGN KEY ("feature_id") REFERENCES "features"("id") 
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "feature_code_mappings" 
ADD CONSTRAINT "feature_code_mappings_code_section_id_fkey" 
FOREIGN KEY ("code_section_id") REFERENCES "code_sections"("id") 
ON DELETE CASCADE ON UPDATE CASCADE;

