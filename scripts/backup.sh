#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-common.sh
source "$script_dir/backup-common.sh"
usage() {
  cat <<'HELP'
Usage: scripts/backup.sh --output-dir PATH [--compose-file FILE ...]
       [--env-file FILE] [--project-name NAME]
Run from the repository root. Defaults to compose.yaml. Requires Docker Compose
and a running PostgreSQL 17 service. Briefly stops only the psalmony writer.
Outputs one complete backup directory; .incomplete directories are not backups.
HELP
}
compose=(docker compose)
compose_files=0
output=''
while (($#)); do
  case "$1" in
    --compose-file|--env-file|--project-name|--output-dir)
      (($# >= 2)) || backup_fail "Missing value for $1"
      case "$1" in
        --compose-file) compose+=(-f "$2"); compose_files=$((compose_files + 1));;
        --env-file) compose+=(--env-file "$2");;
        --project-name) compose+=(-p "$2");;
        --output-dir) output=$2;;
      esac
      shift 2;;
    -h|--help) usage; exit 0;;
    *) backup_fail "Unknown option: $1";;
  esac
done
[[ -n "$output" ]] || { usage >&2; exit 1; }
((compose_files)) || compose+=(-f compose.yaml)
docker info >/dev/null
app_id=$("${compose[@]}" ps -a -q psalmony)
pg_id=$("${compose[@]}" ps -q postgres)
[[ "$app_id" =~ ^[a-f0-9]+$ && "$pg_id" =~ ^[a-f0-9]+$ ]] || backup_fail 'Expected exactly one psalmony container and one running postgres container'
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$app_id")
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || backup_fail 'Unexpected Compose project name'
[[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$pg_id")" = "$project" ]] || backup_fail 'App and PostgreSQL projects differ'
[[ "$(docker inspect -f '{{.State.Running}}' "$pg_id")" = true ]] || backup_fail 'PostgreSQL must be running'
data_volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "$app_id")
[[ "$data_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || backup_fail 'Expected a named attachment volume at /app/data'
# Refuse another running container writing the same attachment volume.
while IFS= read -r other; do
  [[ "$other" = "$app_id" ]] && continue
  if docker inspect -f '{{range .Mounts}}{{if .RW}}{{.Name}}{{println}}{{end}}{{end}}' "$other" | grep -Fx "$data_volume" >/dev/null; then
    backup_fail 'Another running container can write the attachment volume'
  fi
done < <(docker ps -q --no-trunc --filter "volume=$data_volume")
app_image=$(docker inspect -f '{{.Image}}' "$app_id")
pg_image=$(docker inspect -f '{{.Image}}' "$pg_id")
pg_version=$(printf 'SHOW server_version_num;\n' | backup_psql "$pg_id")
[[ "$pg_version" =~ ^17[0-9]{4}$ ]] || backup_fail 'This backup format currently supports PostgreSQL 17 only'
app_running=$(docker inspect -f '{{.State.Running}}' "$app_id")
app_status=$(docker inspect -f '{{.State.Status}}' "$app_id")
[[ "$app_status" = running || "$app_status" = exited || "$app_status" = created ]] || backup_fail "App state is not stable: $app_status"
[[ "$(docker inspect -f '{{.State.Paused}}' "$app_id")" = false ]] || backup_fail 'Unpause the app before backup'
mkdir -p "$output"
output=$(cd "$output" && pwd)
lock="${TMPDIR:-/tmp}/psalmony-backup-$project.lock"
mkdir "$lock" 2>/dev/null || backup_fail "Backup lock exists: $lock"
restart_app=0
helper=''
cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  [[ -z "$helper" ]] || docker rm -f "$helper" >/dev/null 2>&1 || true
  if ((restart_app)); then
    backup_log 'Restarting the original application container.'
    if ! docker start "$app_id" >/dev/null; then
      backup_log "ERROR: Restart failed; operator must start container $app_id"
      status=1
    fi
  fi
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
stage=$(mktemp -d "$output/.incomplete-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
helper="psalmony-backup-helper-$(basename "$stage" | tr '[:upper:].' '[:lower:]-')"
if [[ "$app_running" = true ]]; then
  restart_app=1
  backup_log 'Stopping the application writer for a consistent database + file snapshot.'
  docker stop -t 60 "$app_id" >/dev/null
fi
snapshot_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
backup_db_inventory "$pg_id" > "$stage/database-inventory.jsonl"
backup_db_references "$pg_id" > "$stage/file-references.tsv"
docker exec "$pg_id" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$stage/database.dump"
docker run --rm --name "$helper" --network none --user 0:0 --mount "type=volume,src=$data_volume,dst=/snapshot,readonly" --entrypoint sh "$pg_image" -c "$backup_files_script" > "$stage/files.sha256"
docker run --rm -i --name "$helper" --network none --user 1000:1000 --mount "type=volume,src=$data_volume,dst=/snapshot,readonly" --entrypoint sh "$pg_image" -c "$backup_references_script" < "$stage/file-references.tsv"
docker run --rm --name "$helper" --network none --user 0:0 --mount "type=volume,src=$data_volume,dst=/snapshot,readonly" --entrypoint tar "$pg_image" -czf - -C /snapshot . > "$stage/attachments.tar.gz"
backup_db_inventory "$pg_id" > "$stage/database-after.jsonl"
cmp -s "$stage/database-inventory.jsonl" "$stage/database-after.jsonl" || backup_fail 'Database changed during backup; stop all other writers and retry'
rm "$stage/database-after.jsonl"
printf '{\n  "format": "psalmony-backup-v1",\n  "snapshotUtc": "%s",\n  "project": "%s",\n  "postgresVersionNum": "%s",\n  "appImage": "%s",\n  "postgresImage": "%s",\n  "attachmentVolume": "%s",\n  "appWasRunning": %s,\n  "attachmentUid": 1000\n}\n' "$snapshot_at" "$project" "$pg_version" "$app_image" "$pg_image" "$data_volume" "$app_running" > "$stage/manifest.json"
# Resume service before checksumming potentially large archives.
if ((restart_app)); then
  docker start "$app_id" >/dev/null
  restart_app=0
fi
(
  cd "$stage"
  backup_sha256 database.dump attachments.tar.gz database-inventory.jsonl file-references.tsv files.sha256 manifest.json > SHA256SUMS
)
destination="$output/backup-${stage##*/.incomplete-}"
mv "$stage" "$destination"
backup_log 'Backup complete. Run restore-check.sh before relying on it.'
printf '%s\n' "$destination"
