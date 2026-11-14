#!/bin/sh
set -eu
case "${RENEWED_DOMAINS:-}" in
  *bandbuddy.cn*) /usr/bin/docker exec nginx nginx -t && /usr/bin/docker exec nginx nginx -s reload ;;
esac
