#!/usr/bin/env bash
# 서버에서 실행. Actions 가 번들을 /tmp 에 올린 뒤 호출한다.
#   sudo /opt/raddit/deploy.sh <dev|prod> /tmp/raddit-<env>-<sha>.tgz
set -euo pipefail
ENV="${1:-}"; BUNDLE="${2:-}"
case "$ENV" in dev|prod) ;; *) echo "env must be dev|prod" >&2; exit 2 ;; esac
case "$BUNDLE" in /tmp/raddit-"$ENV"-*.tgz) ;; *) echo "bad bundle path" >&2; exit 2 ;; esac
[ -f "$BUNDLE" ] || { echo "bundle not found" >&2; exit 2; }

ROOT=/opt/raddit-$ENV
WEB_PORT=$(grep -E '^WEB_PORT=' /etc/raddit/$ENV.env | cut -d= -f2)
STAGE=$(mktemp -d)
tar -xzf "$BUNDLE" -C "$STAGE"

# web: Actions 가 빌드·prune 한 dist + node_modules
if [ -d "$STAGE/web" ]; then
  rm -rf "$ROOT/web.prev"; [ -d "$ROOT/web" ] && mv "$ROOT/web" "$ROOT/web.prev"
  mv "$STAGE/web" "$ROOT/web"
fi
# reddit: 코드 + 의존성
if [ -d "$STAGE/reddit" ]; then
  "$ROOT/venv/bin/pip" install -q -r "$STAGE/reddit/requirements.txt"
  rm -rf "$ROOT/reddit"; mv "$STAGE/reddit" "$ROOT/reddit"
fi
chown -R raddit:raddit "$ROOT/web" "$ROOT/reddit"
rm -rf "$STAGE" "$BUNDLE"

systemctl restart "raddit-reddit@$ENV" "raddit-web@$ENV"
for i in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/" && { echo "web@$ENV healthy"; exit 0; }
  sleep 1
done
echo "web@$ENV did not become healthy" >&2
journalctl -u "raddit-web@$ENV" -n 40 --no-pager >&2
exit 1
