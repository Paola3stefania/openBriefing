-- CreateTable
CREATE TABLE IF NOT EXISTS "discord_messages" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_username" TEXT,
    "author_discriminator" TEXT,
    "author_bot" BOOLEAN NOT NULL DEFAULT false,
    "author_avatar" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "edited_at" TIMESTAMP(3),
    "timestamp" TEXT NOT NULL,
    "channel_name" TEXT,
    "guild_id" TEXT,
    "guild_name" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "embeds" INTEGER NOT NULL DEFAULT 0,
    "mentions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "reactions" JSONB NOT NULL DEFAULT '[]',
    "thread_id" TEXT,
    "thread_name" TEXT,
    "message_reference" JSONB,
    "url" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discord_messages_channel_id_idx" ON "discord_messages"("channel_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discord_messages_author_id_idx" ON "discord_messages"("author_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discord_messages_created_at_idx" ON "discord_messages"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discord_messages_thread_id_idx" ON "discord_messages"("thread_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discord_messages_guild_id_idx" ON "discord_messages"("guild_id");

-- AddForeignKey (only if constraint doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'discord_messages_channel_id_fkey'
    ) THEN
        ALTER TABLE "discord_messages" ADD CONSTRAINT "discord_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- CreateTrigger (only if trigger doesn't exist)
DROP TRIGGER IF EXISTS update_discord_messages_updated_at ON "discord_messages";
CREATE TRIGGER update_discord_messages_updated_at BEFORE UPDATE ON "discord_messages"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add comments
COMMENT ON TABLE "discord_messages" IS 'Stores Discord messages fetched from channels';
COMMENT ON COLUMN "discord_messages"."content" IS 'Message text content';
COMMENT ON COLUMN "discord_messages"."attachments" IS 'Array of attachment objects with id, filename, url, size, content_type';
COMMENT ON COLUMN "discord_messages"."reactions" IS 'Array of reaction objects with emoji and count';
COMMENT ON COLUMN "discord_messages"."message_reference" IS 'Reference to another message (reply) with message_id, channel_id, guild_id';

