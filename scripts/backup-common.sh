#!/usr/bin/env bash
# Shared implementation for backup.sh and restore-check.sh. Never source .env.
backup_fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
backup_log() { printf '%s\n' "$*" >&2; }
backup_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@";
  else shasum -a 256 "$@"; fi
}
backup_psql() {
  docker exec -i "$1" sh -c 'export PGOPTIONS="-c timezone=UTC -c extra_float_digits=3"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}
backup_db_inventory() {
  backup_psql "$1" <<'SQL'
SELECT format('SELECT json_build_object(''table'', %L, ''rows'', count(*), ''content_md5'', md5(COALESCE(string_agg(h, '''' ORDER BY h COLLATE "C"), '''')))::text FROM (SELECT md5(row_to_json(t)::text) h FROM %I.%I t) s;', schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename COLLATE "C"
\gexec
SQL
}
backup_db_references() {
  backup_psql "$1" <<'SQL'
SELECT reference FROM (
  SELECT 'files/' || id || E'\t' || size AS reference FROM files
  UNION ALL SELECT 'images/' || id || E'\t' || size FROM images
) refs ORDER BY reference COLLATE "C";
SQL
}
# Execute with a read-only /snapshot mount. Reject special files and ambiguous
# paths so inventories and tar extraction cannot silently follow links.
backup_files_script='set -eu
cd /snapshot
find . ! -type f ! -type d > /tmp/special-files
test ! -s /tmp/special-files || { echo "Special files in attachment volume" >&2; exit 1; }
find . -type f > /tmp/file-list
if grep -Ev "^\./[a-zA-Z0-9_./-]+$" /tmp/file-list >/dev/null; then
  echo "Unsupported attachment path" >&2; exit 1
fi
find . -type f -exec sha256sum {} \; | LC_ALL=C sort'
backup_references_script='set -eu
tab=$(printf "\t")
while IFS="$tab" read -r relative size; do
  case "$relative" in files/*|images/*) ;; *) echo "Invalid file reference" >&2; exit 1;; esac
  id=${relative#*/}
  case "$id" in ""|*[!a-zA-Z0-9_-]*) echo "Invalid file id" >&2; exit 1;; esac
  case "$size" in ""|*[!0-9]*) echo "Invalid file size" >&2; exit 1;; esac
  test -f "/snapshot/$relative" && test ! -L "/snapshot/$relative" || { echo "Missing referenced attachment" >&2; exit 1; }
  test "$(stat -c %s "/snapshot/$relative")" = "$size" || { echo "Attachment size mismatch" >&2; exit 1; }
  test -r "/snapshot/$relative" || { echo "Attachment unreadable by UID 1000" >&2; exit 1; }
done'
