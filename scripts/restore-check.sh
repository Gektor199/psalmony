#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-common.sh
source "$script_dir/backup-common.sh"
usage() {
  cat <<'HELP'
Usage: scripts/restore-check.sh --backup PATH
Restores a trusted backup into a new PostgreSQL 17 Compose project with new
volumes and no network/ports. Compares all public tables and attachment bytes,
then deletes only this check's isolated resources. Never accepts a target DB,
production Compose file, volume or project. Requires the postgres:17-alpine image.
HELP
}
backup=''
while (($#)); do
  case "$1" in
    --backup) (($# >= 2)) || backup_fail 'Missing backup path'; backup=$2; shift 2;;
    -h|--help) usage; exit 0;;
    *) backup_fail "Unknown option: $1";;
  esac
done
[[ -d "$backup" ]] || { usage >&2; exit 1; }
backup=$(cd "$backup" && pwd)
[[ "$(basename "$backup")" != .incomplete-* ]] || backup_fail 'Incomplete backups cannot be restored'
expected_files=(database.dump attachments.tar.gz database-inventory.jsonl file-references.tsv files.sha256 manifest.json)
for item in "${expected_files[@]}" SHA256SUMS; do
  [[ -f "$backup/$item" && ! -L "$backup/$item" ]] || backup_fail "Missing or unsafe backup file: $item"
done
# Do not trust paths in SHA256SUMS: generate the exact fixed list and compare.
actual_sums=$(cd "$backup" && backup_sha256 "${expected_files[@]}")
[[ "$actual_sums" = "$(cat "$backup/SHA256SUMS")" ]] || backup_fail 'Backup checksum mismatch'
grep -Eq '"format": "psalmony-backup-v1"' "$backup/manifest.json" || backup_fail 'Unsupported manifest format'
grep -Eq '"postgresVersionNum": "17[0-9]{4}"' "$backup/manifest.json" || backup_fail 'Unsupported PostgreSQL version'
docker info >/dev/null
docker image inspect postgres:17-alpine >/dev/null
work=$(mktemp -d "${TMPDIR:-/tmp}/psalmony-restore-XXXXXXXX")
project=$(basename "$work" | tr '[:upper:]' '[:lower:]')
compose=(docker compose --project-name "$project" --env-file /dev/null -f "$work/compose.yaml")
created=0
cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if ((created)); then
    # This generated file has only two newly named, non-external volumes.
    # No production Compose file or resource name can be supplied by the caller.
    if ! "${compose[@]}" down --volumes --timeout 5 >/dev/null; then
      backup_log "ERROR: Could not remove isolated check project $project; inspect it manually."
      status=1
    fi
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || backup_fail 'Restore project collision'
for volume in "${project}_database" "${project}_attachments"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then backup_fail 'Restore volume collision'; fi
done
cat > "$work/compose.yaml" <<'YAML'
services:
  postgres:
    image: postgres:17-alpine
    network_mode: none
    environment:
      POSTGRES_USER: restore_check
      POSTGRES_DB: restore_check
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - database:/var/lib/postgresql/data
      - attachments:/snapshot
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U restore_check -d restore_check"]
      interval: 1s
      timeout: 2s
      retries: 60
volumes:
  database:
  attachments:
YAML
created=1
backup_log "Restoring into isolated project $project (network disabled)."
"${compose[@]}" up -d --wait --wait-timeout 90 >/dev/null
pg_id=$("${compose[@]}" ps -q postgres)
docker exec -i "$pg_id" pg_restore --username=restore_check --dbname=restore_check --exit-on-error --single-transaction --no-owner --no-acl < "$backup/database.dump"
# Inspect archive entries before extracting, and accept only regular files/dirs.
docker exec -i "$pg_id" sh -c 'set -eu; cat > /tmp/attachments.tar.gz; tar -tzf /tmp/attachments.tar.gz > /tmp/entries; tar -tvzf /tmp/attachments.tar.gz > /tmp/details; if grep -Ev "^\./([a-zA-Z0-9_.-]+/?)*$" /tmp/entries >/dev/null || grep -E "(^|/)\.\.(/|$)" /tmp/entries >/dev/null || grep -Ev "^[-d]" /tmp/details >/dev/null; then echo "Unsafe archive entries" >&2; exit 1; fi; tar -xzf /tmp/attachments.tar.gz -C /snapshot; rm /tmp/attachments.tar.gz' < "$backup/attachments.tar.gz"
backup_db_inventory "$pg_id" > "$work/database-inventory.jsonl"
cmp -s "$backup/database-inventory.jsonl" "$work/database-inventory.jsonl" || backup_fail 'Restored database content differs'
backup_db_references "$pg_id" > "$work/file-references.tsv"
cmp -s "$backup/file-references.tsv" "$work/file-references.tsv" || backup_fail 'Restored attachment references differ'
docker exec "$pg_id" sh -c "$backup_files_script" > "$work/files.sha256"
cmp -s "$backup/files.sha256" "$work/files.sha256" || backup_fail 'Restored attachment bytes differ'
docker exec -i --user 1000:1000 "$pg_id" sh -c "$backup_references_script" < "$work/file-references.tsv"
docker exec --user 1000:1000 "$pg_id" sh -c 'set -eu; for directory in /snapshot/files /snapshot/images; do probe=$(mktemp "$directory/.restore-check-XXXXXX"); rm "$probe"; done'
tables=$(wc -l < "$work/database-inventory.jsonl" | tr -d ' ')
files=$(wc -l < "$work/files.sha256" | tr -d ' ')
printf 'RESTORE CHECK PASSED: %s tables; %s files; database content, SHA-256 and referenced sizes match; UID 1000 can read attachments.\n' "$tables" "$files"
