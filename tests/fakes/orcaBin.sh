#!/usr/bin/env bash
# tests/fakes/orcaBin.sh — canned envelopes for src/orca/cli.ts tests. Never calls the real orca binary.
case "$1 $2" in
  "status --json"|"status ") echo '{"id":"x","ok":true,"result":{"app":{"running":true},"runtime":{"state":"ready"}}}';;
  "orchestration task-list") echo '{"id":"x","ok":false,"error":{"code":"run_required","message":"No Run is bound."}}'; exit 1;;
  "hang "*) sleep 5;;
  *) echo "boom" >&2; exit 3;;
esac
