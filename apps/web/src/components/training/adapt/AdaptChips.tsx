/**
 * What the user can say, as chips: minutes, Sore (muscles and how sore),
 * Equipment (the gym as is, only these, bodyweight) and Low energy.
 *
 * Every chip is a toggle button with a name (`aria-pressed`) and the
 * selected state is shown with a check icon as well as the fill, never by
 * colour alone. Check-in suggestions are hints: nothing is selected for the
 * user. Presentation only; the parent owns the draft.
 */
import type { ReactNode } from 'react';
import { Box, Chip, FormHelperText, Stack, TextField, Typography } from '@mui/material';
import { Check as CheckIcon } from '@mui/icons-material';
import { MUSCLES, humanize } from '../../../services/exercises';
import { ADAPTATION_LIMITS, MINUTE_CHOICES, SORENESS_LEVELS } from '../../../services/trainingAdaptation';
import { SORENESS_LABEL, type AdaptDraft, type EquipmentChoice } from './adaptDraft';

export interface ToggleChipProps {
  label: string;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** An accessible name when the visible label is not enough. */
  ariaLabel?: string;
}

/** A chip that is a toggle button: `role="button"` with `aria-pressed`. */
export function ToggleChip({ label, selected, onToggle, disabled, ariaLabel }: ToggleChipProps) {
  return (
    <Chip
      label={label}
      clickable
      disabled={disabled}
      onClick={onToggle}
      color={selected ? 'primary' : 'default'}
      variant={selected ? 'filled' : 'outlined'}
      icon={selected ? <CheckIcon aria-hidden /> : undefined}
      aria-pressed={selected}
      aria-label={ariaLabel}
      sx={{ minHeight: 36 }}
    />
  );
}

export interface EquipmentOption {
  id: string;
  name: string;
}

export interface AdaptChipsProps {
  draft: AdaptDraft;
  onChange: (patch: Partial<AdaptDraft>) => void;
  /** The chosen gym's equipment types for "Only these"; null while loading or when there is no gym. */
  equipmentOptions: EquipmentOption[] | null;
  /** Hints from today's check-in ("Your check-in says you're sore"); never auto-selected. */
  suggestions?: { sore?: string | null; lowEnergy?: string | null };
  disabled?: boolean;
}

function Group({ id, title, children, hint }: { id: string; title: string; children: ReactNode; hint?: string | null }) {
  return (
    <Box component="fieldset" aria-labelledby={id} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
      <Typography id={id} component="legend" variant="subtitle2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      {hint && (
        <Typography variant="body2" color="info.main" sx={{ mb: 0.5 }} data-testid={`${id}-hint`}>
          {hint}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{children}</Box>
    </Box>
  );
}

const EQUIPMENT_LABEL: Record<EquipmentChoice, string> = {
  gym: 'Use the gym as is',
  only: 'Only these',
  bodyweight: 'Bodyweight only',
};

