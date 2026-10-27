# Changelog

## 0.0.2

**Text capture is now on by default.** Snagboat stores your prompts (up to 2,000 characters), agent reply excerpts (up to 500), and session names, so the Sessions tab can show what you asked and `verbal-hedge` has replies to read. If you installed 0.0.1 and never changed `snagboat.captureContent`, capture starts with this version. Common secret formats are redacted before anything is stored, prompts and replies are kept for 30 days (`snagboat.retention.textDays`), and **Snagboat: Remove Captured Text** deletes what's stored and can turn capture off. Nothing leaves your machine. See [PRIVACY.md](https://github.com/DChristianson/snagboat/blob/main/PRIVACY.md#captured-text).

- **Session names** in the session list, breadcrumb, and Overview: Claude Code's generated title, or Copilot's session name.
- **Copilot Agent reply excerpts**, so `verbal-hedge` works for Copilot agent sessions too.
- **Workspace folders added to an open window** get Claude Code hooks right away, without a reload.
- **Snagboat: Remove Claude Code Hooks from Project...** removes Snagboat's entries from a folder's `.claude/settings.json` and stops adding them there (`snagboat.claudeCode.configureHooks`, new, on by default).
- **Fix:** a Copilot agent session could show as a Claude Code session, with its tool calls counted twice: Copilot runs the hooks in `.claude/settings.json`, Snagboat's included. Those hooks are now ignored for Copilot sessions, and **Snagboat: Backfill Sessions from Transcripts...** removes ones already logged.
- **Faster startup:** the event log is read once on activation instead of about four times.
- **Housekeeping:** checkpoint entries for transcripts and session logs that have since been deleted are dropped.

## 0.0.1

First release.
