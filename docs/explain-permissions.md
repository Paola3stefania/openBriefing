# Discord Bot Permissions

Required Discord bot permissions for the MCP server to function.

## Required Permissions

- **Read Message History**: To fetch messages from channels
- **View Channels**: To access channel content
- **Send Messages**: Optional, for notifications (not currently used)

## Setup

1. Go to Discord Developer Portal: https://discord.com/developers/applications
2. Create or select your bot application
3. Go to "Bot" section
4. Under "Privileged Gateway Intents", enable:
   - **MESSAGE CONTENT INTENT** (Required)
5. Copy the bot token
6. Invite bot to your server with the required permissions

## OAuth2 URL Generator

Use the OAuth2 URL Generator in the Developer Portal to create an invite link with the correct permissions:

**Required Scopes:**
- `bot`

**Required Bot Permissions:**
- Read Message History
- View Channels

## Notes

- Message Content Intent must be enabled for the bot to read message content
- Bot must be in the server/channel you want to access
- Bot cannot access messages sent before it was added to the channel
