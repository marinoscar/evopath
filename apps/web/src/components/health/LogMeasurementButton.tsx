import type { ReactNode } from 'react';
import { Box, Button, Tooltip, type ButtonProps } from '@mui/material';

export const NO_WRITE_PERMISSION_TOOLTIP = "You don't have permission to log health data";

interface LogMeasurementButtonProps extends Omit<ButtonProps, 'disabled' | 'onClick'> {
  /** `health_data:write`. Without it the button is disabled and explains why. */
  canLog: boolean;
  onClick: () => void;
  children: ReactNode;
}

/**
 * Every control that opens the quick-entry dialog (issue #53, E2.3). Without
 * `health_data:write` it is disabled with a tooltip; the API enforces the
 * permission regardless. A disabled button fires no events, so the tooltip
 * hangs off a focusable wrapper.
 */
export function LogMeasurementButton({ canLog, onClick, children, ...props }: LogMeasurementButtonProps) {
  if (canLog) {
    return (
      <Button {...props} onClick={onClick}>
        {children}
      </Button>
    );
  }
  return (
    <Tooltip title={NO_WRITE_PERMISSION_TOOLTIP}>
      <Box component="span" tabIndex={0} sx={{ display: 'inline-flex' }}>
        <Button {...props} disabled>
          {children}
        </Button>
      </Box>
    </Tooltip>
  );
}

export default LogMeasurementButton;
