/**
 * A single-file picker for the Playground's media modes — issue #445.
 *
 * A labelled button over a hidden `<input type="file">` (its `aria-label`
 * is `label`), the chosen file's name, a named remove button, and the reason
 * the file cannot be sent. `accept` only filters the system picker; callers
 * still validate the file (a drop or a determined user can send anything).
 */
import type { ChangeEvent } from 'react';
import { Box, Button, IconButton, Typography } from '@mui/material';
import { Close as CloseIcon, UploadFile as UploadFileIcon } from '@mui/icons-material';

export interface AiFilePickerProps {
  label: string;
  accept: readonly string[] | string;
  file: File | null;
  error: string | null;
  disabled?: boolean;
  onChange: (file: File | null) => void;
}

export function AiFilePicker({ label, accept, file, error, disabled, onChange }: AiFilePickerProps) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Button component="label" size="small" variant="outlined" startIcon={<UploadFileIcon />} disabled={disabled}>
          {file ? `Replace ${label.toLowerCase()}` : `Choose ${label.toLowerCase()}`}
          <input
            hidden
            type="file"
            aria-label={label}
            accept={typeof accept === 'string' ? accept : accept.join(',')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              onChange(event.target.files?.[0] ?? null);
              // Let the same file be chosen again after it is removed.
              event.target.value = '';
            }}
          />
        </Button>
        {file && (
          <>
            <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1 }} title={file.name}>
              {file.name}
            </Typography>
            <IconButton size="small" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => onChange(null)} disabled={disabled}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        )}
      </Box>
      {error && (
        <Typography variant="caption" color="error" role="alert" component="p" sx={{ mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}

export default AiFilePicker;
