#!/bin/sh
set -eu

exec node "$(dirname "$0")/test-isolated.mjs" "$@"
