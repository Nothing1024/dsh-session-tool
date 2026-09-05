#!/usr/bin/env bash
# session-tool 一键 CLI 矩阵：每条命令写退出码 + stdout/stderr，并断言本脚本的 UF-001..008。
#
# 编号声明：本脚本的 UF-001..008 不是 docs/dsh-0-1-2-upgrade/spec.md 的 UF-001..006。
# spec 5.2 是另一套用户可见场景；本矩阵不能代替 5.2。
#
# 鉴权：跨进程打 :3081 必须带 launch token（ASM-002）。读取 DSH_LAUNCH_TOKEN；
# 若未设，则从 DSH_WEB_LINE（或 DSH_LAUNCH_TOKEN 里整段 `dsh web:` URL）解析 token=。
# 来源是 boot stdout 的 `dsh web: http://127.0.0.1:3081/?token=...` 行。
#
# 需要 :3081 上本仓网关已起（sh env/boot.sh）。不要 --profile st（那是正在跑的 web）。
# 先核监听进程的 DSH_HOME 是本仓 env/，再打；别人的 :3081 直接失败。
#
#   export DSH_LAUNCH_TOKEN='<token from dsh web: URL>'
#   bash scripts/manual-test.sh              # 默认会给几条可见会话写中文提示（走模型）
#   bash scripts/manual-test.sh --no-write   # 只建会话、不打对话
#   bash scripts/manual-test.sh --out PATH
#
# 前台怎么看：打开 http://127.0.0.1:3081 ，侧栏选 workspace「手工验收」。
# 标题带【可见】的应出现；「~【标题隐藏】」官方栏不显示；「【标记隐藏】」官方栏
# 仍可能看见（官方不读插件标记），但 session list 默认会丢掉。
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DSH_HOME="${DSH_HOME:-$ROOT/env}"
CLI_REL='packages/session-tool-cli/lib/bin.js'
CLI_BIN="$ROOT/$CLI_REL"
PATCH="$DSH_HOME/cli.patch.yml"
DEAD_PATCH="$DSH_HOME/dead-web.patch.yml"
MARKS="$DSH_HOME/session-tool/marks.jsonl"
WS_DIR="$DSH_HOME/manual-view"
WS_TITLE='手工验收'
STAMP=$(date +%Y%m%d-%H%M%S)
PREFIX="手工${STAMP}"
RUN_TAG="run:$STAMP"
OUT="$DSH_HOME/manual-test-last.txt"
WITH_WRITE=1

# 显性（官方侧栏应能搜到）
T_WF="${PREFIX}-【可见】工作流"
T_OK="${PREFIX}-【可见】普通"
T_VIBEE_A="${PREFIX}-【可见】vibee甲"
T_VIBEE_B="${PREFIX}-【可见】vibee乙"
T_PLAIN="${PREFIX}-【可见】无kind"
T_PARENT="${PREFIX}-【可见】委派父"
T_CHILD="${PREFIX}-【可见】委派子"
T_NODELEG="${PREFIX}-【可见】非委派"
T_WS="${PREFIX}-【可见】工作区绑定"
T_WRITE="${PREFIX}-【可见】带中文对话"
T_AB="${PREFIX}-【将改隐】替换前"

# 隐性：~ 官方栏与默认 list 都藏
T_SECRET="~${PREFIX}-【标题隐藏】机密"

# 隐性（仅插件 list）：官方栏不读 tags，标题仍可能出现
T_KIND="${PREFIX}-【标记隐藏】官方或仍可见"

while [ $# -gt 0 ]; do
  case "$1" in
    --write) WITH_WRITE=1; shift ;;
    --no-write) WITH_WRITE=0; shift ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *)
      printf '未知参数: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

PASS=0
FAIL=0
LAST_EXIT=0
LAST_STDOUT=''
LAST_STDERR=''

UF001=''
UF002_SECRET=''
UF002_HIDDEN=''
UF002_OK=''
UF003A=''
UF003B=''
UF003P=''
UF004=''
UF005P=''
UF005C=''
UF005X=''
UF_WS=''
UF_W=''
WS_ID=''

