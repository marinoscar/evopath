/**
 * "Read from photo" visibility (issue #64, E2.6): rendered only with AI on
 * AND `ai:use`, `intakes:write`, `storage:write` and `health_data:write`;
 * otherwise absent (not disabled), and rendering it never makes a request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, mockUser, type MockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { PhotoReadButton } from '../../../components/health/PhotoReadButton';
import { PHOTO_READ_PERMISSIONS } from '../../../hooks/useCanReadFromPhoto';

const ALL = [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'];
const withPermissions = (permissions: string[]): MockUser => ({ ...mockUser, permissions });

let requests: string[];
const onRequest = ({ request }: { request: Request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
};

beforeEach(() => {
  requests = [];
  server.events.on('request:start', onRequest);
});
afterEach(() => {
  server.events.removeListener('request:start', onRequest);
});

describe('PhotoReadButton', () => {
  it('renders with AI on and every permission, and calls onClick', async () => {
    const onClick = vi.fn();
    render(<PhotoReadButton onClick={onClick} />, {
      wrapperOptions: { user: withPermissions(ALL), aiEnabled: true },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read from photo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
  });

  it('is absent while AI is off', () => {
    render(<PhotoReadButton onClick={vi.fn()} />, { wrapperOptions: { user: withPermissions(ALL), aiEnabled: false } });
    expect(screen.queryByRole('button', { name: 'Read from photo' })).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('is absent while the AI answer is unknown (no provider: fail closed)', () => {
    render(<PhotoReadButton onClick={vi.fn()} />, { wrapperOptions: { user: withPermissions(ALL) } });
    expect(screen.queryByRole('button', { name: 'Read from photo' })).not.toBeInTheDocument();
  });

  it.each(PHOTO_READ_PERMISSIONS)('is absent without %s, and no request is made', (missing) => {
    render(<PhotoReadButton onClick={vi.fn()} />, {
      wrapperOptions: { user: withPermissions(ALL.filter((p) => p !== missing)), aiEnabled: true },
    });
    expect(screen.queryByRole('button', { name: 'Read from photo' })).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it.each([
    [true, 'ai:use', false],
    [true, 'storage:write', false],
    [false, 'ai:use', false],
    [false, 'storage:write', false],
  ])('AI on=%s without %s: visible=%s', (ai, missing, visible) => {
    render(<PhotoReadButton onClick={vi.fn()} />, {
      wrapperOptions: { user: withPermissions(ALL.filter((p) => p !== missing)), aiEnabled: ai },
    });
    expect(screen.queryByRole('button', { name: 'Read from photo' }) !== null).toBe(visible);
  });
});
