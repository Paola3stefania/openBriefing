-- CreateTable
CREATE TABLE "issue_thread_matches" (
    "id" SERIAL NOT NULL,
    "issue_number" INTEGER NOT NULL,
    "thread_id" TEXT NOT NULL,
    "thread_name" TEXT,
    "thread_url" TEXT,
    "similarity_score" DECIMAL(5,2) NOT NULL,
    "match_method" TEXT NOT NULL DEFAULT 'embedding',
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "first_message_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_thread_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issue_thread_matches_issue_number_idx" ON "issue_thread_matches"("issue_number");

-- CreateIndex
CREATE INDEX "issue_thread_matches_thread_id_idx" ON "issue_thread_matches"("thread_id");

-- CreateIndex
CREATE INDEX "issue_thread_matches_similarity_score_idx" ON "issue_thread_matches"("similarity_score" DESC);

-- CreateIndex
CREATE INDEX "issue_thread_matches_match_method_idx" ON "issue_thread_matches"("match_method");

-- CreateIndex
CREATE UNIQUE INDEX "issue_thread_matches_issue_number_thread_id_key" ON "issue_thread_matches"("issue_number", "thread_id");

-- AddForeignKey
ALTER TABLE "issue_thread_matches" ADD CONSTRAINT "issue_thread_matches_issue_number_fkey" FOREIGN KEY ("issue_number") REFERENCES "github_issues"("issue_number") ON DELETE CASCADE ON UPDATE CASCADE;