say() {
  printf '%s\n' "$*" | tee -a "$OUT"
}

json() {
  LAST_JSON="$LAST_STDOUT" LAST_SNIPPET="$1" node -e '
    const j = JSON.parse(process.env.LAST_JSON);
    eval(process.env.LAST_SNIPPET);
  '
}

quote_args() {
  local out='' a
  for a in "$@"; do
    if [ -z "$a" ]; then
      out="$out ''"
    elif printf '%s' "$a" | grep -Eq '[[:space:]|&;<>()\$`"'"'"'\\]'; then
      out="$out '$(printf '%s' "$a" | sed "s/'/'\\\\''/g")'"
    else
      out="$out $a"
    fi
  done
  printf '%s' "${out# }"
}

run_cli() {
  local heading=$1
  shift
  local stdout_f stderr_f display
  stdout_f=$(mktemp)
  stderr_f=$(mktemp)
  display=$(quote_args "$@")
  say ''
  say "## $heading"
  say "\$ DSH_HOME=$DSH_HOME DSH_LAUNCH_TOKEN=set node $CLI_REL $display"
  env DSH_HOME="$DSH_HOME" DSH_LAUNCH_TOKEN="$DSH_LAUNCH_TOKEN" node "$CLI_BIN" "$@" >"$stdout_f" 2>"$stderr_f"
  LAST_EXIT=$?
  LAST_STDOUT=$(cat "$stdout_f")
  LAST_STDERR=$(cat "$stderr_f")
  rm -f "$stdout_f" "$stderr_f"
  say "退出码 $LAST_EXIT"
  say '--- 标准输出 ---'
  if [ -n "$LAST_STDOUT" ]; then say "$LAST_STDOUT"; else say '（空）'; fi
  say '--- 标准错误 ---'
  if [ -n "$LAST_STDERR" ]; then say "$LAST_STDERR"; else say '（空）'; fi
  say ''
}

sess() {
  local heading=$1
  shift
  run_cli "$heading" "$@" --profile headless --patch "$PATCH" --format json
}

marks() {
  local heading=$1
  shift
  run_cli "$heading" "$@" --format json
}

check() {
  local name=$1
  shift
  if "$@"; then
    say "核对 ${name}：通过"
    PASS=$((PASS + 1))
  else
    say "核对 ${name}：失败"
    FAIL=$((FAIL + 1))
  fi
}

eq() { [ "$1" = "$2" ]; }
nonzero() { [ "$1" -ne 0 ]; }
nempty() { [ -n "$1" ]; }

js_str() {
  JS_STR_IN="$1" node -e 'process.stdout.write(JSON.stringify(process.env.JS_STR_IN))'
}

stderr_has() {
  case "$LAST_STDERR" in *"$1"*) return 0 ;; *) return 1 ;; esac
}

# Pull token= out of a `dsh web:` URL (first URL, not the LAN duplicate), or return a raw token unchanged.
parse_launch_token() {
  case "$1" in
    *token=*|*dsh\ web:*)
      printf '%s\n' "$1" | grep -oE 'https?://[^[:space:]]+' | head -n 1 | sed -nE 's/.*[?&]token=([^&]*).*/\1/p'
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

# Prefer DSH_LAUNCH_TOKEN; otherwise parse DSH_WEB_LINE (boot `dsh web:` row).
resolve_launch_token() {
  if [ -z "${DSH_LAUNCH_TOKEN:-}" ] && [ -n "${DSH_WEB_LINE:-}" ]; then
    DSH_LAUNCH_TOKEN=$DSH_WEB_LINE
  fi
  if [ -n "${DSH_LAUNCH_TOKEN:-}" ]; then
    parsed=$(parse_launch_token "$DSH_LAUNCH_TOKEN")
    if [ -n "$parsed" ]; then
      DSH_LAUNCH_TOKEN=$parsed
    fi
  fi
  if [ -z "${DSH_LAUNCH_TOKEN:-}" ]; then
    echo "缺少 launch token。从 boot stdout 的 dsh web: 行取 token= 后：" >&2
    echo "  export DSH_LAUNCH_TOKEN=<token>" >&2
    echo "  # 或：export DSH_WEB_LINE='dsh web: http://127.0.0.1:3081/?token=...'" >&2
    echo "  bash scripts/manual-test.sh" >&2
    exit 1
  fi
  export DSH_LAUNCH_TOKEN
}

