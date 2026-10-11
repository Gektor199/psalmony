#!/usr/bin/env bash
# Integration check against disposable Docker resources, never working data.
set -euo pipefail
umask 077
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/backup-common.sh"
fixture_image=${1:-psalmony-psalmony:latest}
docker image inspect "$fixture_image" >/dev/null
work=$(mktemp -d "${TMPDIR:-/tmp}/psalmony-backup-test-XXXXXXXX")
project=$(basename "$work" | tr '[:upper:]' '[:lower:]')
export PSALMONY_BACKUP_TEST_IMAGE="$fixture_image"
compose=(docker compose -p "$project" --env-file /dev/null -f "$work/compose.yaml")
created=0
cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if ((created)); then "${compose[@]}" down --volumes --timeout 5 >/dev/null || status=1; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || backup_fail 'Fixture project collision'
for volume in "${project}_database" "${project}_attachments"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then backup_fail 'Fixture volume collision'; fi
done
cat > "$work/compose.yaml" <<'YAML'
services:
  psalmony:
    image: ${PSALMONY_BACKUP_TEST_IMAGE:?}
    environment:
      DATABASE_URL: postgres://psalmony:isolated-test@postgres:5432/psalmony
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - attachments:/app/data
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3180/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 3s
      retries: 60
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: psalmony
      POSTGRES_DB: psalmony
      POSTGRES_PASSWORD: isolated-test
    volumes:
      - database:/var/lib/postgresql/data
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U psalmony -d psalmony"]
      interval: 1s
      timeout: 2s
      retries: 60
volumes:
  database:
  attachments:
networks:
  default:
    internal: true
YAML
created=1
"${compose[@]}" up -d --wait --wait-timeout 90 >/dev/null
app_id=$("${compose[@]}" ps -q psalmony)
pg_id=$("${compose[@]}" ps -q postgres)
docker exec "$app_id" sh -c 'printf "file\n" > /app/data/files/backup-fixture-file; printf "image\n" > /app/data/images/backup-fixture-image; chmod 600 /app/data/files/backup-fixture-file /app/data/images/backup-fixture-image'
backup_psql "$pg_id" <<'SQL'
INSERT INTO users(id,email,name,guest,login) VALUES ('backup-fixture-user','backup@example.invalid','Backup fixture',0,'backup-fixture');
INSERT INTO bands(id,state,revision) VALUES ('backup-fixture-band','{"bandName":"Restore fixture","songs":[],"setlists":[],"activity":[]}',7);
INSERT INTO members(band,"user",role) VALUES ('backup-fixture-band','backup-fixture-user','owner');
INSERT INTO files(id,band,name,mime,size) VALUES ('backup-fixture-file','backup-fixture-band','sample.pdf','application/pdf',5);
INSERT INTO images(id,band,size) VALUES ('backup-fixture-image','backup-fixture-band',6);
SQL
backup_args=(--compose-file "$work/compose.yaml" --env-file /dev/null --project-name "$project" --output-dir "$work/backups")
backup=$("$script_dir/backup.sh" "${backup_args[@]}")
[[ "$(docker inspect -f '{{.State.Running}}' "$app_id")" = true ]] || backup_fail 'Backup did not resume its app'
"$script_dir/restore-check.sh" --backup "$backup"
# Recreate the application container while retaining this fixture's two volumes.
# Verify persisted DB content and attachment bytes before any failure injection.
previous_app_id=$app_id
"${compose[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 90 psalmony >/dev/null
app_id=$("${compose[@]}" ps -q psalmony)
[[ "$app_id" != "$previous_app_id" ]] || backup_fail 'Application container was not recreated'
backup_db_inventory "$pg_id" > "$work/recreated-database.jsonl"
cmp -s "$backup/database-inventory.jsonl" "$work/recreated-database.jsonl" || backup_fail 'Database changed after application recreation'
docker exec "$app_id" sh -c 'cd /app/data; find . -type f -exec sha256sum {} \; | LC_ALL=C sort' > "$work/recreated-files.sha256"
cmp -s "$backup/files.sha256" "$work/recreated-files.sha256" || backup_fail 'Attachments changed after application recreation'
printf 'PERSISTENCE CHECK PASSED: replacement application healthy; all database rows and attachment bytes preserved.\n'
# Starting from a stopped application must leave it stopped.
docker stop -t 5 "$app_id" >/dev/null
"$script_dir/backup.sh" "${backup_args[@]}" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$app_id")" = false ]] || backup_fail 'Backup started an originally stopped app'
docker start "$app_id" >/dev/null
# A failed backup must resume the app and must never become a complete copy.
docker exec "$app_id" rm /app/data/files/backup-fixture-file
if "$script_dir/backup.sh" "${backup_args[@]}" > "$work/failure.out" 2> "$work/failure.err"; then backup_fail 'Missing attachment was not detected'; fi
[[ "$(docker inspect -f '{{.State.Running}}' "$app_id")" = true ]] || backup_fail 'Failure trap did not resume the app'
[[ ! -s "$work/failure.out" ]] || backup_fail 'Failed backup claimed a complete path'
grep -q 'Missing referenced attachment' "$work/failure.err" || backup_fail 'Backup failed for an unexpected reason'
# Reject corrupt bytes before creating a restore project.
cp -R "$backup" "$work/corrupted"
printf corruption >> "$work/corrupted/attachments.tar.gz"
if "$script_dir/restore-check.sh" --backup "$work/corrupted" > "$work/corruption.out" 2> "$work/corruption.err"; then backup_fail 'Corrupted archive was accepted'; fi
grep -q 'Backup checksum mismatch' "$work/corruption.err" || backup_fail 'Wrong corruption failure'
# A failure after pg_restore must still remove its own containers and volumes.
cp -R "$backup" "$work/mismatch"
printf '\n{"test":"mismatch"}\n' >> "$work/mismatch/database-inventory.jsonl"
(
  cd "$work/mismatch"
  backup_sha256 database.dump attachments.tar.gz database-inventory.jsonl file-references.tsv files.sha256 manifest.json > SHA256SUMS
)
if "$script_dir/restore-check.sh" --backup "$work/mismatch" > "$work/mismatch.out" 2> "$work/mismatch.err"; then backup_fail 'Database inventory mismatch was accepted'; fi
grep -q 'Restored database content differs' "$work/mismatch.err" || backup_fail 'Wrong restore failure'
failed_project=$(sed -n 's/^Restoring into isolated project \([a-z0-9-]*\) (network disabled).$/\1/p' "$work/mismatch.err")
[[ "$failed_project" = psalmony-restore-* ]] || backup_fail 'Could not identify failed test project'
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$failed_project")" ]] || backup_fail 'Failed restore left a container'
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$failed_project")" ]] || backup_fail 'Failed restore left a volume'
printf 'BACKUP SMOKE PASSED: populated restore; app recreation persistence; running/stopped state; failure restart; corrupt archive rejected; failed restore cleaned up.\n'
