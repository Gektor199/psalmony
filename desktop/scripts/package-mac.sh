#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$project_root/desktop"
../node_modules/.bin/tauri build --target universal-apple-darwin --bundles app
app_path="$project_root/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Psalmony.app"
codesign --verify --deep --strict "$app_path"
package_stage="$(mktemp -d /tmp/psalmony-package.XXXXXX)"
trap 'rm -rf "$package_stage"' EXIT
ditto "$app_path" "$package_stage/Psalmony.app"
ln -s /Applications "$package_stage/Applications"
mkdir -p "$project_root/releases"
hdiutil create -volname Psalmony -srcfolder "$package_stage" -format UDZO -ov "$project_root/releases/Psalmony-0.4.2-mac-universal.dmg"
hdiutil verify "$project_root/releases/Psalmony-0.4.2-mac-universal.dmg"
