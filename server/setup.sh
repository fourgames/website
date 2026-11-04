#!/usr/bin/env bash
# First-time setup of a fresh Ubuntu server (Strato VPS S). Run once, as root:
#
#   ssh root@SERVER_IP 'bash -s' < server/setup.sh
#
# Afterwards root and passwords can't log in over SSH: you log in as `fourgames` with your SSH key
# (the one in root's authorized_keys, so add it in Strato or with ssh-copy-id first). Safe to run
# again. See server/README.md.
set -euo pipefail

USER_NAME=fourgames

if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "No SSH key in /root/.ssh/authorized_keys: add yours first (see server/README.md), or you'd be locked out." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
timedatectl set-timezone Europe/Stockholm

echo "== Packages"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg git ufw fail2ban unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

# Node 22 (games.mjs reads the site's ESM config; the repo wants node >= 22.12; Ubuntu ships older).
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

# GitHub CLI (loop.sh starts the site's rebuild with it).
if ! command -v gh >/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q && apt-get install -yq gh
fi

# Caddy: serves the subdomains with free, self-renewing HTTPS certificates (Let's Encrypt).
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

# uv: gets the Python version the workflows use (3.13), whatever Ubuntu ships.
if [ ! -x /usr/local/bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

echo "== Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Reboot by itself at 04:00 when an update needs it (a kernel); the services start again on boot.
cat > /etc/apt/apt.conf.d/52fourgames-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF

echo "== Swap (2 GB of RAM is little for pip and Claude's bigger batches)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== User $USER_NAME"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$USER_NAME"
fi
usermod -aG sudo "$USER_NAME"
# sudo without a password: the account has none, and SSH keys are the only way in.
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-$USER_NAME
chmod 440 /etc/sudoers.d/90-$USER_NAME
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" /home/$USER_NAME/.ssh
cp /root/.ssh/authorized_keys /home/$USER_NAME/.ssh/authorized_keys
chown "$USER_NAME:$USER_NAME" /home/$USER_NAME/.ssh/authorized_keys
chmod 600 /home/$USER_NAME/.ssh/authorized_keys
install -d -o "$USER_NAME" -g "$USER_NAME" /srv/fourgames

echo "== SSH: keys only, no root"
cat > /etc/ssh/sshd_config.d/10-fourgames.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t
systemctl reload ssh || systemctl reload sshd

echo "== Firewall: SSH and web only"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now fail2ban

echo
echo "Done. From now on: ssh $USER_NAME@$(hostname -I | awk '{print $1}')"
echo "Next: server/feedback-setup.sh (see server/README.md)."