marks_excerpt() {
  if [ ! -f "$MARKS" ]; then
    say 'marks.jsonl：（没有文件）'
    return
  fi
  say 'marks.jsonl 摘录：'
  if [ $# -eq 0 ]; then
    say "$(cat "$MARKS")"
    return
  fi
  local id
  for id in "$@"; do
    grep -F "\"id\":\"$id\"" "$MARKS" | tail -n 1 | tee -a "$OUT" || say "（没有 $id 这一行）"
  done
}

marks_has_id() {
  [ -f "$MARKS" ] && grep -q -F "\"id\":\"$1\"" "$MARKS"
}

mkdir -p "$(dirname -- "$OUT")"
mkdir -p "$WS_DIR"
: >"$OUT"

if [ ! -f "$CLI_BIN" ]; then
  echo "缺少 ${CLI_REL}，先跑：pnpm run build" >&2
  exit 1
fi
if [ ! -f "$PATCH" ]; then
  echo "缺少 $PATCH" >&2
  exit 1
fi
if [ ! -d "$DSH_HOME/profiles/st/node_modules/@deepseek-ai/dsh-base" ]; then
  echo "还没跑 env/setup.sh" >&2
  exit 1
fi

GW_PORT=3081
EXPECTED_HOME="$DSH_HOME"
# shellcheck disable=SC1091
. "$DSH_HOME/gateway-id.sh"
gateway_require
GW=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:${GW_PORT}/" || true)
# 0.1.2 无 cookie 的 GET / 是 401；有 cookie 才 200。探活只排除连不上。
if [ "$GW" != 200 ] && [ "$GW" != 303 ] && [ "$GW" != 401 ]; then
  echo "网关 http://127.0.0.1:${GW_PORT} 身份对但 HTTP=${GW}。先：sh env/boot.sh" >&2
  exit 1
fi
resolve_launch_token
TOKEN_GW=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:${GW_PORT}/?token=${DSH_LAUNCH_TOKEN}" || true)
if [ "$TOKEN_GW" != 303 ]; then
  echo "launch token 换 cookie 失败：GET /?token= HTTP=${TOKEN_GW}（期望 303，且不要跟随重定向）。token 来自本次 boot 的 dsh web: 行。" >&2
  exit 1
fi

say "# session-tool 一键 CLI 矩阵"
say "时间：$STAMP"
say "ROOT：$ROOT"
say "DSH_HOME：$DSH_HOME"
say "网关：http://127.0.0.1:${GW_PORT} pid=$GW_PID curl=$GW home=$GW_HOME"
say "CLI：node $CLI_BIN"
say "profile：headless + $PATCH"
say "本轮标题前缀：$PREFIX"
say "本轮标记：$RUN_TAG"
say "前台分组：workspace「${WS_TITLE}」→ $WS_DIR"
say "DSH_LAUNCH_TOKEN：已设置（不打印）"
say "说明：不要再 boot --profile st。CLI 打已在跑的 :${GW_PORT}（须本仓 DSH_HOME）。本脚本 UF-001..008 不是 spec UF-001..006。"
say "监听："
(lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN || true) | tee -a "$OUT"
say ''

say '=== 准备：注册前台分组「手工验收」（不删除，方便对照） ==='
sess "注册 workspace 手工验收" workspace add "$WS_DIR" --title "$WS_TITLE"
check 工作区注册-退出码 eq "$LAST_EXIT" 0
WS_ID=$(json 'process.stdout.write(j.workspace_id||"")')
check 工作区-有id nempty "$WS_ID"

say '=== UF-002 空列表：不存在的中文标题，空成功 ==='
sess "按不存在的标题列表" session list --title "${PREFIX}-不存在的标题"
check 空列表-退出码 eq "$LAST_EXIT" 0
check 空列表-条数 eq "$(json 'process.stdout.write(String((j.sessions||[]).length))')" 0

say '=== UF-001 失败：死网关，不写标记表 ==='
MARKS_BEFORE=''
[ -f "$MARKS" ] && MARKS_BEFORE=$(cat "$MARKS")
run_cli "死网关 :3999 上创建" \
  session create --title "${PREFIX}-死网关不应出现" --tag kind:vibee \
  --profile headless --patch "$DEAD_PATCH" --format json
check 死网关-非0 nonzero "$LAST_EXIT"
check 死网关-错误码 stderr_has 'web-unreachable'
MARKS_AFTER=''
[ -f "$MARKS" ] && MARKS_AFTER=$(cat "$MARKS")
check 死网关-表未写 eq "$MARKS_BEFORE" "$MARKS_AFTER"

say '=== UF-006 非法 tag：空 / 超长，表无半行 ==='
MARKS_BEFORE=$MARKS_AFTER
sess "空 tag 创建" session create --title "${PREFIX}-空tag不应出现" --tag ''
check 空tag-非0 nonzero "$LAST_EXIT"
check 空tag-错误码 stderr_has 'tag-invalid'
MARKS_AFTER=''
[ -f "$MARKS" ] && MARKS_AFTER=$(cat "$MARKS")
check 空tag-表未写 eq "$MARKS_BEFORE" "$MARKS_AFTER"

OVERLONG=$(node -e 'process.stdout.write("x".repeat(129))')
sess "超长 tag 创建" session create --title "${PREFIX}-超长tag不应出现" --tag "$OVERLONG"
check 超长tag-非0 nonzero "$LAST_EXIT"
check 超长tag-错误码 stderr_has 'tag-invalid'
MARKS_AFTER=''
[ -f "$MARKS" ] && MARKS_AFTER=$(cat "$MARKS")
check 超长tag-表未写 eq "$MARKS_BEFORE" "$MARKS_AFTER"

say '=== UF-001 成功：显性【可见】工作流 + kind:vibee ==='
sess "创建可见工作流" session create --title "$T_WF" --workspace "$WS_DIR" --tag kind:vibee --tag plan --tag "$RUN_TAG"
check 工作流-退出码 eq "$LAST_EXIT" 0
UF001=$(json 'process.stdout.write(j.session_id||"")')
check 工作流-有id nempty "$UF001"
sess "按标题列出可见工作流" session list --title "$T_WF"
check 工作流-列表退出码 eq "$LAST_EXIT" 0
check 工作流-标记 eq "$(json 'process.stdout.write(((j.sessions[0]&&j.sessions[0].tags)||[]).join(","))')" "kind:vibee,plan,$RUN_TAG"
marks_excerpt "$UF001"
check 工作流-已落盘 marks_has_id "$UF001"

say '=== UF-007 新 CLI 进程再列表，工作流仍在 ==='
sess "新进程再列可见工作流" session list --tag kind:vibee --title "$T_WF"
check 重启列表-退出码 eq "$LAST_EXIT" 0
check 重启列表-仍是同一条 eq "$(json 'process.stdout.write((j.sessions[0]&&j.sessions[0].session_id)||"")')" "$UF001"

say '=== UF-002 双闸：隐性~标题 / 隐性kind:hidden / 显性普通 ==='
sess "创建标题隐藏（~）" session create --title "$T_SECRET" --workspace "$WS_DIR" --tag plan --tag "$RUN_TAG"
UF002_SECRET=$(json 'process.stdout.write(j.session_id||"")')
sess "创建标记隐藏（kind:hidden）" session create --title "$T_KIND" --workspace "$WS_DIR" --tag kind:hidden --tag "$RUN_TAG"
UF002_HIDDEN=$(json 'process.stdout.write(j.session_id||"")')
sess "创建可见普通" session create --title "$T_OK" --workspace "$WS_DIR" --tag plan --tag "$RUN_TAG"
UF002_OK=$(json 'process.stdout.write(j.session_id||"")')
check 双闸-机密id nempty "$UF002_SECRET"
check 双闸-标隐id nempty "$UF002_HIDDEN"
check 双闸-普通id nempty "$UF002_OK"

sess "默认列表（本轮前缀）" session list --title "${PREFIX}-"
check 默认列表-有普通 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.title===$(js_str "$T_OK"))))")" true
check 默认列表-无标题隐藏 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.title===$(js_str "$T_SECRET"))))")" false
check 默认列表-无标记隐藏 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.title===$(js_str "$T_KIND"))))")" false

