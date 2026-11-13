#!/usr/bin/env bash
# One-time project setup, run inside the container:
#   bash .devcontainer/init-project.sh
# Creates the git repo (if needed) and the beads database, without letting
# bd install git hooks (those would also run on the host; see README).
set -euo pipefail

if [ ! -d .git ]; then
  git init -b main
fi

if [ -d .beads ]; then
  echo "beads already initialized here (.beads/ exists)."
else
  bd init --skip-hooks
fi

# You own this repo; tells bd so it stops warning on every command.
git config beads.role maintainer

bash "$(dirname "$0")/check-host-safety.sh"

echo
echo "Done. Try:  bd create \"First task\" -p 2   then   bd ready"
