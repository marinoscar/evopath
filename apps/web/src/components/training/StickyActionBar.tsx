/**
 * The primary action bar of a plan screen: sticky at the bottom of the
 * viewport, above the phone bottom bar (MUI's 56px `BottomNavigation`) and
 * flush on larger screens. Layout only; it gates nothing.
 */
import type { ReactNode } from 'react';
import { Box } from '@mui/material';

export function StickyActionBar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Box
      role="region"
      aria-label={label}
      sx={{
        position: 'sticky',
        bottom: { xs: 56, sm: 0 },
        zIndex: 2,
        bgcolor: 'background.paper',
        borderTop: 1,
        borderColor: 'divider',
        py: 1.5,
        mt: 3,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1,
        justifyContent: 'flex-end',
      }}
    >
      {children}
    </Box>
  );
}

export default StickyActionBar;