sess "含隐藏列表（本轮前缀）" session list --title "${PREFIX}-" --include-hidden
check 含隐藏-有标题隐藏 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.title===$(js_str "$T_SECRET"))))")" true
check 含隐藏-有标记隐藏 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.title===$(js_str "$T_KIND"))))")" true
check 含隐藏-有普通 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.title===$(js_str "$T_OK"))))")" true

say '=== UF-003 按 kind:vibee 列表 / collect ==='
sess "创建可见 vibee甲" session create --title "$T_VIBEE_A" --workspace "$WS_DIR" --tag kind:vibee --tag plan --tag "$RUN_TAG"
UF003A=$(json 'process.stdout.write(j.session_id||"")')
sess "创建可见 vibee乙" session create --title "$T_VIBEE_B" --workspace "$WS_DIR" --tag kind:vibee --tag "$RUN_TAG"
UF003B=$(json 'process.stdout.write(j.session_id||"")')
sess "创建可见无kind" session create --title "$T_PLAIN" --workspace "$WS_DIR" --tag plain --tag "$RUN_TAG"
UF003P=$(json 'process.stdout.write(j.session_id||"")')

sess "列表只含 vibee甲/乙" session list --tag kind:vibee --title "${PREFIX}-【可见】vibee"
check vibee列表-退出码 eq "$LAST_EXIT" 0
check vibee列表-两条 eq "$(json 'process.stdout.write(String((j.sessions||[]).length))')" 2
EXPECTED_IDS=$(printf '%s\n%s\n' "$UF003A" "$UF003B" | sort | tr '\n' ' ' | sed 's/ $//')
check vibee列表-id eq "$(json 'process.stdout.write((j.sessions||[]).map(s=>s.session_id).sort().join(" "))')" "$EXPECTED_IDS"

