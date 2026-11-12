#!/usr/bin/env bash
# Runs once, inside the container, right after it is created.
set -euo pipefail

echo "bd:     $(bd version 2>/dev/null | head -1)"
echo "claude: $(claude --version 2>/dev/null || echo 'not found')"
echo "git:    $(git --version)"

# Record the metrics opt-out in bd's user config too (the env vars already
# disable it; this keeps `bd metrics status` honest if they are ever unset).
bd metrics off >/dev/null 2>&1 || true

# Claude Code integration comes from `bd init` (init-project.sh): it writes a
# project-level .claude/settings.json hook that runs `bd prime` at session start.

if [ ! -d .beads ]; then
  echo
  echo "This project has no beads database yet. To start one, run:"
  echo "  bash .devcontainer/init-project.sh"
fi
