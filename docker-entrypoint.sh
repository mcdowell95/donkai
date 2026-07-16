#!/bin/sh
set -e

# gh reads GH_TOKEN from env natively; wire git to use gh as its credential
# helper so workers can clone/push private HTTPS remotes without prompts.
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null || echo "warn: gh auth setup-git failed"
fi

git config --global user.name "${GIT_AUTHOR_NAME:-Donkai}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-donkai@localhost}"
git config --global init.defaultBranch main

exec "$@"
