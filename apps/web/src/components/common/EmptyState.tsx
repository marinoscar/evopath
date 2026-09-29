import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';

interface EmptyStateProps {
  Icon?: SvgIconComponent;
  title: string;
  description?: string;
  action?: ReactNode;
  headingLevel?: 'h2' | 'h3';
}

export function EmptyState({
  Icon,
  title,
  description,
  action,
  headingLevel = 'h2',
}: EmptyStateProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 1,
        p: 3,
        minWidth: 0,
      }}
    >
      {Icon && <Icon aria-hidden="true" sx={{ fontSize: 40, color: 'text.secondary' }} />}
      <Typography variant="h6" component={headingLevel} sx={{ overflowWrap: 'anywhere' }}>
        {title}
      </Typography>
      {description && (
        <Typography color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {description}
        </Typography>
      )}
      {action}
    </Box>
  );
}

export default EmptyState;
