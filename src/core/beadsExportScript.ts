/**
 * The beads exporter (bead snagboat-93b.10.8), a copy of .devcontainer/beads-export.sh, which
 * `snagboat containers allow --edit` writes to a project that has beads as .snagboat/bin/beads-export.sh. The dev
 * container runs it on start: it writes bd export and bd history to .snagboat/beads/ for the core on the host to read
 * (core/beadsExport.ts). Edit .devcontainer/beads-export.sh, then copy it in here; a unit test checks they match.
 */
export const BEADS_EXPORT_SCRIPT = String.raw`#!/bin/sh
# beads-export.sh: exports a project's beads (bd) to plain JSON for Snagboat on the host.
#
# bd runs in the dev container, not on the host, and its git data (refs/dolt/data) is
# Dolt's binary format. So, in the container, this writes what bd knows to the project
# folder, which the host sees at the same path:
#
#   .snagboat/beads/issues.jsonl         bd export, every run
#   .snagboat/beads/history/<id>.json    bd history <id> --events --json, for beads
#                                        that changed since the last run
#   .snagboat/beads/status.json          when it last ran, counts, bd's version, the last error
#   .snagboat/beads/export.log           what it did (capped at 256 KB, one old copy kept)
#
# Each file is written to a temporary file and renamed, so a reader never sees half of
# one. It writes nothing outside .snagboat/beads/ and only reads bd (bd --readonly).
#
#   sh beads-export.sh start [folder]   start it in the background, at low priority, and
#                                       return at once (the container's postStartCommand)
#   sh beads-export.sh run [folder]     export every 60 seconds (BEADS_EXPORT_INTERVAL)
#   sh beads-export.sh once [folder]    export once
#
# The folder defaults to the current one. It exits quietly when bd isn't installed, and
# when another copy is already running for the folder. A run with no .beads folder
# writes nothing and tries again next time.
#
# Plain POSIX sh (dash, busybox). Snagboat keeps a copy of this file in
# src/core/devcontainerSetup.ts, which snagboat containers allow --edit writes to
# other projects as .snagboat/bin/beads-export.sh, so it never uses backticks or the
# dollar-brace form of a variable.

mode=run
[ $# -gt 0 ] && mode=$1
folder=$PWD
[ $# -gt 1 ] && folder=$2

case $mode in
  start|run|once) ;;
  *) echo "usage: sh beads-export.sh start|run|once [folder]" >&2; exit 2 ;;
esac

command -v bd >/dev/null 2>&1 || exit 0
folder=$(cd "$folder" 2>/dev/null && pwd -P) || exit 0

if [ "$mode" = start ]; then
  script=$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")
  prio=
  command -v nice >/dev/null 2>&1 && prio="nice -n 10"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid $prio sh "$script" run "$folder" </dev/null >/dev/null 2>&1 &
  else
    nohup $prio sh "$script" run "$folder" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi

dir=$folder/.snagboat/beads
hist=$dir/history
lock=$dir/export.lock
logf=$dir/export.log
statef=$dir/state.tsv
errf=$dir/bd.err.$$
tab=$(printf '\t')

interval=$BEADS_EXPORT_INTERVAL
case $interval in ''|*[!0-9]*) interval=60 ;; esac
[ "$interval" -lt 5 ] && interval=5

# Everything stays inside the folder: no links on the way down.
for p in "$folder/.snagboat" "$dir" "$hist"; do
  [ -L "$p" ] && exit 0
done
mkdir -p "$hist" 2>/dev/null || exit 0
[ -f "$dir/.gitignore" ] || printf '# Written by beads-export.sh; never committed.\n*\n' > "$dir/.gitignore"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  printf '%s %s\n' "$(stamp)" "$*" >> "$logf"
  size=$(wc -c < "$logf" 2>/dev/null)
  [ -n "$size" ] && [ "$size" -gt 262144 ] && mv -f "$logf" "$logf.1"
}

# A JSON string, or null for an empty one.
json_str() {
  if [ -z "$1" ]; then printf 'null'; return; fi
  printf '"%s"' "$(printf '%s' "$1" | head -c 500 | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# Whether pid $1 is a copy of this script (where /proc can say).
is_exporter() {
  [ -r "/proc/$1/cmdline" ] || return 0
  tr '\000' ' ' < "/proc/$1/cmdline" | grep -q beads-export
}

# One copy per folder: a lock folder holding the owner's pid.
take_lock() {
  if mkdir "$lock" 2>/dev/null; then echo $$ > "$lock/pid"; return 0; fi
  old=$(cat "$lock/pid" 2>/dev/null)
  if [ -z "$old" ]; then sleep 1; old=$(cat "$lock/pid" 2>/dev/null); fi
  # Still no pid: another copy made the lock and hasn't written it yet (a slow start), unless
  # the lock is over a minute old, when that copy died between the two.
  if [ -z "$old" ] && [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then return 1; fi
  if [ -n "$old" ] && [ "$old" != $$ ] && kill -0 "$old" 2>/dev/null && is_exporter "$old"; then return 1; fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || return 1
  echo $$ > "$lock/pid"
}

own_lock() { [ "$(cat "$lock/pid" 2>/dev/null)" = $$ ]; }

release() {
  [ -n "$napping" ] && kill "$napping" 2>/dev/null
  own_lock && rm -rf "$lock"
  rm -f "$errf" "$dir"/*.tmp.$$ "$hist"/*.tmp.$$
}

napping=
take_lock || exit 0
trap release EXIT
trap 'exit 0' INT TERM

limit=
command -v timeout >/dev/null 2>&1 && limit="timeout 120"
rbd() { $limit bd --readonly "$@"; }

bd_version=$(bd version 2>/dev/null | head -n 1 | sed -n 's/^[^0-9]*\([0-9][0-9.]*\).*/\1/p')
last_success=
last_error=
last_error_at=
issues=0
histories=0
written=0
failed=0

write_status() {
  ok=$1
  printf '{"version":1,"folder":%s,"last_run":"%s","ok":%s,"last_success":%s,"duration_s":%s,"interval_s":%s,"issues":%s,"histories":%s,"histories_written":%s,"history_failures":%s,"bd_version":%s,"pid":%s,"last_error":%s,"last_error_at":%s}\n' \
    "$(json_str "$folder")" "$(stamp)" "$ok" "$(json_str "$last_success")" "$2" "$interval" \
    "$issues" "$histories" "$written" "$failed" "$(json_str "$bd_version")" $$ \
    "$(json_str "$last_error")" "$(json_str "$last_error_at")" > "$dir/status.json.tmp.$$" &&
    mv -f "$dir/status.json.tmp.$$" "$dir/status.json"
}

fail() {
  last_error=$1
  last_error_at=$(stamp)
  log "error: $1"
}

cycle() {
  start=$(date +%s)
  written=0
  failed=0
  if [ ! -d "$folder/.beads" ]; then
    write_status false 0
    return
  fi
  cd "$folder" || return

  if ! rbd export > "$dir/issues.jsonl.tmp.$$" 2> "$errf"; then
    rm -f "$dir/issues.jsonl.tmp.$$"
    fail "bd export failed: $(tail -n 1 "$errf" 2>/dev/null)"
    write_status false $(( $(date +%s) - start ))
    return
  fi
  if [ -f "$dir/issues.jsonl" ] && cmp -s "$dir/issues.jsonl.tmp.$$" "$dir/issues.jsonl" 2>/dev/null; then
    rm -f "$dir/issues.jsonl.tmp.$$"
  else
    mv -f "$dir/issues.jsonl.tmp.$$" "$dir/issues.jsonl"
  fi

  # Each bead's id, a signature (updated_at and the line's length), and whether that changed
  # since the last run. updated_at is the line's first one: bd writes it before the
  # dependencies and comments, which have their own.
  awk -v statefile="$statef" '
    BEGIN { while ((getline line < statefile) > 0) { split(line, f, "\t"); old[f[1]] = f[2] } }
    {
      id = ""; up = ""
      if (match($0, /"id":"[^"]*"/)) id = substr($0, RSTART + 6, RLENGTH - 7)
      if (match($0, /"updated_at":"[^"]*"/)) up = substr($0, RSTART + 14, RLENGTH - 15)
      if (id == "") next
      sig = up "|" length($0)
      print id "\t" sig "\t" (((id in old) && old[id] == sig) ? "same" : "changed")
    }' "$dir/issues.jsonl" > "$dir/scan.tmp.$$"

  : > "$dir/state.tmp.$$"
  issues=0
  while IFS=$tab read -r id sig how; do
    case $id in ''|.*|*[!A-Za-z0-9._-]*) continue ;; esac
    issues=$((issues + 1))
    if [ "$how" = same ] && [ -f "$hist/$id.json" ]; then
      printf '%s\t%s\n' "$id" "$sig" >> "$dir/state.tmp.$$"
      continue
    fi
    if rbd history "$id" --events --json > "$hist/$id.json.tmp.$$" 2> "$errf"; then
      mv -f "$hist/$id.json.tmp.$$" "$hist/$id.json"
      printf '%s\t%s\n' "$id" "$sig" >> "$dir/state.tmp.$$"
      written=$((written + 1))
    else
      # Left out of the state, so the next run tries it again.
      rm -f "$hist/$id.json.tmp.$$"
      failed=$((failed + 1))
      fail "bd history $id failed: $(tail -n 1 "$errf" 2>/dev/null)"
    fi
  done < "$dir/scan.tmp.$$"
  mv -f "$dir/state.tmp.$$" "$statef"

  # History for beads no longer in the export (deleted) goes too.
  for f in $( (cut -f 1 "$dir/scan.tmp.$$"; echo /; ls "$hist") | awk '$0 == "/" { files = 1; next } !files { keep[$0 ".json"] = 1; next } /\.json$/ && !($0 in keep)'); do
    rm -f "$hist/$f"
  done
  rm -f "$dir/scan.tmp.$$" "$errf"
  histories=$(ls "$hist" | grep -c '\.json$')

  took=$(( $(date +%s) - start ))
  if [ "$failed" -eq 0 ]; then
    last_success=$(stamp)
    write_status true "$took"
  else
    write_status false "$took"
  fi
  [ "$written" -gt 0 ] || [ "$failed" -gt 0 ] && log "exported $issues issue(s); wrote $written history file(s), $failed failed; $took s"
  return 0
}

log "started (pid $$, bd $bd_version, every $interval s) for $folder"
while :; do
  cycle
  [ "$mode" = once ] && exit 0
  # In the background, so a TERM is handled now rather than when the sleep ends.
  sleep "$interval" &
  napping=$!
  wait "$napping"
  napping=
  [ -d "$folder" ] || exit 0
  # Someone took the lock over (it looked stale to them): leave it to them.
  own_lock || exit 0
done
`;
