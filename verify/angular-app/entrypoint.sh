#!/bin/sh
set -e
cat <<CONFIG > /usr/share/nginx/html/config.js
window.__SEAMLESS_CONFIG__ = { API_URL: "${API_URL}" };
CONFIG
exec nginx -g "daemon off;"
