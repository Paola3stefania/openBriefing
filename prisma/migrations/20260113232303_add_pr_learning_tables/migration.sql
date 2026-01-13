-- CreateTable
CREATE TABLE "fix_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "issue_number" INTEGER NOT NULL,
    "issue_repo" TEXT NOT NULL,
    "issue_title" TEXT NOT NULL,
    "triage_result" TEXT NOT NULL,
    "triage_confidence" DECIMAL(3,2) NOT NULL,
    "triage_reasoning" TEXT,
    "fix_attempted" BOOLEAN NOT NULL DEFAULT false,
    "fix_succeeded" BOOLEAN,
    "pr_number" INTEGER,
    "pr_url" TEXT,
    "pr_title" TEXT,
    "branch_name" TEXT,
    "files_changed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "no_fix_reason" TEXT,
    "linear_issue_id" TEXT,
    "linear_comment_id" TEXT,
    "linear_updated" BOOLEAN NOT NULL DEFAULT false,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fix_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_learnings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "issue_number" INTEGER NOT NULL,
    "issue_repo" TEXT NOT NULL,
    "issue_title" TEXT NOT NULL,
    "issue_body" TEXT,
    "issue_labels" TEXT[],
    "issue_state" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "pr_title" TEXT NOT NULL,
    "pr_body" TEXT,
    "pr_diff" TEXT NOT NULL,
    "pr_files_changed" TEXT[],
    "pr_lines_added" INTEGER NOT NULL,
    "pr_lines_removed" INTEGER NOT NULL,
    "pr_merged_at" TIMESTAMP(3),
    "pr_author" TEXT NOT NULL,
    "issue_type" TEXT NOT NULL,
    "subsystem" TEXT,
    "fix_patterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "review_comments" JSONB NOT NULL DEFAULT '[]',
    "review_outcome" TEXT,
    "embedding" JSONB,
    "content_hash" TEXT NOT NULL,
    "learned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_learnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fix_attempts_issue_number_issue_repo_key" ON "fix_attempts"("issue_number", "issue_repo");

-- CreateIndex
CREATE INDEX "fix_attempts_triage_result_idx" ON "fix_attempts"("triage_result");

-- CreateIndex
CREATE INDEX "fix_attempts_fix_succeeded_idx" ON "fix_attempts"("fix_succeeded");

-- CreateIndex
CREATE INDEX "fix_attempts_attempted_at_idx" ON "fix_attempts"("attempted_at" DESC);

-- CreateIndex
CREATE INDEX "fix_attempts_issue_repo_idx" ON "fix_attempts"("issue_repo");

-- CreateIndex
CREATE UNIQUE INDEX "pr_learnings_issue_number_pr_number_issue_repo_key" ON "pr_learnings"("issue_number", "pr_number", "issue_repo");

-- CreateIndex
CREATE INDEX "pr_learnings_issue_repo_idx" ON "pr_learnings"("issue_repo");

-- CreateIndex
CREATE INDEX "pr_learnings_issue_type_idx" ON "pr_learnings"("issue_type");

-- CreateIndex
CREATE INDEX "pr_learnings_subsystem_idx" ON "pr_learnings"("subsystem");

-- CreateIndex
CREATE INDEX "pr_learnings_fix_patterns_idx" ON "pr_learnings" USING GIN ("fix_patterns");

-- CreateIndex
CREATE INDEX "pr_learnings_pr_merged_at_idx" ON "pr_learnings"("pr_merged_at" DESC);
