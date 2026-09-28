/**
 * The Playground's two-panel layout, shared by every mode — issue #445
 * (extracted from #434's chat layout).
 *
 * A settings panel beside the work area from `sm` up; below `sm` it stacks
 * above and collapses behind a "Settings" toggle. The compact switch is
 * `down('sm')` — the boundary of CLAUDE.md's five coupled breakpoint gates,
 * none of which this component changes.
 */
import { useId, useState, type ReactNode } from 'react';
import { Box, Button, Collapse, Paper, useMediaQuery, useTheme } from '@mui/material';
import { Tune as TuneIcon } from '@mui/icons-material';

export interface AiPlaygroundPanelsProps {
  /** The settings panel's content (model select and the mode's options). */
  settings: ReactNode;
  /** Accessible name of the work area (`Chat`, `Image`, …). */
  label: string;
  children: ReactNode;
}

export function AiPlaygroundPanels({ settings, label, children }: AiPlaygroundPanelsProps) {
  const theme = useTheme();
  const isCompact = useMediaQuery(theme.breakpoints.down('sm'));
  const settingsPanelId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: { xs: 'stretch', sm: 'flex-start' },
        gap: 2,
        minWidth: 0,
      }}
    >
      <Paper
        component="aside"
        variant="outlined"
        aria-label="Playground settings"
        sx={{ width: { xs: '100%', sm: 260, md: 320 }, flexShrink: 0, p: 2, minWidth: 0 }}
      >
        {isCompact ? (
          <>
            <Button
              fullWidth
              startIcon={<TuneIcon />}
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls={settingsPanelId}
              sx={{ justifyContent: 'flex-start' }}
            >
              Settings
            </Button>
            <Collapse in={settingsOpen} id={settingsPanelId}>
              <Box sx={{ pt: 2 }}>{settings}</Box>
            </Collapse>
          </>
        ) : (
          <Box id={settingsPanelId}>{settings}</Box>
        )}
      </Paper>

      <Paper
        component="section"
        variant="outlined"
        aria-label={label}
        sx={{ flex: 1, minWidth: 0, p: { xs: 1.5, sm: 2 }, display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {children}
      </Paper>
    </Box>
  );
}

export default AiPlaygroundPanels;
