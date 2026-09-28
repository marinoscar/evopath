// =============================================================================
// Loading `hyparquet-writer` from CommonJS (issue #535)
// =============================================================================
//
// `hyparquet-writer` is ESM-only. The API compiles to CommonJS with
// `module: NodeNext`, under which TypeScript leaves a dynamic `import()` in a
// CommonJS file AS A REAL `import()` (it does not rewrite it to `require`), so
// this works in the built API on any supported Node — verified against the
// compiled output.
//
// It is isolated in this one-function module for Jest: Jest runs specs in a
// CommonJS VM that rejects a native `import()` (see test/jest.config.js), so a
// spec `jest.mock`s this file instead of the package. The real writer is
// exercised by `telemetry-export.parquet.spec.ts`, in a child Node process.
//
// Loaded on first use and memoised: most deployments never export Parquet.
// =============================================================================

export interface ParquetColumn {
  name: string;
  data: unknown[];
  type: 'BOOLEAN' | 'DOUBLE' | 'STRING';
  nullable?: boolean;
}

export interface ParquetWriterModule {
  parquetWriteBuffer(options: { columnData: ParquetColumn[] }): ArrayBuffer;
}

let loading: Promise<ParquetWriterModule> | null = null;

export function loadParquetWriter(): Promise<ParquetWriterModule> {
  loading ??= (import('hyparquet-writer') as unknown as Promise<ParquetWriterModule>).catch((error: unknown) => {
    loading = null;
    throw error;
  });

  return loading;
}
