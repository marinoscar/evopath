/**
 * "{Feature} isn't enabled yet" — issue #204.
 *
 * Shown in place of a call-to-action that cannot work because an
 * administrator has not configured the feature behind it (AI, object storage,
 * Web Push), so the control does not disappear silently or fail on use.
 *
 * A viewer who holds the admin read permission for that area is offered
 * **Set it up**, a link to the admin page that turns it on; everyone else is
 * told their administrator has not set it up. The permission only decides
 * which words to show: the admin route and its API enforce their own gates.
 *
 * `variant="empty"` builds on `EmptyState` (a page or list with nothing to
 * show); `variant="inline"` is an info `Alert` (next to or instead of one
 * control).
 */
import { Link as RouterLink } from 'react-router-dom';
import { Alert, AlertTitle, Button } from '@mui/material';
import {
  AutoAwesomeOutlined as AiIcon,
  CloudOffOutlined as StorageIcon,
  NotificationsOffOutlined as PushIcon,
} from '@mui/icons-material';
import type { SvgIconComponent } from '@mui/icons-material';
import { EmptyState } from './EmptyState';
import { usePermissions } from '../../hooks/usePermissions';

export type UnavailableFeature = 'ai' | 'storage' | 'push';

interface FeatureMeta {
  name: string;
  /** The admin permission that reaches the setup page (its registry card's `permission`). */
  permission: string;
  /** The admin settings page that turns the feature on. */
  setupPath: string;
  Icon: SvgIconComponent;
}

export const FEATURE_UNAVAILABLE_META: Record<UnavailableFeature, FeatureMeta> = {
  ai: { name: 'AI', permission: 'ai_config:read', setupPath: '/admin/settings/ai', Icon: AiIcon },
  storage: {
    name: 'Storage',
    permission: 'storage_config:read',
    setupPath: '/admin/settings/storage',
    Icon: StorageIcon,
  },
  push: { name: 'Web Push', permission: 'push:read', setupPath: '/admin/settings/push', Icon: PushIcon },
};

export const FEATURE_UNAVAILABLE_BODY = "Your administrator hasn't set this up yet.";
export const FEATURE_SET_UP_LABEL = 'Set it up';

/** "AI isn't enabled yet" — also used where only a one-line reason fits. */
export function featureUnavailableTitle(feature: UnavailableFeature): string {
  return `${FEATURE_UNAVAILABLE_META[feature].name} isn't enabled yet`;
}

export interface FeatureUnavailableNoticeProps {
  feature: UnavailableFeature;
  variant?: 'empty' | 'inline';
  /** An optional extra sentence after the standard copy, e.g. what still works. */
  detail?: string;
  /** Heading level for `variant="empty"`. */
  headingLevel?: 'h2' | 'h3';
}

export function FeatureUnavailableNotice({
  feature,
  variant = 'inline',
  detail,
  headingLevel = 'h2',
}: FeatureUnavailableNoticeProps) {
  const { hasPermission } = usePermissions();
  const meta = FEATURE_UNAVAILABLE_META[feature];
  const canSetUp = hasPermission(meta.permission);
  const title = featureUnavailableTitle(feature);
  const setUp = canSetUp ? (
    <Button component={RouterLink} to={meta.setupPath} variant="outlined" size="small" sx={{ minHeight: 36 }}>
      {FEATURE_SET_UP_LABEL}
    </Button>
  ) : null;
  // An administrator gets the action instead of being told to ask themselves.
  const text = [canSetUp ? null : FEATURE_UNAVAILABLE_BODY, detail ?? null].filter(Boolean).join(' ');

  if (variant === 'empty') {
    return (
      <EmptyState
        Icon={meta.Icon}
        title={title}
        description={text || undefined}
        action={setUp}
        headingLevel={headingLevel}
      />
    );
  }

  return (
    <Alert
      severity="info"
      icon={<meta.Icon fontSize="inherit" />}
      data-testid={`feature-unavailable-${feature}`}
      action={setUp}
      sx={{ '& .MuiAlert-action': { alignItems: 'center', pt: 0 } }}
    >
      <AlertTitle sx={{ mb: text ? 0.5 : 0 }}>{title}</AlertTitle>
      {text || null}
    </Alert>
  );
}

export default FeatureUnavailableNotice;
