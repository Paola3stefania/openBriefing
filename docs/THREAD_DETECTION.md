# Thread Detection

Discord thread detection and handling when fetching messages.

## Detection

Messages are detected as part of a thread by checking the `msg.thread` property provided by Discord.js:
- If `msg.thread` exists → message is in a thread
- If `msg.thread` is null/undefined → message is standalone

## Organization

Messages are organized by `organizeMessagesByThread`:
- Messages with `thread` property → `threads[threadId].messages[]`
- Messages without `thread` → `main_messages[]`

## Standalone to Thread Migration

When a standalone message becomes part of a thread:

1. **Cache Update**: Messages are updated by ID using a Map
   - When a message is fetched again with `thread` property, it overwrites the old entry
   - `organizeMessagesByThread` moves it from `main_messages` to `threads[threadId].messages`

2. **Classification History Migration**: `migrateStandaloneToThread` detects and migrates:
   - Old: `history.threads[messageId]` (standalone)
   - New: `history.threads[threadId]` (real thread)

## Code Flow

```
Fetch Messages → Discord.js provides msg.thread → Format message → Merge cache → organizeMessagesByThread() → migrateStandaloneToThread() (if needed)
```

## Important Notes

- Message ID never changes (even when it becomes part of a thread)
- Thread ID is separate from message ID
- Discord.js handles detection automatically
- Cache is updated incrementally by message ID
