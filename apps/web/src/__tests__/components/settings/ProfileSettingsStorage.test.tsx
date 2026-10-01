/** `ProfileSettings` upload mode when storage is not configured (#204). */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { ProfileSettings } from '../../../components/settings/ProfileSettings';
import type { UserSettings } from '../../../types';

const upload: UserSettings['profile'] = { displayName: undefined, imageSource: 'upload', imageObjectId: null };

function storage(configured: boolean | 'error') {
  server.use(
    http.get('*/api/storage/status', () =>
      configured === 'error'
        ? HttpResponse.json({ statusCode: 500, code: 'INTERNAL', message: 'boom' }, { status: 500 })
        : HttpResponse.json({ data: { configured } }),
    ),
  );
}

describe('ProfileSettings: storage not configured', () => {
  it('upload mode with storage false shows the notice and no upload control', async () => {
    storage(false);
    render(<ProfileSettings profile={upload} onSave={async () => {}} />, { wrapperOptions: { user: mockUser } });
    expect(await screen.findByText("Storage isn't enabled yet")).toBeInTheDocument();
    expect(screen.getByText(/You can still use the picture from your sign-in provider, or none\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload picture/i })).not.toBeInTheDocument();
  });

  it('an unknown answer keeps the upload control', async () => {
    storage('error');
    render(<ProfileSettings profile={upload} onSave={async () => {}} />, { wrapperOptions: { user: mockUser } });
    await waitFor(() => expect(screen.getByRole('button', { name: /upload picture/i })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Storage isn't enabled yet")).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload picture/i })).toBeInTheDocument();
  });

  it('storage configured keeps the upload control', async () => {
    storage(true);
    render(<ProfileSettings profile={upload} onSave={async () => {}} />, { wrapperOptions: { user: mockUser } });
    expect(await screen.findByRole('button', { name: /upload picture/i })).toBeInTheDocument();
    expect(screen.queryByText("Storage isn't enabled yet")).not.toBeInTheDocument();
  });
});
