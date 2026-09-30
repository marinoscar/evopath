/**
 * A plan's versions, newest first. Selecting one shows its diff. The
 * `renderActions` slot lets later screens add per-version actions.
 */
import type { ReactNode } from 'react';
import { Chip, List, ListItemButton, ListItemText, Stack } from '@mui/material';
import type { ProgramVersionSummary } from '../../services/programs';
import { formatRelativeTime } from '../../utils/relativeTime';
import { ORIGIN_LABEL } from './planLabels';

export interface VersionListProps {
  versions: ProgramVersionSummary[];
  currentVersion: number;
  selected: number | null;
  onSelect: (versionNumber: number) => void;
  renderActions?: (version: ProgramVersionSummary) => ReactNode;
}

export function VersionList({ versions, currentVersion, selected, onSelect, renderActions }: VersionListProps) {
  return (
    <List dense disablePadding aria-label="Versions">
      {versions.map((version) => (
        <Stack key={version.versionNumber} component="li" direction="row" sx={{ alignItems: 'center', listStyle: 'none' }}>
          <ListItemButton
            selected={selected === version.versionNumber}
            aria-current={selected === version.versionNumber ? 'true' : undefined}
            onClick={() => onSelect(version.versionNumber)}
            sx={{ minHeight: 48 }}
            data-testid={`version-${version.versionNumber}`}
          >
            <ListItemText
              primary={
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} component="span">
                  <span>Version {version.versionNumber}</span>
                  {version.versionNumber === currentVersion && <Chip size="small" label="Current" component="span" />}
                </Stack>
              }
              secondary={`${version.summary ?? ORIGIN_LABEL[version.origin] ?? version.origin} · ${formatRelativeTime(version.createdAt)}`}
            />
          </ListItemButton>
          {renderActions?.(version)}
        </Stack>
      ))}
    </List>
  );
}

export default VersionList;
