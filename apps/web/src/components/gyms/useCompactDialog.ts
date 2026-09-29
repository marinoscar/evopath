import { useMediaQuery, useTheme } from '@mui/material';

/**
 * Dialogs on the gym pages go full-screen below `sm` (600px). This is a
 * dialog-presentation choice local to these pages, not one of the five
 * navigation breakpoint gates.
 */
export function useCompactDialog(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down('sm'));
}
