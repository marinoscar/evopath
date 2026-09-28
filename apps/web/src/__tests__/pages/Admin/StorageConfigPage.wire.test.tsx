/**
 * `/admin/settings/storage` — the WIRE contract (issue #376, epic #372).
 *
 * Deliberately NOT mocking `useStorageConfig`: the behaviours below live in the
 * page's own `toInput()` and in the hook's 409 handling, which only a real
 * round trip exercises together. `usePermissions` and `useAuth` are real too
 * (via `mockAdminUser`), and only the network is faked, with MSW. Matches
 * `EmailSettingsPage.wire.test.tsx`.
 *
 * Four things are proved here that a mocked-hook test cannot:
 *
 *   1. BLANK PRESERVES. The secret access key key is OMITTED from the body
 *      entirely when it was not retyped, and present with the typed value when
 *      it was.
 *   2. `forcePathStyle: null` REACHES THE WIRE AS `null`. The tri-state's whole
 *      point, and the one value a boolean control would have destroyed.
 *   3. `If-Match` CARRIES THE LOADED VERSION.
 *   4. THE SWITCH ROUND TRIP. A 409 `STORAGE_LOCATION_IN_USE` opens the dialog
 *      rather than reloading the form, and the confirmed re-send carries the
 *      typed literal with an otherwise IDENTICAL body — the edit the admin is
 *      confirming survives intact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import StorageConfigPage from '../../../pages/Admin/StorageConfigPage';
import type { StorageConfigView } from '../../../services/storageConfig';

const storedConfig: StorageConfigView = {
  provider: 's3compatible',
  bucket: 'app-objects',
  region: 'us-east-1',
  endpoint: 'https://minio.example.com:9000',
  accountId: '',
  accessKeyId: 'AKIAEXAMPLE',
  forcePathStyle: null,
  effectiveEndpoint: 'https://minio.example.com:9000',
  configured: true,
  missing: [],
  secretStatus: {
    configured: true,
    hint: '••••ab12',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByUserId: 'admin-user-id',
  },
  version: 5,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

interface CapturedRequest {
  body: Record<string, unknown>;
  ifMatch: string | null;
}

function mockGet(config: StorageConfigView = storedConfig) {
  server.use(
    http.get('*/api/admin/storage-config', () => HttpResponse.json({ data: config })),
  );
}

function mockPut(captured: CapturedRequest[]) {
  server.use(
    http.put('*/api/admin/storage-config', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      captured.push({ body, ifMatch: request.headers.get('If-Match') });
      return HttpResponse.json({
        data: { ...storedConfig, ...body, version: storedConfig.version + 1 },
      });
    }),
  );
}

async function renderLoaded() {
  const user = userEvent.setup();
  render(<StorageConfigPage />, { wrapperOptions: { user: mockAdminUser } });
  await screen.findByLabelText(/^bucket$/i);
  return user;
}

