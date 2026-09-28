/**
 * A header link between the telemetry pages — issue #579, epic #576: the
 * Dashboard's "Explorer", the Explorer's "Dashboard", and the Telemetry
 * settings page's "Open dashboard".
 *
 * A LINK (it navigates), styled as a text button from `sm` up and as a 44px
 * icon button with an `aria-label` on phones. The icon is the destination's
 * registry card icon (`config/adminSections.tsx`), so the two read as one.
 * Showing it is the caller's decision; the destination route is still gated
 * by its own permission and feature, and the API by its own.
 */
import { Button, IconButton, Tooltip } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

export interface TelemetryCrossLinkProps {
  to: string;
  /** The visible label from `sm` up. */
  label: string;
  /** The accessible name of the phone icon button (a full sentence of a name). */
  compactLabel: string;
  icon: ReactNode;
  compact: boolean;
}

export function TelemetryCrossLink({ to, label, compactLabel, icon, compact }: TelemetryCrossLinkProps) {
  if (compact) {
    return (
      <Tooltip title={compactLabel}>
        <IconButton component={RouterLink} to={to} aria-label={compactLabel} sx={{ width: 44, height: 44, flexShrink: 0 }}>
          {icon}
        </IconButton>
      </Tooltip>
    );
  }
  return (
    <Button component={RouterLink} to={to} startIcon={icon} sx={{ flexShrink: 0, minHeight: 36 }}>
      {label}
    </Button>
  );
}
