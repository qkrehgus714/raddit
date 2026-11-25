#!/usr/bin/env bash
# Lightsail(Ubuntu 24.04) 최초 1회 설치. 루트로 실행: sudo bash setup.sh
# 이후 배포는 GitHub Actions(deploy.yml)가 deploy.sh 를 호출한다.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

# Node 22 · Python venv · Caddy
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y python3-venv debian-keyring debian-archive-keyring apt-transport-https curl gpg
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

# 실행 계정 · 디렉터리
id raddit >/dev/null 2>&1 || useradd -r -m -d /var/lib/raddit -s /usr/sbin/nologin raddit
install -d -o raddit -g raddit /opt/raddit-dev /var/lib/raddit/dev
[ -x /opt/raddit-dev/venv/bin/pip ] || python3 -m venv /opt/raddit-dev/venv
chown -R raddit:raddit /opt/raddit-dev/venv
install -m 755 "$HERE/deploy.sh" /opt/raddit-dev/deploy.sh

# 환경변수 (값은 서버에서 직접 채운다 — 저장소에 두지 않음)
install -d -m 750 /etc/raddit
[ -f /etc/raddit/dev.env ] || install -m 640 -g raddit "$HERE/dev.env.example" /etc/raddit/dev.env

install -m 644 "$HERE/raddit-web-dev.service" "$HERE/raddit-reddit-dev.service" /etc/systemd/system/
install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable raddit-web-dev raddit-reddit-dev
systemctl reload-or-restart caddy
echo "setup done — /etc/raddit/dev.env 를 채운 뒤 첫 배포를 실행하세요"

# 배포 전용 계정: Actions 는 이 계정으로 접속해 deploy.sh 만 sudo 로 실행할 수 있다
id raddit-deploy >/dev/null 2>&1 || useradd -m -s /bin/bash raddit-deploy
install -d -m 700 -o raddit-deploy -g raddit-deploy /home/raddit-deploy/.ssh
echo 'raddit-deploy ALL=(root) NOPASSWD: /opt/raddit-dev/deploy.sh' > /etc/sudoers.d/raddit-deploy
chmod 440 /etc/sudoers.d/raddit-deploy
visudo -cf /etc/sudoers.d/raddit-deploy