export function AdaptChips({ draft, onChange, equipmentOptions, suggestions, disabled }: AdaptChipsProps) {
  const toggleIn = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const { min, max } = ADAPTATION_LIMITS.minutes;
  const custom = draft.minutes === 'custom';
  const customValue = Number(draft.customMinutes);
  const customInvalid =
    custom && draft.customMinutes.trim() !== '' && (!Number.isInteger(customValue) || customValue < min || customValue > max);

  return (
    <Stack spacing={2.5}>
      <Group id="adapt-minutes" title="How much time do you have?">
        {MINUTE_CHOICES.map((m) => (
          <ToggleChip
            key={m}
            label={`${m} min`}
            ariaLabel={`${m} minutes`}
            selected={draft.minutes === m}
            disabled={disabled}
            onToggle={() => onChange({ minutes: draft.minutes === m ? null : m })}
          />
        ))}
        <ToggleChip
          label="Custom"
          ariaLabel="Custom minutes"
          selected={custom}
          disabled={disabled}
          onToggle={() => onChange({ minutes: custom ? null : 'custom' })}
        />
        {custom && (
          <TextField
            label="Minutes"
            type="number"
            size="small"
            value={draft.customMinutes}
            disabled={disabled}
            onChange={(e) => onChange({ customMinutes: e.target.value })}
            error={customInvalid}
            helperText={customInvalid ? `${min} to ${max} minutes` : undefined}
            slotProps={{ htmlInput: { min, max, step: 5, inputMode: 'numeric' } }}
            sx={{ width: 140 }}
          />
        )}
      </Group>

      <Group id="adapt-sore" title="Sore?" hint={suggestions?.sore}>
        <ToggleChip
          label="I'm sore"
          selected={draft.sore}
          disabled={disabled}
          onToggle={() => onChange({ sore: !draft.sore })}
        />
      </Group>
      {draft.sore && (
        <Stack spacing={1.5} sx={{ pl: { xs: 0, sm: 2 } }}>
          <Group id="adapt-sore-muscles" title="Where?">
            {MUSCLES.map((muscle) => (
              <ToggleChip
                key={muscle}
                label={humanize(muscle)}
                selected={draft.soreMuscles.includes(muscle)}
                disabled={disabled || (!draft.soreMuscles.includes(muscle) && draft.soreMuscles.length >= ADAPTATION_LIMITS.soreMuscles.max)}
                onToggle={() => onChange({ soreMuscles: toggleIn(draft.soreMuscles, muscle) })}
              />
            ))}
          </Group>
          <Group id="adapt-sore-level" title="How sore?">
            {SORENESS_LEVELS.map((level) => (
              <ToggleChip
                key={level}
                label={SORENESS_LABEL[level]}
                selected={draft.soreLevel === level}
                disabled={disabled}
                onToggle={() => onChange({ soreLevel: level })}
              />
            ))}
          </Group>
          {draft.soreMuscles.length === 0 && <FormHelperText>Choose where you are sore.</FormHelperText>}
        </Stack>
      )}

      <Group id="adapt-equipment" title="Equipment">
        {(Object.keys(EQUIPMENT_LABEL) as EquipmentChoice[]).map((choice) => (
          <ToggleChip
            key={choice}
            label={EQUIPMENT_LABEL[choice]}
            selected={draft.equipment === choice}
            disabled={disabled}
            onToggle={() => onChange({ equipment: choice })}
          />
        ))}
      </Group>
      {draft.equipment === 'only' && (
        <Box sx={{ pl: { xs: 0, sm: 2 } }}>
          {equipmentOptions === null ? (
            <Typography variant="body2" color="text.secondary">
              Loading the gym&apos;s equipment…
            </Typography>
          ) : equipmentOptions.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              This gym has no equipment listed. Choose Bodyweight only, or add equipment to the gym.
            </Typography>
          ) : (
            <Group id="adapt-equipment-types" title="Which equipment?">
              {equipmentOptions.map((option) => (
                <ToggleChip
                  key={option.id}
                  label={option.name}
                  selected={draft.equipmentTypeIds.includes(option.id)}
                  disabled={
                    disabled ||
                    (!draft.equipmentTypeIds.includes(option.id) &&
                      draft.equipmentTypeIds.length >= ADAPTATION_LIMITS.onlyEquipment.max)
                  }
                  onToggle={() => onChange({ equipmentTypeIds: toggleIn(draft.equipmentTypeIds, option.id) })}
                />
              ))}
            </Group>
          )}
        </Box>
      )}

      <Group id="adapt-energy" title="Energy" hint={suggestions?.lowEnergy}>
        <ToggleChip
          label="Low energy"
          selected={draft.lowEnergy}
          disabled={disabled}
          onToggle={() => onChange({ lowEnergy: !draft.lowEnergy })}
        />
      </Group>
    </Stack>
  );
}

export default AdaptChips;
