#!/bin/bash
# Start a pristine demo container and open /research in tmux.
#
#   scripts/demo.sh                                  # opens pi interactively in the container
#   QUESTION="..." scripts/demo.sh                   # starts that run, then attaches
#   QUESTION="..." DETACH=1 scripts/demo.sh          # start it, do not attach
#   CONTAINER=pi-demo2 scripts/demo.sh               # a second container alongside the first
#
# The container is the only thing that is set up: /pkg is this repository mounted read-only, /agent
# holds exactly auth.json, models.json and a settings.json that declares no packages, and pi starts
# with -ne so no host extension, MCP server or global package can leak into the run.
set -euo pipefail

DEMO_IMAGE=${DEMO_IMAGE:-pi-research-sandbox:browser}
CONTAINER=${CONTAINER:-pi-demo}
DOCKERFILE=${DOCKERFILE:-/tmp/eval/Dockerfile}
QUESTION=${QUESTION:-}
DETACH=${DETACH:-}
SESSION=${SESSION:-research}
DEMO_BASE=${DEMO_BASE:-/tmp/pi-demo}
DEMO_AGENT=${DEMO_AGENT:-$DEMO_BASE/agent}
DEMO_WORK=${DEMO_WORK:-$DEMO_BASE/work}
PKG=$(cd "$(dirname "$0")/.." && pwd)

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running"

# 1. Image
if ! docker image inspect "$DEMO_IMAGE" >/dev/null 2>&1; then
	say "Building $DEMO_IMAGE from $DOCKERFILE"
	[ -f "$DOCKERFILE" ] || die "no $DOCKERFILE to build from; pass DOCKERFILE=..."
	docker build -t "$DEMO_IMAGE" -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")"
fi

# 2. Package dependencies: the extension is loaded as source, so node_modules must exist.
if [ ! -d "$PKG/node_modules" ]; then
	say "Installing package dependencies in $PKG"
	(cd "$PKG" && npm ci --no-audit --no-fund)
fi

# 3. A clean agent directory with no packages declared.
mkdir -p "$DEMO_AGENT" "$DEMO_WORK"
for file in auth.json models.json; do
	[ -f "$HOME/.pi/agent/$file" ] || die "$HOME/.pi/agent/$file is missing; run pi and authenticate first"
	cp -f "$HOME/.pi/agent/$file" "$DEMO_AGENT/"
done
printf '{"defaultProvider":"opencode-go","defaultModel":"deepseek-v4.1-flash"}\n' > "$DEMO_AGENT/settings.json"

# 4. Container
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
say "Starting container $CONTAINER"
docker run -d --name "$CONTAINER" \
	-v "$PKG:/pkg:ro" \
	-v "$DEMO_AGENT:/agent" \
	-v "$DEMO_WORK:/work" \
	-w /work \
	-e PI_CODING_AGENT_DIR=/agent \
	-e PI_RESEARCH_MODEL=deepseek-v4.1-flash \
	-e PI_RESEARCH_BROWSER=1 \
	"$DEMO_IMAGE" >/dev/null

# 5. The session. -ne keeps it pristine; -e /pkg is the only extension.
mkdir -p "$DEMO_WORK/demo"
docker exec -d "$CONTAINER" tmux new-session -d -s "$SESSION" "cd /work/demo && pi -ne -e /pkg; exec bash"
for _ in $(seq 1 90); do
	docker exec "$CONTAINER" tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "deepseek-v4.1-flash" && break
	sleep 1
done

# 6. The question, when one was given. Without it the session is left interactive.
if [ -n "$QUESTION" ]; then
	say "Running: $QUESTION"
	docker exec "$CONTAINER" tmux send-keys -t "$SESSION" -l "/research $QUESTION"
	sleep 1
	docker exec "$CONTAINER" tmux send-keys -t "$SESSION" Enter
else
	say "Interactive: type /research <question> to start, /research-view after it finishes"
fi

cat <<EOF

$(say "Attached:")     docker exec -it $CONTAINER tmux attach -t $SESSION
$(say "Report:")       ls $DEMO_WORK/demo/research/*-report.md   (or: /research-view inside the session)
$(say "Journal:")      ls $DEMO_WORK/demo/research/*.journal.json
$(say "Stop:")         docker rm -f $CONTAINER
EOF

# Attaching needs a terminal; piped or non-interactive callers get the command instead of a hang.
if [ -z "$DETACH" ] && [ -t 0 ] && [ -t 1 ]; then
	exec docker exec -it "$CONTAINER" tmux attach -t "$SESSION"
else
	[ -n "$DETACH" ] || say "No terminal to attach to; run: docker exec -it $CONTAINER tmux attach -t $SESSION"
fi
