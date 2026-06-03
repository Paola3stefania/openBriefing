# Connect OpenBriefing to Claude Desktop (plain-English guide)

This guide is for someone who is **not technical**. You will copy and paste a few
things, click a few buttons, and restart an app. That's it. Take it one step at a
time — you don't need to understand what each command does.

> **What you're setting up:** OpenBriefing gives Claude a memory of your project
> (past decisions, issues, notes). After this, when you chat in Claude Desktop,
> Claude can look things up and remember what happened before.

If you ever get stuck, jump to **"If something goes wrong"** at the bottom.

---

## Before you start, you need three things

You only do this part **once**.

### 1. Install Node (the engine that runs OpenBriefing)

1. Open the app called **Terminal** (press `Cmd + Space`, type `Terminal`, press Enter).
2. Copy this line, paste it into Terminal, press Enter:

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

   This installs "Homebrew", a helper that installs other programs. It may ask for
   your Mac password (typing won't show dots — that's normal) and take a few minutes.
3. When it finishes, copy/paste this and press Enter:

   ```bash
   brew install node
   ```

### 2. Install Ollama (this is the "brain" that runs on your computer, for free)

1. Copy/paste into Terminal, press Enter:

   ```bash
   brew install --cask ollama-app
   ```
2. Then start it and download the two models it needs (copy/paste each line, press
   Enter, wait for each to finish — the downloads are a few hundred MB):

   ```bash
   open -a Ollama
   ollama pull mxbai-embed-large
   ollama pull qwen2.5:14b
   ```

   > Leave Ollama running. It lives in your Mac's top menu bar. If your computer
   > restarts, open it again (`Cmd + Space`, type `Ollama`, press Enter).

### 3. Get the OpenBriefing project onto your computer

If someone already set this up for you and the folder
`openBriefing` exists in your home folder, **skip this step**.

Otherwise, copy/paste into Terminal, one line at a time:

```bash
cd ~
git clone https://github.com/Paola3stefania/openBriefing.git
cd openBriefing
npm install
npm run build
cp run-mcp.sh.example run-mcp.sh && chmod +x run-mcp.sh
```

> That last line creates the small "launcher" file Claude Desktop needs. It does
> **not** come with the download, so don't skip it — without it Claude will say
> "Failed to spawn process".

---

## Set up your secrets file (one time)

OpenBriefing needs a few keys (like passwords) to read your GitHub, etc. These live
in a file named `.env` inside the project folder.

1. In Terminal, copy/paste and press Enter:

   ```bash
   cd ~/openBriefing
   cp env.example .env
   open -e .env
   ```
2. A text editor opens. Fill in the values your team gave you (GitHub token,
   database URL, etc.). If you don't have a value, leave that line as it is.
3. **If you're using the database on your own computer** (not a shared cloud one),
   make sure these lines are present (your team will tell you if so):

   ```bash
   OFFLINE_DB=true
   ```

   Without this line, OpenBriefing will try to use a cloud database instead of the
   one on your Mac. If your team set you up with a cloud database, leave it out.
4. Save and close the editor (`Cmd + S`, then `Cmd + W`).

> If your team gave you these settings already filled in, you can skip this section.

---

## Tell Claude Desktop about OpenBriefing

This is the key step.

1. Make sure **Claude Desktop** is installed (download from
   [claude.ai/download](https://claude.ai/download) if not).
2. Open the settings file. Copy/paste into Terminal and press Enter:

   ```bash
   open -e "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
   ```

   - If it says the file doesn't exist, create it first by copy/pasting this, then
     run the line above again:

     ```bash
     mkdir -p "$HOME/Library/Application Support/Claude" && touch "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
     ```
3. A text editor opens (it may be empty). **Select all** (`Cmd + A`), delete, then
   paste this in exactly:

   ```json
   {
     "mcpServers": {
       "OpenBriefing": {
         "command": "/Users/YOUR_USERNAME/openBriefing/run-mcp.sh"
       }
     }
   }
   ```
4. Replace `YOUR_USERNAME` with your Mac username. To find it, run this in Terminal
   and use what it prints:

   ```bash
   whoami
   ```

   For example, if it prints `paola3stefania`, the line becomes:
   `"command": "/Users/paola3stefania/openBriefing/run-mcp.sh"`
5. Save and close (`Cmd + S`, then `Cmd + W`).

---

## Turn it on

1. **Fully quit** Claude Desktop: with Claude open, press `Cmd + Q` (just closing
   the window is not enough).
2. Open Claude Desktop again.
3. In a new chat, look for a tools / plug icon (🔌) near the message box. You should
   see **OpenBriefing** listed.
4. Test it — type:

   > "Use OpenBriefing to give me a briefing on this project."

   If Claude asks permission to use a tool, click **Allow**.

That's it — you're done. 🎉

---

## If something goes wrong

**I don't see OpenBriefing in Claude.**
- Did you fully quit Claude with `Cmd + Q` and reopen it? Try once more.
- Re-check the file from the "Tell Claude Desktop" step — the username must be
  correct and the text must match exactly (it's easy to delete a `{` or `"`).

**It says "Failed to spawn process: No such file or directory".**
- The launcher file is missing. Recreate it — copy/paste into Terminal:

  ```bash
  cd ~/openBriefing && npm run setup:launcher
  ```

  Then fully quit Claude (`Cmd + Q`) and reopen.

**It shows an error or "failed to start".**
- Make sure you ran `npm run build` (in the "Get the project" step).
- Make sure **Ollama is running** (look for it in the top menu bar; if missing,
  `Cmd + Space` → type `Ollama` → Enter).
- Run these two lines in Terminal to rebuild, then restart Claude:

  ```bash
  cd ~/openBriefing && git pull && npm install && npm run build
  ```

**Claude answers but says it has no project data.**
- Your `.env` may be missing the database/GitHub settings. Reopen it with
  `open -e ~/openBriefing/.env` and fill in the values from your team.

**Still stuck?** Send your technical contact the output of this command (it collects
helpful info, no passwords):

```bash
echo "node: $(node -v 2>&1); ollama: $(command -v ollama || echo missing); built: $([ -f ~/openBriefing/dist/index.js ] && echo yes || echo no)"
```
