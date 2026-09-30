/**
 * How the coach applies its adjustments (E5.8): **Adapt automatically**
 * (the default; every change is logged, notified and can be undone) or
 * **Ask me first** (every adjustment becomes a proposal to approve). Written
 * through `PATCH /api/programs/:id { autonomy }` (`programs:write`).
 *
 * After two undos in 14 days the control offers, never forces, the switch to
 * Ask me first.
 */
import { useId, useState } from 'react';
import { Alert, Button, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { ProgramAutonomy } from '../../services/programs';

export const AUTONOMY_LABEL: Record<ProgramAutonomy, string> = {
  autonomous: 'Adapt automatically',
  ask_first: 'Ask me first',
};

const AUTONOMY_HELP: Record<ProgramAutonomy, string> = {
  autonomous: 'Your coach adjusts the plan within safe limits. Every change is logged and can be undone.',
  ask_first: 'Your coach suggests changes and waits for you to approve them. Safety removals still apply at once.',
};

export interface AutonomyControlProps {
  value: ProgramAutonomy;
  /** `programs:write`; without it the choice is shown read-only. */
  canWrite: boolean;
  onChange: (next: ProgramAutonomy) => Promise<unknown>;
  /** Offer the switch to Ask me first (the owner undid several recent changes). */
  suggestAskFirst?: boolean;
}

export function AutonomyControl({ value, canWrite, onChange, suggestAskFirst = false }: AutonomyControlProps) {
  const labelId = useId();
  const helpId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (next: ProgramAutonomy) => {
    if (next === value) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not change how the plan adapts');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="autonomy-control">
      <Typography id={labelId} variant="subtitle2" component="p" sx={{ mb: 0.5 }}>
        When your coach wants to change the plan
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        color="primary"
        value={value}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        disabled={!canWrite || busy}
        onChange={(_, next: ProgramAutonomy | null) => {
          if (next) void change(next);
        }}
      >
        <ToggleButton value="autonomous" sx={{ minHeight: 44, textTransform: 'none' }}>
          {AUTONOMY_LABEL.autonomous}
        </ToggleButton>
        <ToggleButton value="ask_first" sx={{ minHeight: 44, textTransform: 'none' }}>
          {AUTONOMY_LABEL.ask_first}
        </ToggleButton>
      </ToggleButtonGroup>
      <Typography id={helpId} variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {AUTONOMY_HELP[value]}
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      {suggestAskFirst && canWrite && value === 'autonomous' && (
        <Alert
          severity="info"
          sx={{ mt: 1 }}
          data-testid="ask-first-offer"
          action={
            <Button color="inherit" size="small" onClick={() => void change('ask_first')} disabled={busy}>
              Ask me first
            </Button>
          }
        >
          You undid recent changes. Want your coach to ask before changing the plan?
        </Alert>
      )}
    </div>
  );
}

export default AutonomyControl;
