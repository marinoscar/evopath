/**
 * The keep-or-delete choice for a health upload (H1, #185): "Keep this file
 * in <product> after processing", checked by default. Unchecking asks the
 * server to erase the file once the values are saved (the values and their
 * provenance stay).
 *
 * Shown only for a health intake kind (`isHealthIntakeKind`): gym equipment
 * and workout prefill photos are not health documents and render nothing.
 * The server decides what the choice means; this only collects it.
 *
 * Reused by every health upload (scale and cuff photos today, lab reports
 * next). The helper text is tied to the checkbox with `aria-describedby`.
 */
import { useId } from 'react';
import { Box, Checkbox, FormControlLabel, FormHelperText } from '@mui/material';
import { APP_NAME } from '@app/shared';
import { isHealthIntakeKind } from '../../services/intake';

export const RETAIN_FILES_LABEL = `Keep this file in ${APP_NAME} after processing`;
export const RETAIN_FILES_HELPER_TEXT =
  'Unchecked, the file is erased as soon as the values are saved (or the upload is discarded). ' +
  'The saved values and where they came from are kept.';

export interface RetainFilesControlProps {
  /** The intake kind; nothing renders unless it is a health kind. */
  kind: string | null | undefined;
  /** Keep the file (`retainFiles`). */
  checked: boolean;
  onChange: (retainFiles: boolean) => void;
  disabled?: boolean;
}

export function RetainFilesControl({ kind, checked, onChange, disabled = false }: RetainFilesControlProps) {
  const helperId = useId();
  if (!isHealthIntakeKind(kind)) return null;
  return (
    <Box data-testid="retain-files-control">
      <FormControlLabel
        control={
          <Checkbox
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            disabled={disabled}
            slotProps={{ input: { 'aria-describedby': helperId } }}
          />
        }
        label={RETAIN_FILES_LABEL}
      />
      <FormHelperText id={helperId} sx={{ mt: 0, ml: 4 }}>
        {RETAIN_FILES_HELPER_TEXT}
      </FormHelperText>
    </Box>
  );
}

export default RetainFilesControl;
