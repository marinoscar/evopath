import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import type { ParquetColumn } from '../export/parquet-writer.loader';

// =============================================================================
// Test helper: write Parquet with the REAL libraries, in a child process
// (issue #535)
// =============================================================================
//
// `hyparquet-writer` and the `hyparquet` reader are ESM-only, and Jest's
// CommonJS VM cannot `import()` them (test/jest.config.js). This hands the
// columns `buildParquetColumns` produced to a child Node process that writes
// them with `hyparquet-writer` — exactly what `toParquet` does in the built
// API — reads the file back with `hyparquet`, and optionally saves it (so a
// live check can open it with another reader, e.g. DuckDB).
//
// Test-only: excluded from the production build (tsconfig.build.json).
// =============================================================================

const API_ROOT = resolve(__dirname, '../../..');

const SCRIPT = `
import { writeFileSync } from 'node:fs';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { columns, outFile } = JSON.parse(input);
const buffer = parquetWriteBuffer({ columnData: columns });
if (outFile) writeFileSync(outFile, new Uint8Array(buffer));
const rows = await parquetReadObjects({ file: buffer });
const types = parquetMetadata(buffer).schema.slice(1).map((e) => [e.name, e.type, e.converted_type ?? null]);
process.stdout.write(JSON.stringify({ bytes: buffer.byteLength, rows, types }));
`;

export interface ParquetRoundTrip {
  bytes: number;
  rows: Record<string, unknown>[];
  /** `[name, physical type, converted type | null]` per column. */
  types: unknown[][];
}

export function parquetRoundTrip(columns: ParquetColumn[], outFile?: string): ParquetRoundTrip {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: API_ROOT,
    input: JSON.stringify({ columns, outFile }),
    encoding: 'utf8',
    timeout: 20_000,
  });

  if (child.status !== 0) {
    throw new Error(`parquet child process failed: ${child.stderr || child.error?.message}`);
  }

  return JSON.parse(child.stdout) as ParquetRoundTrip;
}
