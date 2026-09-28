/**
 * The Telemetry Explorer's SQL editor — issue #537, epic #528.
 *
 * CodeMirror 6 (`@uiw/react-codemirror` + `@codemirror/lang-sql`), PostgreSQL
 * dialect (GreptimeDB speaks the PostgreSQL wire protocol and dialect), with
 * autocompletion fed from `GET /admin/telemetry/schema`. The theme follows the
 * MUI palette mode. Ctrl/Cmd+Enter runs the query.
 *
 * This module is the ONLY importer of CodeMirror, and the explorer page loads
 * it with `React.lazy`, so the editor (~hundreds of kB) is its own chunk and
 * weighs on nobody who never opens the explorer.
 */
import { useImperativeHandle, useMemo, useRef } from 'react';
import type { Ref } from 'react';
import CodeMirror, { EditorView, Prec, keymap } from '@uiw/react-codemirror';
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import type { TelemetrySchemaTable } from '../../services/telemetry';

export interface SqlEditorHandle {
  /** Replace the selection (or insert at the cursor) with `text`, then focus. */
  insertAtCursor: (text: string) => void;
  focus: () => void;
}

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter. */
  onRun: () => void;
  tables: TelemetrySchemaTable[];
  mode: 'light' | 'dark';
  ref?: Ref<SqlEditorHandle>;
}

/** `GET schema` → the lang-sql completion namespace (table → columns with types). */
export function toSqlNamespace(tables: TelemetrySchemaTable[]): SQLNamespace {
  const namespace: Record<string, { label: string; type: string; detail: string }[]> = {};
  for (const table of tables) {
    namespace[table.name] = table.columns.map((column) => ({
      label: column.name,
      type: 'property',
      detail: column.type,
    }));
  }
  return namespace;
}

export default function SqlEditor({ value, onChange, onRun, tables, mode, ref }: SqlEditorProps) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  // Read through a ref so the keymap extension is built once, not per render.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor: (text: string) => {
        const view = editorRef.current?.view;
        if (!view) return;
        view.dispatch(view.state.replaceSelection(text));
        view.focus();
      },
      focus: () => editorRef.current?.view?.focus(),
    }),
    [],
  );

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL, schema: toSqlNamespace(tables), upperCaseKeywords: true }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onRunRef.current();
              return true;
            },
          },
        ]),
      ),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'SQL query' }),
    ],
    [tables],
  );

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={mode}
      minHeight="160px"
      maxHeight="45vh"
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
      style={{ fontSize: 14 }}
    />
  );
}
