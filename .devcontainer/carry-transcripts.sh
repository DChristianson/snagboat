#!/usr/bin/env bash
# Carries Claude Code's transcripts (and its per-project memory, which lives
# beside them) over to the transcript folder this container now keeps in the
# project: .snagboat/claude-projects/, mounted at ~/.claude/projects.
#
#   save   Run once in the container's terminal (never on the host), in a container from before that mount, just before you
#          rebuild: copies ~/.claude/projects (in the Docker volume, which the
#          new mount hides) into .snagboat/claude-projects/. Copies; never
#          deletes, and replaces a file only with a newer copy, so it can be
#          run again as the last thing before the rebuild.
#   start  Runs on every container start (postStartCommand): when the project
#          used to be at /workspaces/<name>, moves that transcript folder to the
#          name Claude Code uses for the project's new path, so `claude
#          --resume` and its memory find it. Does nothing once done.
#
# Run from the project folder. Never fails the container start.
set -uo pipefail

projects="$HOME/.claude/projects"
keep="$PWD/.snagboat/claude-projects"
# Claude Code names a project's transcript folder after its path, every
# character other than a letter or digit turned into "-".
key() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

case "${1:-}" in
  save)
    # Only inside the container: on the host, ~/.claude/projects is your own machine's, which belongs nowhere in the project.
    if [ ! -e /.dockerenv ] && [ "${REMOTE_CONTAINERS:-}" != true ]; then
      echo "carry-transcripts: run this in the dev container's terminal, not on the host; nothing copied."
      exit 0
    fi
    if [ "$(cd "$projects" 2>/dev/null && pwd -P)" = "$(cd "$keep" 2>/dev/null && pwd -P)" ]; then
      echo "carry-transcripts: ~/.claude/projects is already the project's folder; nothing to save."
      exit 0
    fi
    [ -d "$projects" ] || { echo "carry-transcripts: no ~/.claude/projects here."; exit 0; }
    mkdir -p "$keep"
    # -u: a file already there is replaced only by a newer copy (transcripts only grow), so running
    # this again just before the rebuild brings over what the current session wrote since; -P: links aren't followed.
    cp -R -P -p -u "$projects/." "$keep/" || exit 0
    # Claude Code writes no symbolic links there; Snagboat on the host refuses them, so don't carry any.
    find "$keep" -type l -exec rm -f {} + 2>/dev/null
    echo "carry-transcripts: copied $(find "$projects" -name '*.jsonl' | wc -l | tr -d ' ') transcript file(s) to $keep. Now rebuild the container."
    ;;
  start)
    old="$projects/$(key "/workspaces/$(basename "$PWD")")"
    new="$projects/$(key "$PWD")"
    [ "$old" = "$new" ] && exit 0
    [ -d "$old" ] && [ ! -L "$old" ] || exit 0
    if [ ! -e "$new" ]; then
      mv "$old" "$new" && echo "carry-transcripts: moved this project's earlier transcripts and memory to $(basename "$new")."
    else
      # Both exist (a session ran before this did): copy what's missing, keep the old folder.
      [ -e "$old/.carried" ] && exit 0
      cp -R -P -p -n "$old/." "$new/" && : > "$old/.carried" && echo "carry-transcripts: copied this project's earlier transcripts and memory into $(basename "$new"); $(basename "$old") is left as it was."
    fi
    ;;
  *)
    echo "usage: bash .devcontainer/carry-transcripts.sh save|start" >&2
    ;;
esac
exit 0
