#!/usr/bin/env bash
# 서버에서 실행. Actions 가 /tmp/raddit-dev-<sha>.tgz 를 올린 뒤 호출한다.
#   sudo /opt/raddit-dev/deploy.sh /tmp/raddit-dev-<sha>.tgz
set -euo pipefail
BUNDLE="$1"
ROOT=/opt/raddit-dev
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
chown -R raddit:raddit "$ROOT/web" "$ROOT/reddit" 2>/dev/null || true
rm -rf "$STAGE" "$BUNDLE"

systemctl restart raddit-reddit-dev raddit-web-dev
for i in $(seq 1 30); do
  curl -fsS -o /dev/null http://127.0.0.1:4321/ && { echo "web healthy"; exit 0; }
  sleep 1
done
echo "web did not become healthy" >&2
journalctl -u raddit-web-dev -n 40 --no-pager >&2
exit 1
