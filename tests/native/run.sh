#!/bin/bash
# Invoke inside a fresh user/network namespace and Xvfb; see README.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
output=${1:?evidence output directory}
executable=${2:?packaged Netcatty executable}
python3 "$script_dir/seed.py"
python3 "$script_dir/seed.py" --wal > "$output/wal-fixture.log" 2>&1 &
wal=$!
for attempt in $(seq 1 50); do
  if rg -q '"wal": true' "$output/wal-fixture.log"; then break; fi
  if ! kill -0 "$wal" 2>/dev/null; then echo 'WAL seed failed'; exit 1; fi
  sleep 0.1
done
rg -q '"wal": true' "$output/wal-fixture.log"
ip link set lo up
xfwm4 --compositor=off > "$output/window-manager.log" 2>&1 &
wm=$!
trap 'kill "$wm" "$wal" 2>/dev/null || true; wait "$wm" "$wal" 2>/dev/null || true' EXIT
node "$script_dir/capture.mjs" "$output" "$executable"
node "$script_dir/capture.mjs" "$output" "$executable" --restart