sess "collect 本轮 vibee" session collect --tag kind:vibee --filter-tag "$RUN_TAG" --timeout-ms 0
check collect-退出码 eq "$LAST_EXIT" 0
check collect-有甲 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.session_id===$(js_str "$UF003A"))))")" true
check collect-有乙 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.session_id===$(js_str "$UF003B"))))")" true
check collect-无普通 eq "$(json "process.stdout.write(String((j.sessions||[]).some(s=>s.session_id===$(js_str "$UF003P"))))")" false

say '=== UF-003 无匹配：空成功 ==='
sess "列表不存在的 kind" session list --tag kind:sm-no-such
check 无匹配列表-空 eq "$(json 'process.stdout.write(String((j.sessions||[]).length))')" 0
sess "collect 不存在的 kind" session collect --tag kind:sm-no-such --timeout-ms 0
check 无匹配collect-空 eq "$(json 'process.stdout.write(String((j.sessions||[]).length))')" 0

say '=== UF-004 rename 整组换成 kind:hidden，标题不变 ==='
sess "创建将改隐" session create --title "$T_AB" --workspace "$WS_DIR" --tag a --tag b --tag "$RUN_TAG"
UF004=$(json 'process.stdout.write(j.session_id||"")')
sess "整组替换为 kind:hidden" session rename "$UF004" --tag kind:hidden
check 改隐-退出码 eq "$LAST_EXIT" 0
check 改隐-新标记 eq "$(json 'process.stdout.write((j.tags||[]).join(","))')" 'kind:hidden'
sess "默认列表应丢掉将改隐" session list --title "$T_AB"
check 改隐-默认不可见 eq "$(json 'process.stdout.write(String((j.sessions||[]).length))')" 0
sess "含隐藏应仍是原标题" session list --title "$T_AB" --include-hidden
check 改隐-标题未改 eq "$(json 'process.stdout.write((j.sessions[0]&&j.sessions[0].title)||"")')" "$T_AB"
check 改隐-只剩hidden eq "$(json 'process.stdout.write(((j.sessions[0]&&j.sessions[0].tags)||[]).join(","))')" 'kind:hidden'
marks_excerpt "$UF004"

