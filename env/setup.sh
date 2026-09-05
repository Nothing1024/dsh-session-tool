#!/bin/sh
# Install profile `st` under this directory (this folder is DSH_HOME).
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PLUGIN=$(CDPATH='' cd -- "$ROOT/.." && pwd)
ST="$ROOT/profiles/st"

if [ ! -d "$PLUGIN/packages/tool-session/lib" ]; then
  echo "env/setup: build the plugin first: (cd $PLUGIN && pnpm run build)" >&2
  exit 1
fi

# Models 页读 $DSH_HOME/.credentials.yaml（优先于 .env）。没有就从本机 ~/.dsh/.env 拷。
# 不拷 ~/.dsh/.credentials.yaml：那边可能是另一套 baseURL 的 key。
if [ ! -f "$ROOT/.env" ] && [ -f "$HOME/.dsh/.env" ]; then
  cp "$HOME/.dsh/.env" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  echo "env/setup: seeded .env from ~/.dsh/.env"
fi
if [ ! -f "$ROOT/.credentials.yaml" ] && [ -f "$ROOT/.env" ]; then
  KEY=$(awk -F= '/^DEEPSEEK_API_KEY=/{print substr($0,index($0,"=")+1); exit}' "$ROOT/.env")
  if [ -n "$KEY" ]; then
    umask 077
    printf 'DEEPSEEK_API_KEY: %s\n' "$KEY" >"$ROOT/.credentials.yaml"
    chmod 600 "$ROOT/.credentials.yaml"
    echo "env/setup: wrote .credentials.yaml from .env"
  fi
fi
if [ ! -f "$ROOT/.env" ] && [ ! -f "$ROOT/.credentials.yaml" ]; then
  echo "env/setup: 没有 API key。把 DEEPSEEK_API_KEY 写进 $ROOT/.env 或 $ROOT/.credentials.yaml" >&2
fi

cd "$ST"
pnpm install
echo "env/setup: ok"
echo "boot: $ROOT/boot.sh"
echo "or:   DSH_HOME=$ROOT npx --yes @deepseek-ai/dsh@0.1.2-rc.1 --profile st --port 3081 --no-open"
