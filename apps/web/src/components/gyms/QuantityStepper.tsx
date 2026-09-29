/**
 * A 1..99 quantity with minus/plus buttons (E3.3). The value is always
 * clamped: the buttons disable at the bounds and a typed value outside the
 * range snaps back into it on blur.
 */
import { useEffect, useState } from 'react';
import { Box, IconButton, TextField } from '@mui/material';
import { Add as AddIcon, Remove as RemoveIcon } from '@mui/icons-material';
import { EQUIPMENT_QUANTITY_MAX, EQUIPMENT_QUANTITY_MIN, clampQuantity } from '../../services/gyms';

export interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  /** Names the control, e.g. "Quantity of Elliptical". */
  label?: string;
  disabled?: boolean;
  size?: 'small' | 'medium';
}

export function QuantityStepper({
  value,
  onChange,
  label = 'Quantity',
  disabled = false,
  size = 'small',
}: QuantityStepperProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (next: number) => {
    const clamped = clampQuantity(next);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }} role="group" aria-label={label}>
      <IconButton
        size={size}
        aria-label={`Decrease ${label.toLowerCase()}`}
        onClick={() => commit(value - 1)}
        disabled={disabled || value <= EQUIPMENT_QUANTITY_MIN}
      >
        <RemoveIcon fontSize="small" />
      </IconButton>
      <TextField
        size="small"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
        onBlur={() => commit(Number.parseInt(draft, 10))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(Number.parseInt(draft, 10));
          }
        }}
        slotProps={{
          htmlInput: {
            'aria-label': label,
            inputMode: 'numeric',
            style: { textAlign: 'center', width: '2.5em' },
          },
        }}
      />
      <IconButton
        size={size}
        aria-label={`Increase ${label.toLowerCase()}`}
        onClick={() => commit(value + 1)}
        disabled={disabled || value >= EQUIPMENT_QUANTITY_MAX}
      >
        <AddIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

export default QuantityStepper;
