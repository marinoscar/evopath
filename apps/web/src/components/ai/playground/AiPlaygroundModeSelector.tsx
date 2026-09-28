/**
 * The Playground's mode switch — issue #445, epic #420.
 *
 * A segmented control, not a tab strip: the Playground is not a settings
 * page, and each mode is a different kind of AI call on the same page
 * (CLAUDE.md's "no tabs" rule governs settings destinations only).
 *
 * ACCESSIBILITY. Each mode is a toggle button (`aria-pressed`) in a labelled
 * group. Tab reaches every button; Arrow Left/Right, Home and End move focus
 * within the group; Enter/Space selects. A mode no usable model can serve is
 * `aria-disabled` rather than `disabled`, so it stays focusable and its
 * tooltip — the reason it cannot be used — is reachable from the keyboard
 * and announced as the button's description, not its name.
 */
import { useRef, type KeyboardEvent } from 'react';
import { Box, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import { AI_PLAYGROUND_MODES, type AiPlaygroundModeId } from './aiPlaygroundModes';

export interface AiPlaygroundModeSelectorProps {
  value: AiPlaygroundModeId;
  onChange: (mode: AiPlaygroundModeId) => void;
  /** Modes that cannot be selected, each with the reason shown in its tooltip. */
  unavailable: ReadonlySet<AiPlaygroundModeId>;
  /** Modes not offered at all (switched off by an administrator, #449). */
  hidden?: ReadonlySet<AiPlaygroundModeId>;
  /** Disables every mode (e.g. while a chat turn is streaming). */
  disabled?: boolean;
}

const MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export function AiPlaygroundModeSelector({
  value,
  onChange,
  unavailable,
  hidden,
  disabled,
}: AiPlaygroundModeSelectorProps) {
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = MOVES[event.key];
    const buttons = Array.from(groupRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (!move || index === -1) return;
    event.preventDefault();
    buttons[move(index, buttons.length)]?.focus();
  };

  return (
    // The wrapper scrolls rather than the page if six labels ever outgrow a phone.
    <Box sx={{ maxWidth: '100%', overflowX: 'auto' }}>
      <ToggleButtonGroup
        ref={groupRef}
        exclusive
        size="small"
        color="primary"
        aria-label="Playground mode"
        value={value}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onChange={(_event, next: AiPlaygroundModeId | null) => {
          // `null` is a click on the selected mode; an unavailable mode is inert.
          if (next && !unavailable.has(next)) onChange(next);
        }}
      >
        {AI_PLAYGROUND_MODES.filter((mode) => !hidden?.has(mode.id)).map((mode) => {
          const isUnavailable = unavailable.has(mode.id);
          const button = (
            <ToggleButton
              key={mode.id}
              value={mode.id}
              aria-disabled={isUnavailable || undefined}
              data-mode={mode.id}
              sx={{
                px: { xs: 1.25, sm: 2 },
                textTransform: 'none',
                whiteSpace: 'nowrap',
                ...(isUnavailable ? { color: 'text.disabled', cursor: 'not-allowed' } : {}),
              }}
            >
              {mode.label}
            </ToggleButton>
          );
          return isUnavailable ? (
            <Tooltip key={mode.id} title={mode.unavailableReason} describeChild>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </ToggleButtonGroup>
    </Box>
  );
}

export default AiPlaygroundModeSelector;