say '=== UF-004 空 rename ==='
sess "不带 title/tags 的 rename" session rename "$UF004"
check 空rename-非0 nonzero "$LAST_EXIT"
check 空rename-错误码 stderr_has 'empty-content'

say '=== UF-005 --parent 自动 kind:delegated；普通创建不加 ==='
sess "创建可见委派父" session create --title "$T_PARENT" --workspace "$WS_DIR" --tag "$RUN_TAG"
UF005P=$(json 'process.stdout.write(j.session_id||"")')
sess "创建可见委派子" session create --title "$T_CHILD" --workspace "$WS_DIR" --parent "$UF005P"
UF005C=$(json 'process.stdout.write(j.session_id||"")')
marks "读委派子标记" marks get --id "$UF005C"
check 委派子-退出码 eq "$LAST_EXIT" 0
check 委派子-自动标记 eq "$(json 'process.stdout.write((j.tags||[]).join(","))')" 'kind:delegated'
sess "按 kind:delegated 列委派子" session list --tag kind:delegated --title "$T_CHILD"
check 委派子-在列表 eq "$(json 'process.stdout.write((j.sessions[0]&&j.sessions[0].session_id)||"")')" "$UF005C"

sess "创建可见非委派" session create --title "$T_NODELEG" --workspace "$WS_DIR" --tag plan --tag "$RUN_TAG"
UF005X=$(json 'process.stdout.write(j.session_id||"")')
marks "读非委派标记" marks get --id "$UF005X"
check 非委派-无delegated eq "$(json 'process.stdout.write((j.tags||[]).join(","))')" "plan,$RUN_TAG"

say '=== UF-008 marks list/get ==='
marks "marks 只列 kind:vibee" marks list --kind kind:vibee
check marks列表-退出码 eq "$LAST_EXIT" 0
check marks列表-有工作流 eq "$(json "process.stdout.write(String((j||[]).some(r=>r.id===$(js_str "$UF001"))))")" true
check marks列表-有vibee甲 eq "$(json "process.stdout.write(String((j||[]).some(r=>r.id===$(js_str "$UF003A"))))")" true
marks "marks get 可见工作流" marks get --id "$UF001"
check marks-get工作流 eq "$(json 'process.stdout.write((j.tags||[]).join(","))')" "kind:vibee,plan,$RUN_TAG"
marks "marks get 不存在的 id" marks get --id session-sm-no-such
check marks-错id-非0 nonzero "$LAST_EXIT"
check marks-错id-错误码 stderr_has 'session-not-found'

say '=== 额外：读不存在的会话 ==='
sess "读不存在的会话" session read session-sm-no-such
check 读错id-错误码 stderr_has 'session-not-found'

say '=== 额外：工作区绑定会话（保留 workspace，不删） ==='
sess "在手工验收里再建一条" session create --title "$T_WS" --workspace "$WS_DIR" --tag "$RUN_TAG"
UF_WS=$(json 'process.stdout.write(j.session_id||"")')
check 绑定会话-有id nempty "$UF_WS"
sess "列出 workspace" workspace list
check 工作区仍在 eq "$(json "process.stdout.write(String((j.workspaces||[]).some(w=>w.workspace_id===$(js_str "$WS_ID"))))")" true