describe('StorageConfigPage — save request wire contract', () => {
  beforeEach(() => {
    server.resetHandlers();
    mockGet();
  });

  it('omits secretAccessKey from the body entirely when the field is left empty', async () => {
    const captured: CapturedRequest[] = [];
    mockPut(captured);

    const user = await renderLoaded();
    // Dirty the form WITHOUT touching the secret field.
    await user.type(screen.getByLabelText(/^bucket$/i), '-edited');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(Object.prototype.hasOwnProperty.call(captured[0].body, 'secretAccessKey')).toBe(false);
    expect(captured[0].body.bucket).toBe('app-objects-edited');
  });

  it('DOES include secretAccessKey, with the typed value, when one is typed', async () => {
    const captured: CapturedRequest[] = [];
    mockPut(captured);

    const user = await renderLoaded();
    await user.type(screen.getByLabelText(/secret access key/i), 'rotated-secret-value');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].body.secretAccessKey).toBe('rotated-secret-value');
  });

  it('sends the loaded version as If-Match', async () => {
    const captured: CapturedRequest[] = [];
    mockPut(captured);

    const user = await renderLoaded();
    await user.type(screen.getByLabelText(/^bucket$/i), '-edited');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].ifMatch).toBe('5');
  });

  it('puts forcePathStyle on the wire as null when the vendor default is chosen', async () => {
    const captured: CapturedRequest[] = [];
    mockPut(captured);

    const user = await renderLoaded();
    // Leave it on the vendor default and dirty something else.
    await user.type(screen.getByLabelText(/^bucket$/i), '-edited');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(Object.prototype.hasOwnProperty.call(captured[0].body, 'forcePathStyle')).toBe(true);
    expect(captured[0].body.forcePathStyle).toBeNull();
  });

  it('puts an explicit "force off" on the wire as false, which is NOT the same value', async () => {
    const captured: CapturedRequest[] = [];
    mockPut(captured);

    const user = await renderLoaded();
    await user.click(screen.getByRole('radio', { name: /force path-style off/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].body.forcePathStyle).toBe(false);
  });

  it('sends the unsaved form to POST /test, so a new bucket can be proved before committing to it', async () => {
    let testBody: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/admin/storage-config/test', async ({ request }) => {
        testBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          data: {
            success: false,
            provider: 's3compatible',
            bucket: 'not-saved-yet',
            region: 'us-east-1',
            effectiveEndpoint: 'https://minio.example.com:9000',
            usedStoredSecret: true,
            checks: [
              {
                id: 'bucket',
                label: 'Bucket',
                status: 'failed',
                code: 'bucket_missing',
                detail: 'No such bucket.',
                error: 'NoSuchBucket',
              },
            ],
            attemptedAt: '2026-01-01T00:00:00.000Z',
          },
        });
      }),
    );

    const user = await renderLoaded();
    await user.clear(screen.getByLabelText(/^bucket$/i));
    await user.type(screen.getByLabelText(/^bucket$/i), 'not-saved-yet');
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(testBody).not.toBeNull());
    expect(testBody!.bucket).toBe('not-saved-yet');

    // And a 200 carrying `success: false` renders as the diagnosis, not as a
    // success — the mistake that would make this whole page useless.
    const result = await screen.findByTestId('storage-test-result');
    expect(result).toHaveTextContent('bucket_missing');
    // The bucket is genuinely absent, so the remedy is offered.
    expect(await screen.findByTestId('storage-create-bucket')).toBeInTheDocument();
  });

  it('opens the SWITCH dialog on a 409 STORAGE_LOCATION_IN_USE and re-sends the identical body with the literal', async () => {
    const captured: CapturedRequest[] = [];
    let refused = false;
    server.use(
      http.put('*/api/admin/storage-config', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        captured.push({ body, ifMatch: request.headers.get('If-Match') });
        if (!refused) {
          refused = true;
          return HttpResponse.json(
            {
              code: 'STORAGE_LOCATION_IN_USE',
              message: '12 stored object(s) and 3 database backup(s) still point at s3compatible/app-objects.',
              details: {
                confirmation: 'SWITCH',
                from: {
                  provider: 's3compatible',
                  bucket: 'app-objects',
                  endpoint: 'https://minio.example.com:9000',
                },
                to: {
                  provider: 's3compatible',
                  bucket: 'somewhere-else',
                  endpoint: 'https://minio.example.com:9000',
                },
                storageObjects: 12,
                databaseBackupRuns: 3,
                total: 15,
              },
            },
            { status: 409 },
          );
        }
        return HttpResponse.json({
          data: { ...storedConfig, ...body, version: storedConfig.version + 1 },
        });
      }),
    );

    const user = await renderLoaded();
    await user.clear(screen.getByLabelText(/^bucket$/i));
    await user.type(screen.getByLabelText(/^bucket$/i), 'somewhere-else');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // The dialog, not a generic error — and NOT a reloaded form, which would
    // have thrown away the very edit being confirmed.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('still point at');
    expect(screen.getByLabelText(/^bucket$/i)).toHaveValue('somewhere-else');

    await user.type(screen.getByLabelText(/type switch to confirm/i), 'SWITCH');
    await user.click(screen.getByRole('button', { name: /save and switch/i }));

    await waitFor(() => expect(captured).toHaveLength(2));
    const [first, second] = captured;
    expect(first.body).not.toHaveProperty('confirmation');
    expect(second.body.confirmation).toBe('SWITCH');
    // Otherwise IDENTICAL: the confirmed re-send is the same save, not a new one.
    const { confirmation, ...secondWithoutLiteral } = second.body;
    expect(confirmation).toBe('SWITCH');
    expect(secondWithoutLiteral).toEqual(first.body);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('reloads the form on a PLAIN 409, which is a different answer entirely', async () => {
    let refused = false;
    server.use(
      http.put('*/api/admin/storage-config', async () => {
        refused = true;
        return HttpResponse.json(
          { message: 'Storage settings version mismatch. Expected 5, found 9' },
          { status: 409 },
        );
      }),
    );

    const user = await renderLoaded();
    await user.type(screen.getByLabelText(/^bucket$/i), '-edited');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/someone else changed the storage configuration/i)).toBeInTheDocument();
    expect(refused).toBe(true);
    // No dialog: the remedy here is a reload, not a typed word.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a guided bucket outcome as a paste-ready block rather than a failure', async () => {
    server.use(
      http.post('*/api/admin/storage-config/test', () =>
        HttpResponse.json({
          data: {
            success: false,
            provider: 's3compatible',
            bucket: 'app-objects',
            region: 'us-east-1',
            effectiveEndpoint: 'https://minio.example.com:9000',
            usedStoredSecret: true,
            checks: [
              {
                id: 'bucket',
                label: 'Bucket',
                status: 'failed',
                code: 'bucket_missing',
                detail: 'No such bucket.',
                error: null,
              },
            ],
            attemptedAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      ),
      http.post('*/api/admin/storage-config/bucket', () =>
        HttpResponse.json({
          data: {
            outcome: 'guided',
            provider: 's3compatible',
            bucket: 'app-objects',
            region: 'us-east-1',
            effectiveEndpoint: 'https://minio.example.com:9000',
            steps: [],
            guidance: {
              reason: 'This access key does not hold s3:CreateBucket.',
              commands: 'mc mb local/app-objects\nmc anonymous set none local/app-objects',
              runbook: null,
            },
            corsOrigin: null,
            attemptedAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      ),
    );

    const user = await renderLoaded();
    await user.click(screen.getByRole('button', { name: /test connection/i }));
    await user.click(await screen.findByTestId('storage-create-bucket'));

    const block = await screen.findByTestId('storage-bucket-guidance-commands');
    // A 200 carrying `guided` is a SUCCESSFUL answer with instructions in it.
    expect(block).toHaveTextContent('mc mb local/app-objects');
    expect(block.tagName).toBe('PRE');
  });
});
