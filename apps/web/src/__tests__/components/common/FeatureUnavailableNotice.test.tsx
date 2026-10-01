/**
 * `FeatureUnavailableNotice` (#204): per-feature title, the viewer copy, and
 * the admin "Set it up" link that depends on the area's admin permission.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, mockUser } from '../../utils/test-utils';
import {
  FeatureUnavailableNotice,
  featureUnavailableTitle,
  type UnavailableFeature,
} from '../../../components/common/FeatureUnavailableNotice';

const CASES: Array<[UnavailableFeature, string, string, string]> = [
  ['ai', "AI isn't enabled yet", 'ai_config:read', '/admin/settings/ai'],
  ['storage', "Storage isn't enabled yet", 'storage_config:read', '/admin/settings/storage'],
  ['push', "Web Push isn't enabled yet", 'push:read', '/admin/settings/push'],
];
const BODY = "Your administrator hasn't set this up yet.";

describe('FeatureUnavailableNotice', () => {
  it.each(CASES)('%s: title helper matches', (feature, title) => {
    expect(featureUnavailableTitle(feature)).toBe(title);
  });

  describe.each(['inline', 'empty'] as const)('variant %s', (variant) => {
    it.each(CASES)('%s: a viewer is told the administrator has not set it up, with no link', (feature, title) => {
      render(<FeatureUnavailableNotice feature={feature} variant={variant} />, { wrapperOptions: { user: mockUser } });
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(BODY)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Set it up' })).not.toBeInTheDocument();
    });

    it.each(CASES)('%s: the admin permission shows Set it up instead of the viewer copy', (feature, title, permission, path) => {
      render(<FeatureUnavailableNotice feature={feature} variant={variant} />, {
        wrapperOptions: { user: { ...mockUser, permissions: [...mockUser.permissions, permission] } },
      });
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Set it up' })).toHaveAttribute('href', path);
      expect(screen.queryByText(BODY)).not.toBeInTheDocument();
    });
  });

  it('a different area\'s admin permission does not unlock the link', () => {
    render(<FeatureUnavailableNotice feature="storage" />, {
      wrapperOptions: { user: { ...mockUser, permissions: [...mockUser.permissions, 'ai_config:read'] } },
    });
    expect(screen.queryByRole('link', { name: 'Set it up' })).not.toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it('defaults to the inline variant and appends detail', () => {
    render(<FeatureUnavailableNotice feature="ai" detail="You can still build a plan yourself." />, {
      wrapperOptions: { user: mockUser },
    });
    expect(screen.getByTestId('feature-unavailable-ai')).toBeInTheDocument();
    expect(screen.getByText(`${BODY} You can still build a plan yourself.`)).toBeInTheDocument();
  });

  it('empty variant renders the title as a heading', () => {
    render(<FeatureUnavailableNotice feature="push" variant="empty" headingLevel="h3" />, { wrapperOptions: { user: mockUser } });
    expect(screen.getByRole('heading', { level: 3, name: "Web Push isn't enabled yet" })).toBeInTheDocument();
  });
});
