#!/usr/bin/env bash
# Sets up the player feedback loop on the server, after setup.sh. Run as fourgames, on the server:
#
#   curl -fsSL https://raw.githubusercontent.com/fourgames/website/main/server/feedback-setup.sh | bash
#
# Run it again after each step it stops at (adding the deploy key, filling in the secrets); it
# carries on from there. It never starts the services: that's the switch-over in server/README.md,
# so the server and GitHub Actions never collect at the same time.
set -euo pipefail

ROOT=/srv/fourgames
KEY=$HOME/.ssh/feedback_data
ENV=/etc/fourgames/feedback.env
SITE_REPO=https://github.com/fourgames/website.git
DATA_REPO=git@github-feedback-data:fourgames/feedback-data.git

[ "$(id -un)" = fourgames ] || { echo "Run this as fourgames, not $(id -un)." >&2; exit 1; }

echo "== The website code, one checkout per part"
for part in own research; do
  if [ ! -d "$ROOT/$part/.git" ]; then
    git clone -q "$SITE_REPO" "$ROOT/$part"
  fi
done
SRC=$ROOT/own/server

echo "== Deploy key for fourgames/feedback-data"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "fourgames-server feedback-data" -q
fi
if ! grep -q "Host github-feedback-data" "$HOME/.ssh/config" 2>/dev/null; then
  cat >> "$HOME/.ssh/config" <<EOF
Host github-feedback-data
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 "$HOME/.ssh/config"
fi
ssh-keygen -F github.com >/dev/null || ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
if ! git ls-remote "$DATA_REPO" >/dev/null 2>&1; then
  echo
  echo "Add this key to fourgames/feedback-data → Settings → Deploy keys → Add deploy key,"
  echo "title \"Server\", with \"Allow write access\" ticked:"
  echo
  cat "$KEY.pub"
  echo
  echo "Then run this script again."
  exit 0
fi

echo "== The data, in each checkout"
for part in own research; do
  if [ ! -d "$ROOT/$part/feedback/data/.git" ]; then
    git clone -q "$DATA_REPO" "$ROOT/$part/feedback/data"
  fi
  # Who the data commits are from.
  git -C "$ROOT/$part/feedback/data" config user.name "Four Games server"
  git -C "$ROOT/$part/feedback/data" config user.email "server@fourgames.se"
done

echo "== Python 3.13 and the feedback dependencies"
[ -x "$ROOT/venv/bin/python" ] || uv venv -q --python 3.13 "$ROOT/venv"
uv pip install -q --python "$ROOT/venv/bin/python" -r "$ROOT/own/feedback/requirements.txt"

echo "== Secrets"
if [ ! -f "$ENV" ]; then
  sudo install -d -m 750 -o root -g fourgames /etc/fourgames
  sudo install -m 640 -o root -g fourgames "$SRC/feedback.env.example" "$ENV"
fi
if grep -qE '^(ANTHROPIC_API_KEY|STEAM_PUBLISHER_KEY|GH_TOKEN)=$' "$ENV"; then
  echo
  echo "Fill in the secrets: sudo nano $ENV"
  echo "Then run this script again."
  exit 0
fi

echo "== Services (installed, not started)"
sudo install -m 644 "$SRC/feedback@.service" /etc/systemd/system/feedback@.service
sudo install -d /etc/systemd/system/feedback@research.service.d
sudo install -m 644 "$SRC/feedback@research.service.d/override.conf" /etc/systemd/system/feedback@research.service.d/override.conf
sudo systemctl daemon-reload

echo "== Checks (nothing is collected or sent)"
cd "$ROOT/own"
node feedback/games.mjs >/dev/null && echo "node: reads the game list"
"$ROOT/venv/bin/python" -c "import anthropic, pydantic, bs4, youtube_transcript_api" && echo "python: dependencies load"
GH_TOKEN=$(sudo sed -n 's/^GH_TOKEN=//p' "$ENV") gh api repos/fourgames/website/actions/workflows/static.yml --jq '"gh: token can see " + .name'
git -C feedback/data push --dry-run -q origin HEAD:main && echo "data: deploy key can push"

echo
echo "Ready. Next: the switch-over in server/README.md."
