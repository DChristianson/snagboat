---
description: Review an advisor's period report and its proposed rule changes
argument-hint: "[advisor]"
allowed-tools: mcp__plugin_snagboat_snagboat__snagboat_proposals
---
Call the `mcp__plugin_snagboat_snagboat__snagboat_proposals` tool, with `advisor` set to $ARGUMENTS if I gave one (otherwise leave it out, and if only one advisor has a report waiting for marks, call it again for that advisor). Show the report briefly: where the goal stands, any experiment verdicts, then each proposal with its id, what it changes and where, why, and its prediction. Keep Snagboat's numbers exactly as given.

Then ask me how to mark each proposal: accept, discard, or revise with a note. Mark only what I tell you, with `mcp__plugin_snagboat_snagboat__snagboat_mark_proposal`, and send the report back with `mcp__plugin_snagboat_snagboat__snagboat_send_report` only when I say to send. Accepting a report changes Snagboat's settings, so don't send on your own judgment.
