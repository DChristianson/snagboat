---
description: Show Snagboat in Claude Code's status line (asks before changing your settings)
---
Snagboat can show its findings count and today's tokens in Claude Code's status line. A plugin can't set the status line itself; it goes in your user settings, `~/.claude/settings.json`.

Do this:
1. Read `~/.claude/settings.json` (it may not exist). If it already has a `statusLine`, show it to me and ask whether to replace it; stop if I say no.
2. Show me exactly this change and ask before writing it:
   ```json
   "statusLine": { "type": "command", "command": "sh \"$HOME/.snagboat/bin/snagboat\" statusline 2>/dev/null", "padding": 0 }
   ```
   `~/.snagboat/bin/snagboat` is kept pointing at the current version of this plugin each time a session starts; until the first session has written it, the line is just empty.
3. If I agree, add it, keeping every other setting as it is, and tell me it shows from the next message on.
