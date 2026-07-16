#!/bin/sh
set -e

# Named volumes mount root-owned, shadowing the image's /data ownership.
# Fix it while still root, then drop privileges for everything else.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R donkai:donkai /data
  exec runuser -u donkai -- "$0" "$@"
fi

# gh reads GH_TOKEN from env natively; wire git to use gh as its credential
# helper so workers can clone/push private HTTPS remotes without prompts.
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || echo "warn: gh auth setup-git failed"
fi

git config --global user.name "${GIT_AUTHOR_NAME:-Donkai}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-donkai@localhost}"
git config --global init.defaultBranch main

exec "$@"