if [ "$WITH_WRITE" -eq 1 ]; then
  say '=== 给每条可查看会话写不同中文提示（空会话官方栏不出现） ==='
  sess "写入可见工作流" session write "$UF001" '你是【可见】工作流会话。请只回复四个字：可见工作流'
  check 写入-工作流 eq "$LAST_EXIT" 0
  sess "写入可见普通" session write "$UF002_OK" '你是【可见】普通会话。请只回复四个字：可见普通'
  check 写入-普通 eq "$LAST_EXIT" 0
  sess "写入可见 vibee甲" session write "$UF003A" '你是【可见】vibee甲。请只回复四个字：可见甲号'
  check 写入-甲 eq "$LAST_EXIT" 0
  sess "写入可见 vibee乙" session write "$UF003B" '你是【可见】vibee乙。请只回复四个字：可见乙号'
  check 写入-乙 eq "$LAST_EXIT" 0
  sess "写入可见无kind" session write "$UF003P" '你是【可见】无kind会话。请只回复四个字：可见无类'
  check 写入-无kind eq "$LAST_EXIT" 0
  sess "写入可见委派父" session write "$UF005P" '你是【可见】委派父会话。请只回复四个字：可见委派父'
  check 写入-委派父 eq "$LAST_EXIT" 0
  sess "写入可见委派子" session write "$UF005C" '你是【可见】委派子会话。请只回复四个字：可见委派子'
  check 写入-委派子 eq "$LAST_EXIT" 0
  sess "写入可见非委派" session write "$UF005X" '你是【可见】非委派会话。请只回复四个字：可见非委派'
  check 写入-非委派 eq "$LAST_EXIT" 0
  sess "写入可见工作区绑定" session write "$UF_WS" '你是【可见】工作区绑定会话。请只回复六个字：可见工作区绑定'
  check 写入-工作区 eq "$LAST_EXIT" 0
  sess "写入标记隐藏（官方栏或仍可见）" session write "$UF002_HIDDEN" '你是【标记隐藏】会话。插件 list 会丢掉你，但官方侧栏可能仍看见。请只回复四个字：标记隐藏'
  check 写入-标隐 eq "$LAST_EXIT" 0
  sess "写入将改隐（标题未改）" session write "$UF004" '你是【将改隐】会话。标题没变，标记已换成 kind:hidden。请只回复四个字：将改隐藏'
  check 写入-将改隐 eq "$LAST_EXIT" 0
  sess "另建带对话会话并写入" session create --title "$T_WRITE" --workspace "$WS_DIR" --tag "$RUN_TAG"
  UF_W=$(json 'process.stdout.write(j.session_id||"")')
  sess "写入带中文对话" session write "$UF_W" '你是【可见】带中文对话的会话。请用一句话介绍你自己，先报标题类型。'
  check 写入-对话会话 eq "$LAST_EXIT" 0
  sess "回读带中文对话" session read "$UF_W"
  check 回读-退出码 eq "$LAST_EXIT" 0
  check 回读-有用户消息 eq "$(json 'process.stdout.write(String((j.messages||[]).some(m=>m.role==="user")))')" true
fi

say ''
say '=== 本轮会话对照（前台怎么认） ==='
say "打开 http://127.0.0.1:${GW_PORT} ，侧栏选 workspace「${WS_TITLE}」。"
say "检索框搜：${PREFIX}"
say ''
say "显性（官方侧栏应出现，标题带【可见】）："
say "  工作流     $T_WF     $UF001"
say "  普通       $T_OK     $UF002_OK"
say "  vibee甲    $T_VIBEE_A  $UF003A"
say "  vibee乙    $T_VIBEE_B  $UF003B"
say "  无kind     $T_PLAIN   $UF003P"
say "  委派父     $T_PARENT  $UF005P"
say "  委派子     $T_CHILD   $UF005C"
say "  非委派     $T_NODELEG $UF005X"
say "  工作区绑定 $T_WS      $UF_WS"
if [ -n "$UF_W" ]; then
  say "  带中文对话 $T_WRITE   $UF_W"
fi
say ''
say "隐性-标题（官方栏默认不出现，因为标题以 ~ 开头）："
say "  $T_SECRET  $UF002_SECRET"
say ''
say "隐性-标记（插件默认 list 丢掉；官方栏不读 tags，标题仍可能看见）："
say "  $T_KIND  $UF002_HIDDEN"
say "  $T_AB    $UF004   （rename 后只剩 kind:hidden，标题未改）"
say ''
say "核对 $PASS 通过 / $FAIL 失败"
say "完整记录：$OUT"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
