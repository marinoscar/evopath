import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useState, type ReactNode } from 'react';

import { appName, validateAppName, type AppName } from './install-model.js';
import { displayValue, labelFor, shouldMask, type FieldSpec } from './model.js';
import type { ToggleFlag } from './flags-model.js';
import { ErrorNotice, Field, Frame } from '../../layout.js';

// =============================================================================
// The four things a deploy screen asks with  (issue #406)
// =============================================================================
//
// A name, a list of questions, a set of flags, and a confirmation. Every screen
// is built out of these and holds no input handling of its own, which is what
// keeps invoke.tsx's invariant true here: EXACTLY ONE THING ACCEPTS INPUT AT
// ANY MOMENT. Two of these mounted at once would have two `useInput` handlers
// fighting over a keystroke - the failure that turns a typed `q` into an
// unexplained quit.
//
// ⚠ MASKING IS ASKED FOR, NEVER COMPUTED. Both the input's `mask` prop and the
// review rows call `shouldMask`/`displayValue` from model.ts. `FieldSpec.secret`
// is deliberately NOT consulted: a prefilled value arrives as a bare key with
// no field around it, and the two answers diverging is precisely how a secret
// read off disk came to be echoed in clear text on the review screen.
// =============================================================================

/**
 * The name shown in a title before one has been resolved.
 *
 * ⚠ DISPLAY ONLY. It is `AppName.display`'s fallback and must never become
 * `AppName.resolved` -- an install was once gated on a port conflict with an
 * app literally called `app`, because a fallback display name reached a real
 * decision. `NameStep` refuses an unresolved name rather than substituting it.
 */
export const DISPLAY_FALLBACK = 'app';

export interface NameStepProps {
  title: string;
  /**
   * A deployment actually found on this host, offered as the typed default.
   *
   * Put in the INPUT, not the placeholder: a placeholder that becomes a value
   * on Enter is how a hint turns into a path. Undefined leaves the field empty
   * and the operator must name one.
   */
  located: string | undefined;
  /** Where the deployments live, shown so the operator can see what is acted on. */
  appsRoot: string;
  onSubmit: (name: AppName) => void;
  /** Fires on every keystroke, so a screen can retract a stale prefill seed. */
  onChange?: ((name: AppName) => void) | undefined;
}

export function NameStep({
  title,
  located,
  appsRoot,
  onSubmit,
  onChange,
}: NameStepProps): ReactNode {
  const [value, setValue] = useState(located ?? '');
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <Frame title={title} hints={['enter next', 'ctrl-c quit']}>
      <Text dimColor>
        Which deployment? One directory under {appsRoot}.
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{'name  '}</Text>
        <TextInput
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange?.(appName(next, DISPLAY_FALLBACK));
          }}
          placeholder="my-app"
          onSubmit={(submitted) => {
            const name = appName(submitted, DISPLAY_FALLBACK);

            if (name.resolved === undefined) {
              // ⚠ Refused, not defaulted. See DISPLAY_FALLBACK.
              setError('Name the deployment; there is no safe default for it.');
              return;
            }

            const message = validateAppName(name.resolved);
            if (message !== undefined) {
              // Kept on the field they got it wrong on, rather than made to
              // start the flow again - invoke.tsx's rule.
              setError(`App name ${message}.`);
              return;
            }

            setError(undefined);
            onSubmit(name);
          }}
        />
      </Box>
      {error === undefined ? null : (
        <Box marginTop={1}>
          <ErrorNotice message={error} />
        </Box>
      )}
    </Frame>
  );
}

export interface FieldWizardProps {
  title: string;
  /** A line under the title: which deployment this is acting on. */
  subtitle?: string | undefined;
  fields: readonly FieldSpec[];
  onComplete: (answers: Map<string, string>) => void;
}

/**
 * The questions, one at a time, with a cursor into a DATA list.
 *
 * A hand-rolled union of thirty step variants does not scale, so the wizard is
 * data and this keeps the cursor. An empty submission takes the placeholder,
 * which is what makes a re-run keep every value already on disk - see
 * `FieldSpec.placeholder`.
 */
