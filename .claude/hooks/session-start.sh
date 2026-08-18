#!/bin/bash
# =============================================================================
# FLAGSTER — SessionStart hook
#
# Containers here are ephemeral AND their clone is a snapshot. A new container
# does not hand you the repository as it is on GitHub; it hands you the
# repository as it was whenever the image was taken. That has already cost a
# real day: a container came back holding VERSION 2.20.0 and an engine.js whose
# completion rate was 1.2% instead of 45%, twelve releases behind origin/master,
# and work got built on top of it before anyone noticed.
#
# So on every fresh session this hook:
#   1. fetches origin and compares the checked-out branch against the default
#      branch, and resyncs when it is stale — after saving the old tip to a
#      permanent ref, so the move is always reversible;
#   2. makes the browser-driven verification harnesses in tools/ actually
#      runnable, which otherwise means hand-installing Playwright every session.
#
# It never touches uncommitted work, and it only resyncs on a genuinely new
# session — on resume/compact you may be mid-task with local commits on purpose.
# =============================================================================
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" || exit 0

# The hook payload arrives on stdin; `source` distinguishes a new session from a
# resume. Parsed with node because node is the one interpreter this repo needs.
PAYLOAD="$(cat 2>/dev/null || true)"
SOURCE="$(printf '%s' "$PAYLOAD" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).source||"startup")}catch(e){process.stdout.write("startup")}})' \
  2>/dev/null || echo startup)"

say() { printf '%s\n' "$*"; }
rule() { say "────────────────────────────────────────────────────────────"; }

rule
say "Flagster session start  (source: ${SOURCE})"

# ---------------------------------------------------------------- 1. freshness
if git rev-parse --git-dir >/dev/null 2>&1; then
  DEFAULT="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
  [ -n "$DEFAULT" ] || DEFAULT=master
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo DETACHED)"

  git fetch --quiet origin "$DEFAULT" 2>/dev/null || say "  ! could not reach origin — treating local state as unverified"
  git fetch --quiet origin "$BRANCH"  2>/dev/null || true

  if git rev-parse --verify --quiet "origin/$DEFAULT" >/dev/null; then
    BASE="origin/$DEFAULT"
    BEHIND="$(git rev-list --count "HEAD..$BASE" 2>/dev/null || echo 0)"
    AHEAD="$(git rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)"
    DIRTY="$(git status --porcelain 2>/dev/null | head -c1)"

    say "  branch ${BRANCH} @ $(git rev-parse --short HEAD)   ${BASE} @ $(git rev-parse --short "$BASE")"
    say "  ${BEHIND} behind / ${AHEAD} ahead of ${BASE}"

    if [ "$BEHIND" = "0" ]; then
      say "  ✓ base is current"
    elif [ -n "$DIRTY" ]; then
      # Uncommitted work outranks freshness, always. Say so loudly and stop.
      say "  ‼ STALE BASE, and the working tree is dirty — NOT touching it."
      say "    Commit or stash, then:  git checkout -B ${BRANCH} ${BASE}"
    elif [ "$AHEAD" = "0" ]; then
      git merge --ff-only "$BASE" >/dev/null 2>&1 \
        && say "  ✓ fast-forwarded ${BEHIND} commits to ${BASE}" \
        || say "  ‼ fast-forward failed — run: git checkout -B ${BRANCH} ${BASE}"
    else
      # Divergent: the snapshot's branch has commits the default branch does not.
      # On this repo those are invariably commits that were already squash-merged
      # — and merging them back is what corrupted engine.js. Resync, but save the
      # old tip first so nothing is ever unrecoverable.
      if [ "$SOURCE" = "startup" ]; then
        SNAP="refs/container-snapshot/${BRANCH}/$(date -u +%Y%m%dT%H%M%SZ)"
        git update-ref "$SNAP" HEAD 2>/dev/null
        if git checkout -B "$BRANCH" "$BASE" >/dev/null 2>&1; then
          say "  ✓ RESYNCED a divergent container snapshot onto ${BASE}"
          say "    old tip saved at ${SNAP} — recover with: git checkout ${SNAP}"
        else
          say "  ‼ resync failed — run: git checkout -B ${BRANCH} ${BASE}"
        fi
      else
        say "  ‼ DIVERGENT from ${BASE} (${AHEAD} local commits) — left alone on ${SOURCE}."
        say "    If those commits are already squash-merged, do NOT merge ${BASE} in;"
        say "    run: git checkout -B ${BRANCH} ${BASE}"
      fi
    fi
  fi
fi

# ------------------------------------------------- 2. verification toolchain
# tools/simstats.mjs and tools/ruletest.mjs are dependency-free, but the
# browser-driven checks need Playwright, which lives in gitignored node_modules
# and therefore evaporates with the container.
if [ -f package.json ]; then
  if [ -d node_modules/playwright ]; then
    say "  ✓ playwright $(node -p "require('./node_modules/playwright/package.json').version" 2>/dev/null)"
  else
    say "  · installing devDependencies…"
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --silent >/dev/null 2>&1 \
      && say "  ✓ playwright installed" \
      || say "  ‼ npm install failed — browser checks unavailable (node-only tools still work)"
  fi
fi

# The image pins a Chromium build number, so a hardcoded path is one image
# refresh away from breaking. Discover it and publish it to the session.
CHROME="$(ls -1d /opt/pw-browsers/chromium*/chrome-linux/chrome 2>/dev/null | sort | tail -1)"
if [ -n "$CHROME" ] && [ -x "$CHROME" ]; then
  say "  ✓ chromium ${CHROME}"
  [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export FLAGSTER_CHROME=\"$CHROME\"" >> "$CLAUDE_ENV_FILE"
else
  say "  ‼ no swiftshader chromium found — browser checks unavailable"
fi

rule
exit 0
