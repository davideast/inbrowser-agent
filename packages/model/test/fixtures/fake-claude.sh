#!/usr/bin/env bash
# Fake `claude` executable for claude-cli provider tests.
# Behavior is driven entirely by environment variables so each test
# can configure its own scenario without a separate script:
#
#   FAKE_ARGS_FILE   — write received argv (one arg per line) here
#   FAKE_STDIN_FILE  — write received stdin here (otherwise drained)
#   FAKE_STDERR      — emit this string on stderr
#   FAKE_SLEEP_SECS  — sleep before producing output (timeout tests)
#   FAKE_OUTPUT_FILE — cat this NDJSON file to stdout
#   FAKE_EXIT_CODE   — exit code (default 0)
set -u
if [ -n "${FAKE_ARGS_FILE:-}" ]; then
  printf '%s\n' "$@" > "$FAKE_ARGS_FILE"
fi
if [ -n "${FAKE_STDIN_FILE:-}" ]; then
  cat > "$FAKE_STDIN_FILE"
else
  cat > /dev/null
fi
if [ -n "${FAKE_STDERR:-}" ]; then
  printf '%s' "$FAKE_STDERR" >&2
fi
if [ -n "${FAKE_SLEEP_SECS:-}" ]; then
  sleep "$FAKE_SLEEP_SECS"
fi
if [ -n "${FAKE_OUTPUT_FILE:-}" ]; then
  cat "$FAKE_OUTPUT_FILE"
fi
exit "${FAKE_EXIT_CODE:-0}"
