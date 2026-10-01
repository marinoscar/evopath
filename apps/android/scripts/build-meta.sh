#!/usr/bin/env bash
# Prints the Android build's identity and version as key=value lines (for $GITHUB_OUTPUT):
#   product       productName from packages/shared/identity.json
#   slug          productName slugified like @app/shared's APP_SLUG ('Some Name' -> 'some-name')
#   version_name  versionName from apps/android/version.properties
#   version_code  versionCode from apps/android/version.properties
# Run from apps/android. Needs node (preinstalled on GitHub runners).
set -euo pipefail
cd "$(dirname "$0")/.."

node - <<'JS'
const fs = require('node:fs');
const identity = JSON.parse(fs.readFileSync('../../packages/shared/identity.json', 'utf8'));
const props = Object.fromEntries(
  fs.readFileSync('version.properties', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => {
      const i = line.search(/[=:]/);
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);
const slug = identity.productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
if (!/^\d+$/.test(props.versionCode ?? '')) throw new Error('version.properties: versionCode is missing or not a number');
if (!props.versionName) throw new Error('version.properties: versionName is missing');
for (const [key, value] of Object.entries({
  product: identity.productName,
  slug,
  version_name: props.versionName,
  version_code: props.versionCode,
})) {
  if (/[\r\n]/.test(value)) throw new Error(`${key} contains a line break`);
  console.log(`${key}=${value}`);
}
JS