export function FieldWizard({
  title,
  subtitle,
  fields,
  onComplete,
}: FieldWizardProps): ReactNode {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const field = fields[index];
  if (field === undefined) {
    // Unreachable while every caller passes a non-empty list, and present so
    // that passing an empty one is a frame saying so rather than a blank screen.
    return (
      <Frame title={title} hints={['esc back']}>
        <Text>No questions to ask.</Text>
      </Frame>
    );
  }

  return (
    <Frame title={`${title} — ${index + 1}/${fields.length}`} hints={['enter next', 'ctrl-c quit']}>
      {subtitle === undefined ? null : <Text dimColor>{subtitle}</Text>}
      {field.help === '' ? null : <Text dimColor>{field.help.split('\n')[0]}</Text>}
      <Box marginTop={1}>
        <Text dimColor>{field.label}  </Text>
        <TextInput
          value={value}
          onChange={setValue}
          placeholder={field.placeholder}
          // ⚠ `shouldMask`, not `field.secret`. See the file header.
          {...(shouldMask(field.key) ? { mask: '*' } : {})}
          onSubmit={(submitted) => {
            const answer = submitted === '' ? field.placeholder : submitted;
            const message = field.validate?.(answer);

            if (message !== undefined) {
              setError(`${field.label} ${message}`);
              return;
            }

            const next = new Map(answers).set(field.key, answer);
            setValue('');
            setError(undefined);

            if (index + 1 < fields.length) {
              setAnswers(next);
              setIndex(index + 1);
            } else {
              onComplete(next);
            }
          }}
        />
      </Box>
      {field.prefilled ? (
        <Text dimColor>Currently set on this deployment; enter keeps it.</Text>
      ) : null}
      {error === undefined ? null : (
        <Box marginTop={1}>
          <ErrorNotice message={error} />
        </Box>
      )}
    </Frame>
  );
}

/** The last row of the toggle list: the one that is not a flag. */
const CONTINUE = '__continue';

export interface ToggleStepProps {
  title: string;
  subtitle?: string | undefined;
  toggles: readonly ToggleFlag[];
  chosen: ReadonlySet<string>;
  onToggle: (flag: string) => void;
  onContinue: () => void;
}

/**
 * The flags, as a list that is walked and toggled.
 *
 * ONE SelectInput, NOT a checkbox grid: the list already owns the keyboard, so
 * selecting a row flips it and selecting the last row moves on. That keeps the
 * single-input invariant and costs no new dependency.
 *
 * ⚠ The items' VALUES are the flag strings and never change; only the labels
 * do. ink-select-input resets its cursor to the top when the values change, so
 * a toggle that rebuilt them would bounce the highlight back to the first row
 * on every keypress.
 */
export function ToggleStep({
  title,
  subtitle,
  toggles,
  chosen,
  onToggle,
  onContinue,
}: ToggleStepProps): ReactNode {
  const items = [
    ...toggles.map((toggle) => ({
      key: toggle.flag,
      label: `${chosen.has(toggle.flag) ? '[x]' : '[ ]'} ${toggle.label}  (${toggle.flag})`,
      value: toggle.flag,
    })),
    { key: CONTINUE, label: 'Continue', value: CONTINUE },
  ];

  return (
    <Frame title={title} hints={['↑↓ move', 'enter toggle', 'esc back']}>
      {subtitle === undefined ? null : <Text dimColor>{subtitle}</Text>}
      <Text dimColor>Options. Nothing here is required; enter toggles a row.</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === CONTINUE) onContinue();
            else onToggle(item.value);
          }}
        />
      </Box>
    </Frame>
  );
}

export interface ConfirmStepProps {
  /** The action, as the operator chose it. */
  action: string;
  /** Everything collected, rendered through `displayValue`. */
  answers: ReadonlyMap<string, string>;
  /** Lines above the choice: the resume decision's reason, for instance. */
  notes?: readonly string[] | undefined;
  onYes: () => void;
  onNo: () => void;
}

