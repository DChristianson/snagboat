#!/usr/bin/env bash
# The project folder is shared with the host. Git hooks configured in it run
# on the host the next time you use git there. This script warns if any
# appear. It runs on every container start and can be run by hand (on the host
# too: `bash .devcontainer/check-host-safety.sh`).
set -uo pipefail

[ -d .git ] || exit 0

problems=0

hooks_path="$(git config --local --get core.hooksPath 2>/dev/null || true)"
if [ -n "$hooks_path" ]; then
  echo "WARNING: this repo sets core.hooksPath=$hooks_path"
  echo "         Git on the host will run the scripts there. Remove with:"
  echo "         git config --local --unset core.hooksPath"
  problems=1
fi

active_hooks="$(find .git/hooks -maxdepth 1 -type f ! -name '*.sample' 2>/dev/null)"
if [ -n "$active_hooks" ]; then
  echo "WARNING: active git hooks found (these run on the host too):"
  echo "$active_hooks" | sed 's/^/         /'
  problems=1
fi

if [ -d .beads/hooks ] && [ -n "$(ls -A .beads/hooks 2>/dev/null)" ]; then
  echo "NOTE: .beads/hooks/ has scripts; bd runs them on issue create/close."
  echo "      They are contained in the container but can edit project files:"
  ls -l .beads/hooks | sed 's/^/      /'
fi

[ "$problems" -eq 0 ] && echo "host-safety check: no git hooks configured."
exit 0
