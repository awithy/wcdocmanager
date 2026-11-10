#!/usr/bin/env bash
# Installs a `wcdoc` wrapper that runs this checkout's CLI from any directory.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${WCDOC_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
cat > "$bin_dir/wcdoc" <<WRAPPER
#!/bin/sh
exec "$root/node_modules/.bin/tsx" "$root/src/cli/index.ts" "\$@"
WRAPPER
chmod 755 "$bin_dir/wcdoc"
echo "Installed $bin_dir/wcdoc"
