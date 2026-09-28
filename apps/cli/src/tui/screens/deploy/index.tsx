import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { DEFAULT_APPS_ROOT, enumerateDeployments, locateApp } from '../../../deploy/layout.js';
import { Frame } from '../../layout.js';
import { DoctorScreen } from './doctor.js';
import type { DeployAction } from './flags-model.js';
import { InstallScreen } from './install.js';
import { StatusScreen } from './status.js';
import { UpdateScreen } from './update.js';

// =============================================================================
// The deploy screens  (issue #406, epic #397; replacing #184's single screen)
// =============================================================================
//
// ONE COMPONENT PER COMMAND, COMPOSED HERE - not one ROUTE per command. There
// is deliberately no history stack in this TUI (see routes.ts): every route
// returns to the TOP menu, so a route per action would mean walking in from the
// menu again to run a second one. Composition gets the split without that:
// choosing an action mounts its screen, and leaving it lands back on this list.
//
// EACH CHILD CALLS THE SAME FUNCTION THE SUBCOMMAND CALLS. `runChecks`,
// `runInstall`, `runUpdate` and `collectHealth` are shared verbatim; only the
// `DeployHooks` implementation differs, writing into React state instead of
// onto stderr. That is the device-login.ts pattern, and it is the reason there
// is no orchestration logic in any of these components.
//
// MOUNTING IS WHAT KEEPS THE KEYBOARD UNAMBIGUOUS. ink delivers every keystroke
// to EVERY mounted `useInput`, so this list's own handler is inactive while a
// child is mounted - otherwise Esc would both leave the child and leave the
// screen, in an order nobody could predict.
// =============================================================================

export interface DeployScreenProps {
  onDone: () => void;
}

export function DeployScreen({ onDone }: DeployScreenProps): ReactNode {
  const [action, setAction] = useState<DeployAction | undefined>(undefined);

  // Read once, on mount: the filesystem does not change under an operator
  // choosing from a list, and re-reading it on every render would stat the
  // apps root on each keystroke.
  const found = useMemo(() => {
    try {
      return enumerateDeployments(DEFAULT_APPS_ROOT);
    } catch {
      // A host with no apps root is a host with nothing installed, not an error.
      return [];
    }
  }, []);

  /**
   * The deployment this command would act on if it were the subcommand.
   *
   * ⚠ `locateApp` REFUSES when several are installed rather than preferring
   * one, so this is undefined exactly when the operator genuinely has to
   * choose. Offering the refusal's tiebreak here would reintroduce the guess
   * the resolver exists to avoid.
   */
  const located = useMemo(() => {
    try {
      return locateApp({ appsRoot: DEFAULT_APPS_ROOT }).name;
    } catch {
      return undefined;
    }
  }, []);

  const back = useCallback(() => {
    setAction(undefined);
  }, []);

  useInput(
    (_input, key) => {
      if (key.escape) onDone();
    },
    // Inactive while a child owns the screen; the child's own Esc handling is
    // the cancel during a run, and two handlers would fight over the keystroke.
    { isActive: action === undefined },
  );

  if (action === 'doctor') return <DoctorScreen onDone={back} located={located} />;
  if (action === 'install') return <InstallScreen onDone={back} located={located} />;
  if (action === 'update') return <UpdateScreen onDone={back} located={located} />;
  if (action === 'status') return <StatusScreen onDone={back} located={located} />;

  const installed = found.length > 0;
  const items = [
    { key: 'doctor', label: 'Doctor  (check prerequisites)', value: 'doctor' as const },
    {
      key: 'install',
      // Annotated rather than hidden, following the menu's convention: the
      // destination produces the real message.
      label: installed ? 'Install  (a deployment is already here)' : 'Install',
      value: 'install' as const,
    },
    {
      key: 'update',
      label: installed ? 'Update' : 'Update  (nothing installed here)',
      value: 'update' as const,
    },
    { key: 'status', label: 'Status', value: 'status' as const },
  ];

  return (
    <Frame title="Deploy" hints={['↑↓ move', 'enter select', 'esc back']}>
      <Text dimColor>
        Acting on {DEFAULT_APPS_ROOT}
        {found.length === 0
          ? ' — nothing installed yet'
          : ` — ${found.map((entry) => entry.name).join(', ')}`}
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            setAction(item.value);
          }}
        />
      </Box>
    </Frame>
  );
}