export function ConfirmStep({
  action,
  answers,
  notes,
  onYes,
  onNo,
}: ConfirmStepProps): ReactNode {
  const items = [
    // "No" FIRST and selected by default: this mutates a server, and a
    // destructive action whose default is yes is one stray Enter away from
    // happening by accident.
    { key: 'no', label: 'No, go back', value: 'no' as const },
    { key: 'yes', label: `Yes, ${action} now`, value: 'yes' as const },
  ];

  return (
    <Frame title="Confirm" hints={['enter select', 'esc back']}>
      <Text>About to {action} on this server:</Text>
      <Box marginTop={1} flexDirection="column">
        {[...answers.entries()].map(([key, answer]) => (
          // ⚠ `displayValue`, not a local secret test. See the file header.
          <Field key={key} label={labelFor(key)} value={displayValue(key, answer)} />
        ))}
      </Box>
      {notes === undefined || notes.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          {notes.map((note) => (
            <Text key={note} dimColor>
              {note}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === 'yes') onYes();
            else onNo();
          }}
        />
      </Box>
    </Frame>
  );
}

/**
 * A hostname, or nothing at all.
 *
 * ⚠ An OPTIONAL field's placeholder is empty on purpose, so that pressing
 * Enter through it stores `''` rather than the hint. The screens read `''` as
 * "not given" and leave the option off the call entirely - which is the
 * difference between `doctor` skipping its DNS checks and `doctor` resolving a
 * hostname the operator never typed.
 */
export function optionalHostname(value: string): string | undefined {
  return value === '' || /^[a-z0-9.-]+$/i.test(value) ? undefined : 'must be a hostname';
}

/** Flips one flag in the chosen set. */
export function toggled(current: ReadonlySet<string>, flag: string): Set<string> {
  const next = new Set(current);
  if (!next.delete(flag)) next.add(flag);
  return next;
}

/**
 * The answers plus the chosen flags, as the rows a confirmation shows.
 *
 * ⚠ The flags belong on the review. A confirmation that showed the questions
 * and not the flags would be asking an operator to approve half of what is
 * about to run - and `--force`, `--reinstall` and `--skip-seed` are the half
 * with consequences.
 */
export function withFlags(
  answers: ReadonlyMap<string, string>,
  chosen: ReadonlySet<string>,
): Map<string, string> {
  const rows = new Map(answers);
  rows.set('__flags', [...chosen].join(' ') || 'none');
  return rows;
}

export interface AdvancedStepProps {
  title: string;
  /** The settings as they stand, one row each: what "use these" means. */
  summary: ReadonlyArray<{ label: string; value: string }>;
  /** The form shown when the operator chooses to change them. */
  fields: readonly FieldSpec[];
  /** Undefined: keep every default. A map: the form's answers. */
  onComplete: (answers: ReadonlyMap<string, string> | undefined) => void;
}

const USE_DEFAULTS = 'defaults';
const CUSTOMISE = 'customise';

/**
 * Where the deployment lives and how its proxy runs  (issue #393).
 *
 * Opens on a summary with "Use these" SELECTED, so the common path costs one
 * Enter. Only "Change them" opens the form -- the same `FieldWizard` every
 * other question uses, prefilled with the values the summary just showed, so
 * Enter through it changes nothing.
 *
 * One input at a time: the select, then (maybe) the wizard, never both.
 */
export function AdvancedStep({ title, summary, fields, onComplete }: AdvancedStepProps): ReactNode {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <FieldWizard title={`${title} — advanced`} fields={fields} onComplete={onComplete} />;
  }

  const items = [
    { key: USE_DEFAULTS, label: 'Use these', value: USE_DEFAULTS },
    { key: CUSTOMISE, label: 'Change them…', value: CUSTOMISE },
  ];

  return (
    <Frame title={`${title} — advanced`} hints={['enter select', 'ctrl-c quit']}>
      <Text dimColor>Where this runs. Recorded values where there are any, else the defaults.</Text>
      <Box marginTop={1} flexDirection="column">
        {summary.map((row) => (
          <Field key={row.label} label={row.label} value={row.value} />
        ))}
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === CUSTOMISE) setEditing(true);
            else onComplete(undefined);
          }}
        />
      </Box>
    </Frame>
  );
}
