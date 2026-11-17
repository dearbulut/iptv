#!/usr/bin/env bash
#
# Publishes files to the `state` branch: one snapshot, no history.
#
# The branch is shared — Health Scan writes `health.json`, EPG Grab writes
# `epg/*`, Discover writes `discovery.json` — so two properties matter:
#
#   1. Never clobber another workflow's files. The very first version did
#      `git init` + `push --force`, so whichever ran last wiped the others.
#      Fixed by cloning the current branch and overlaying only our paths.
#
#   2. Never accumulate history. The second version fixed (1) by committing on
#      top of the existing branch, which kept every snapshot forever: 455
#      commits in under four months, mostly ~23 MB of gzipped guides that do
#      not delta-compress, so the repository grew past 2 GB and a plain
#      `git pull` downloaded all of it. The state branch is a cache of the
#      latest pipeline output; nothing ever reads its history.
#
# So each publish builds a single parentless commit from (current tree + our
# files) and replaces the branch with it. Concurrent publishers are handled
# with --force-with-lease against the commit we started from: if another
# workflow published in between, the lease fails and we start over from its
# snapshot, so its files survive.
#
# Usage:
#   scripts/publish-state.sh <message> <src:dest> [<src:dest> ...]
#
# Example:
#   scripts/publish-state.sh "health: $(date -u +%FT%TZ)" .data/health.json:health.json
#   scripts/publish-state.sh "epg: nightly" guides/:epg/
#
# Requires GITHUB_TOKEN and GITHUB_REPOSITORY in the environment.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <commit-message> <src:dest> [<src:dest> ...]" >&2
  exit 2
fi

MESSAGE="$1"
shift

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

# Overridable so the script can be tested against a local bare repository.
REMOTE="${STATE_REMOTE:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
MAX_ATTEMPTS="${STATE_MAX_ATTEMPTS:-10}"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  WORKDIR="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$WORKDIR'" EXIT

  # Start from the current snapshot when there is one.
  if git clone --quiet --depth 1 --branch state "$REMOTE" "$WORKDIR" 2>/dev/null; then
    BASE="$(git -C "$WORKDIR" rev-parse HEAD)"
  else
    rm -rf "$WORKDIR" && mkdir -p "$WORKDIR"
    git -C "$WORKDIR" init --quiet -b state
    BASE=""
  fi

  git -C "$WORKDIR" config user.name  "github-actions[bot]"
  git -C "$WORKDIR" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

  copied=0
  for pair in "$@"; do
    src="${pair%%:*}"
    dest="${pair#*:}"
    if [ ! -e "$src" ]; then
      echo "skip: $src does not exist"
      continue
    fi
    if [ -d "$src" ]; then
      # Replace the destination directory wholesale so files removed upstream
      # do not linger, but leave every sibling path untouched.
      rm -rf "${WORKDIR:?}/${dest%/}"
      mkdir -p "$WORKDIR/${dest%/}"
      cp -R "$src"/. "$WORKDIR/${dest%/}/"
    else
      mkdir -p "$(dirname "$WORKDIR/$dest")"
      cp "$src" "$WORKDIR/$dest"
    fi
    copied=$((copied + 1))
  done

  if [ "$copied" -eq 0 ]; then
    echo "Nothing to publish"
    exit 0
  fi

  git -C "$WORKDIR" add -A
  TREE="$(git -C "$WORKDIR" write-tree)"

  if [ -n "$BASE" ] && [ "$(git -C "$WORKDIR" rev-parse "$BASE^{tree}")" = "$TREE" ]; then
    echo "State branch already up to date"
    exit 0
  fi

  # A parentless commit: the branch holds exactly one snapshot.
  COMMIT="$(git -C "$WORKDIR" commit-tree "$TREE" -m "$MESSAGE")"

  # Lease on the snapshot we read (empty = the branch must not exist yet).
  if git -C "$WORKDIR" push --quiet --force-with-lease="refs/heads/state:${BASE}" \
      "$REMOTE" "${COMMIT}:refs/heads/state" 2>/dev/null; then
    echo "Published to state branch: $MESSAGE"
    exit 0
  fi

  echo "State branch moved under us (attempt ${attempt}/${MAX_ATTEMPTS}); retrying from the new snapshot"
  rm -rf "$WORKDIR"
  # Randomised backoff so publishers that collided do not collide again.
  sleep $(( (attempt < 5 ? attempt : 5) + RANDOM % 4 ))
done

echo "Could not publish state after ${MAX_ATTEMPTS} attempts" >&2
exit 1
