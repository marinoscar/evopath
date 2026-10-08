#!/usr/bin/env node
/**
 * Platform CLI Environment Helper
 *
 * Runs the `platform` command (@marinoscar/platform-db) with DATABASE_URL
 * built from the individual POSTGRES_* variables, exactly as
 * scripts/prisma-env.js does for the Prisma CLI. Use it for every platform
 * command that talks to the database (`db drift`, `db check --database`).
 *
 * Usage:
 *   node scripts/platform-env.js db drift
 *   node scripts/platform-env.js db check --database
 */

const { spawn } = require('child_process');

// Requiring prisma-env loads the same .env files and exports the one
// DATABASE_URL builder; it does not run Prisma (it only runs when invoked directly).
const { constructDatabaseUrl } = require('./prisma-env');

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Error: No platform command specified');
    console.error('Usage: node scripts/platform-env.js db drift');
    process.exit(1);
  }

  const child = spawn('npx', ['--no-install', 'platform', ...args], {
    env: { ...process.env, DATABASE_URL: constructDatabaseUrl() },
    stdio: 'inherit',
    shell: true,
  });
  child.on('exit', (code) => process.exit(code || 0));
  child.on('error', (err) => {
    console.error('Failed to execute platform command:', err);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}
