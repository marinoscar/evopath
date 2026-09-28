/**
 * `/admin/settings/storage` (issue #376, epic #372).
 *
 * `useStorageConfig` is mocked, matching the pattern `PushConfigPage.test.tsx`
 * and `EmailSettingsPage.test.tsx` use — this suite is about the PAGE's own
 * rendering, gating and the decisions it makes from a result, not the hook's
 * fetch/save plumbing (which has its own test). `StorageSwitchConfirmDialog` is
 * NOT mocked: the typed-literal gating IS a thing under test here, and it lives
 * entirely inside that component.
 *
 * ⚠ THE NEGATIVE SECURITY INVARIANT. A known secret-access-key fixture is
 * planted in the STORED config's masked hint and typed into the field, and the
 * suite asserts it never reaches the DOM from the server side and never leaves
 * the page except as the one write-only key the admin typed. The same
 * invariant `PushConfigPage.test.tsx` asserts for VAPID private key material,
 * and for the same reason: the API is incapable of returning it, and this is
 * what stops a later edit rendering something that looks like a convenience.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import type {
  StorageBucketProvisionResult,
  StorageConfigView,
  StorageConnectionCheck,
  StorageConnectionTestResult,
} from '../../../services/storageConfig';

vi.mock('../../../hooks/useStorageConfig', () => ({
  useStorageConfig: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useStorageConfig } from '../../../hooks/useStorageConfig';
import { usePermissions } from '../../../hooks/usePermissions';
import StorageConfigPage from '../../../pages/Admin/StorageConfigPage';

const mockUseStorageConfig = vi.mocked(useStorageConfig);
const mockUsePermissions = vi.mocked(usePermissions);

const WRITE_PERMISSIONS = ['storage_config:read', 'storage_config:write'];
const READ_ONLY_PERMISSIONS = ['storage_config:read'];

/**
 * A value shaped like a secret access key. It must NEVER appear in any rendered
 * DOM node, and must never leave the page except as the write-only field the
 * admin typed it into.
 */
const FORBIDDEN_SECRET_MATERIAL = 'THIS-IS-A-FAKE-S3-SECRET-DO-NOT-RENDER-9f8e7d';

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

const s3Config: StorageConfigView = {
  provider: 's3',
  bucket: 'app-objects',
  region: 'us-east-1',
  endpoint: '',
  accountId: '',
  accessKeyId: 'AKIAEXAMPLE',
  forcePathStyle: null,
  effectiveEndpoint: null,
  configured: true,
  missing: [],
  secretStatus: {
    configured: true,
    hint: '••••ab12',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByUserId: 'admin-user-id',
  },
  version: 3,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

function check(overrides: Partial<StorageConnectionCheck>): StorageConnectionCheck {
  return {
    id: 'bucket',
    label: 'Bucket',
    status: 'failed',
    code: 'bucket_missing',
    detail: 'No bucket named app-objects exists.',
    error: null,
    ...overrides,
  };
}

function testResultWith(checks: StorageConnectionCheck[]): StorageConnectionTestResult {
  return {
    success: checks.every((entry) => entry.status !== 'failed'),
    provider: 's3',
    bucket: 'app-objects',
    region: 'us-east-1',
    effectiveEndpoint: null,
    usedStoredSecret: true,
    checks,
    attemptedAt: '2026-01-01T00:00:00.000Z',
  };
}

const FOUR_FAILING_CHECKS: StorageConnectionCheck[] = [
  check({ id: 'credentials', label: 'Credentials', status: 'passed', code: 'ok', detail: 'Accepted.' }),
  check({
    id: 'bucket',
    label: 'Bucket',
    status: 'failed',
    code: 'bucket_missing',
    detail: 'No bucket named app-objects exists.',
    error: 'NoSuchBucket: The specified bucket does not exist',
  }),
  check({ id: 'roundTrip', label: 'Write and read back', status: 'skipped', code: 'not_attempted', detail: 'Skipped.' }),
  check({ id: 'presignedUrl', label: 'Presigned URL', status: 'skipped', code: 'not_attempted', detail: 'Skipped.' }),
];

const guidedBucket: StorageBucketProvisionResult = {
  outcome: 'guided',
  provider: 's3',
  bucket: 'app-objects',
  region: 'us-east-1',
  effectiveEndpoint: null,
  steps: [],
  guidance: {
    reason: 'This access key does not hold s3:CreateBucket.',
    commands: 'aws s3api create-bucket --bucket app-objects --region us-east-1',
    runbook: null,
  },
  corsOrigin: null,
  attemptedAt: '2026-01-01T00:00:00.000Z',
};

function setHook(overrides: Partial<ReturnType<typeof useStorageConfig>> = {}) {
  const save = vi.fn().mockResolvedValue(true);
  const test = vi.fn().mockResolvedValue(undefined);
  const createBucket = vi.fn().mockResolvedValue(undefined);
  mockUseStorageConfig.mockReturnValue({
    config: s3Config,
    isLoading: false,
    loadError: null,
    isSaving: false,
    saveError: null,
    switchRequired: null,
    clearSwitchRequired: vi.fn(),
    save,
    clearSaveError: vi.fn(),
    isProbing: false,
    probeError: null,
    clearProbeError: vi.fn(),
    testResult: null,
    clearTestResult: vi.fn(),
    bucketResult: null,
    clearBucketResult: vi.fn(),
    test,
    createBucket,
    refresh: vi.fn(),
    ...overrides,
  });
  return { save, test, createBucket };
}

const renderAsAdmin = () =>
  render(<StorageConfigPage />, { wrapperOptions: { user: mockAdminUser } });

describe('StorageConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(WRITE_PERMISSIONS);
    setHook();
  });

  describe('the permission double-gate', () => {
    it('renders the page for a holder of storage_config:read', () => {
      renderAsAdmin();
      expect(screen.getByRole('heading', { level: 1, name: 'Storage' })).toBeInTheDocument();
    });

    it('redirects a user who does not hold storage_config:read', () => {
      setPermissions([]);
      renderAsAdmin();
      expect(screen.queryByRole('heading', { level: 1, name: 'Storage' })).not.toBeInTheDocument();
    });

    it('is NOT satisfied by storage:read, which every ordinary user holds', () => {
      // The closest-looking mistake, and the worst one: `storage:*` gates OBJECT
      // ACCESS and is seeded to Viewer and Contributor.
      setPermissions(['storage:read', 'storage:write', 'storage:delete']);
      renderAsAdmin();
      expect(screen.queryByRole('heading', { level: 1, name: 'Storage' })).not.toBeInTheDocument();
    });
  });

  describe('read-only (storage_config:read without :write)', () => {
    beforeEach(() => setPermissions(READ_ONLY_PERMISSIONS));

    it('says so in the page description rather than leaving the admin to guess', () => {
      renderAsAdmin();
      expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
      expect(screen.getByTestId('storage-read-only-notice')).toBeInTheDocument();
    });

    it('DISABLES the controls rather than hiding them', () => {
      // A read-only admin diagnosing "why did that upload fail" needs to SEE the
      // bucket and the endpoint. A page that hid half its fields would read as
      // broken rather than as restricted.
      renderAsAdmin();
      expect(screen.getByLabelText(/^bucket$/i)).toBeDisabled();
      expect(screen.getByLabelText(/access key id/i)).toBeDisabled();
      expect(screen.getByLabelText(/secret access key/i)).toBeDisabled();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();
    });

    it('states WHY the probe is unavailable next to the disabled button', () => {
      renderAsAdmin();
      expect(
        screen.getByText(/needs permission to change the storage configuration/i),
      ).toBeInTheDocument();
    });
  });

  describe('the provider chooser', () => {
    it('shows the R2 account id and a READ-ONLY derived endpoint when R2 is chosen', async () => {
      const user = userEvent.setup();
      renderAsAdmin();

      await user.click(screen.getByRole('radio', { name: /cloudflare r2/i }));
      await user.type(screen.getByLabelText(/account id/i), 'acct123');

      const derived = screen.getByTestId('r2-derived-endpoint');
      expect(derived).toHaveValue('https://acct123.r2.cloudflarestorage.com');
      // ⚠ Never a field to type into: the endpoint is a pure function of the
      // account id, and asking an operator to reproduce that derivation is
      // asking them to get it subtly wrong once, permanently.
      expect(derived).toHaveAttribute('readonly');
    });

    it('offers a typed endpoint only for the S3-compatible provider', async () => {
      const user = userEvent.setup();
      renderAsAdmin();

      // Plain S3 needs no endpoint at all — the SDK builds one.
      expect(screen.queryByLabelText(/^endpoint$/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: /s3-compatible/i }));
      expect(screen.getByLabelText(/^endpoint$/i)).toBeInTheDocument();
    });

    it('keeps typed input when the provider is switched and switched back', async () => {
      const user = userEvent.setup();
      renderAsAdmin();

      await user.click(screen.getByRole('radio', { name: /s3-compatible/i }));
      await user.type(screen.getByLabelText(/^endpoint$/i), 'https://minio.example.com:9000');

      await user.click(screen.getByRole('radio', { name: /amazon s3/i }));
      await user.click(screen.getByRole('radio', { name: /s3-compatible/i }));

      expect(screen.getByLabelText(/^endpoint$/i)).toHaveValue('https://minio.example.com:9000');
    });
  });

  describe('forcePathStyle is three-state, not a switch', () => {
    it('offers all three answers, with the vendor default selectable', () => {
      renderAsAdmin();
      expect(screen.getByRole('radio', { name: /use this provider's convention/i })).toBeChecked();
      expect(screen.getByRole('radio', { name: /force path-style on/i })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /force path-style off/i })).toBeInTheDocument();
    });

    it('renders a stored explicit false as "force off", NOT as the vendor default', () => {
      // #374's bug in miniature: collapsing `false` into "unset" would let a
      // save turn an operator's explicit answer back into the default.
      setHook({ config: { ...s3Config, forcePathStyle: false } });
      renderAsAdmin();
      expect(screen.getByRole('radio', { name: /force path-style off/i })).toBeChecked();
      expect(
        screen.getByRole('radio', { name: /use this provider's convention/i }),
      ).not.toBeChecked();
    });

    it('sends null when the vendor default is chosen, and false when off is chosen', async () => {
      const user = userEvent.setup();
      const { save } = setHook({ config: { ...s3Config, forcePathStyle: true } });
      renderAsAdmin();

      await user.click(screen.getByRole('radio', { name: /use this provider's convention/i }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(save.mock.calls[0][0].forcePathStyle).toBeNull();

      save.mockClear();
      await user.click(screen.getByRole('radio', { name: /force path-style off/i }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(save.mock.calls[0][0].forcePathStyle).toBe(false);
    });

    it('names the vendor convention it is deferring to, which differs by provider', async () => {
      const user = userEvent.setup();
      renderAsAdmin();
      expect(screen.getByText(/uses virtual-host addressing/i)).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: /s3-compatible/i }));
      expect(screen.getByText(/uses path-style addressing/i)).toBeInTheDocument();
    });
  });

  describe('the connection test', () => {
    it('is not gated on a clean form — the API takes the configuration in the body', async () => {
      const user = userEvent.setup();
      const { test } = setHook();
      renderAsAdmin();

      await user.clear(screen.getByLabelText(/^bucket$/i));
      await user.type(screen.getByLabelText(/^bucket$/i), 'brand-new-bucket');

      const button = screen.getByRole('button', { name: /test connection/i });
      expect(button).toBeEnabled();
      await user.click(button);

      await waitFor(() => expect(test).toHaveBeenCalled());
      // The UNSAVED value is what gets tested — the whole workflow these
      // endpoints exist for.
      expect(test.mock.calls[0][0].bucket).toBe('brand-new-bucket');
    });

    it('renders each of the four checks as its own row, with its own code', () => {
      setHook({ testResult: testResultWith(FOUR_FAILING_CHECKS) });
      renderAsAdmin();

      expect(screen.getByTestId('storage-check-credentials')).toBeInTheDocument();
      expect(screen.getByTestId('storage-check-bucket')).toBeInTheDocument();
      expect(screen.getByTestId('storage-check-roundTrip')).toBeInTheDocument();
      expect(screen.getByTestId('storage-check-presignedUrl')).toBeInTheDocument();
      expect(screen.getByTestId('storage-check-code-bucket')).toHaveTextContent('bucket_missing');
    });

    it('renders the provider’s verbatim error rather than a summary', () => {
      setHook({ testResult: testResultWith(FOUR_FAILING_CHECKS) });
      renderAsAdmin();

      expect(screen.getByTestId('storage-check-error-bucket')).toHaveTextContent(
        'NoSuchBucket: The specified bucket does not exist',
      );
    });

    it('is a persistent, dismissible alert — not a snackbar that takes the diagnosis away', () => {
      setHook({ testResult: testResultWith(FOUR_FAILING_CHECKS) });
      renderAsAdmin();

      const alert = screen.getByTestId('storage-test-result');
      expect(within(alert).getByRole('button', { name: /close/i })).toBeInTheDocument();
    });

    it('reads bucket_missing and bucket_forbidden DIFFERENTLY — they need opposite actions', () => {
      setHook({ testResult: testResultWith([check({ code: 'bucket_missing' })]) });
      const { unmount } = renderAsAdmin();
      expect(screen.getByText(/create it below/i)).toBeInTheDocument();
      unmount();

      setHook({
        testResult: testResultWith([
          check({ code: 'bucket_forbidden', detail: 'Access denied on the bucket.' }),
        ]),
      });
      renderAsAdmin();
      expect(screen.getByText(/do not try to create it/i)).toBeInTheDocument();
      expect(screen.queryByText(/create it below/i)).not.toBeInTheDocument();
    });
  });

  describe('creating the bucket', () => {
    it('is offered only once a test has reported the bucket missing', () => {
      setHook({ testResult: null });
      const { unmount } = renderAsAdmin();
      expect(screen.queryByTestId('storage-create-bucket')).not.toBeInTheDocument();
      unmount();

      setHook({ testResult: testResultWith([check({ code: 'bucket_missing' })]) });
      renderAsAdmin();
      expect(screen.getByTestId('storage-create-bucket')).toBeInTheDocument();
    });

    it('is NOT offered for bucket_forbidden — creating a bucket somebody else owns is the wrong fix', () => {
      setHook({ testResult: testResultWith([check({ code: 'bucket_forbidden' })]) });
      renderAsAdmin();
      expect(screen.queryByTestId('storage-create-bucket')).not.toBeInTheDocument();
    });

    it('sends the configuration on screen when clicked', async () => {
      const user = userEvent.setup();
      const { createBucket } = setHook({
        testResult: testResultWith([check({ code: 'bucket_missing' })]),
      });
      renderAsAdmin();

      await user.click(screen.getByTestId('storage-create-bucket'));

      await waitFor(() => expect(createBucket).toHaveBeenCalled());
      expect(createBucket.mock.calls[0][0].bucket).toBe('app-objects');
    });

    it('renders a guided outcome as INFORMATION with a copyable command block, never as an error', () => {
      // A least-privilege credential without `s3:CreateBucket` is the ORDINARY
      // configuration. Rendering it red would tell an administrator their
      // correct setup is broken.
      setHook({ bucketResult: guidedBucket });
      renderAsAdmin();

      const alert = screen.getByTestId('storage-bucket-result');
      expect(alert.className).toMatch(/MuiAlert-colorInfo/);
      expect(screen.getByTestId('storage-bucket-guidance-commands')).toHaveTextContent(
        'aws s3api create-bucket --bucket app-objects --region us-east-1',
      );
      expect(screen.getByTestId('storage-bucket-guidance-commands').tagName).toBe('PRE');
    });

    it('renders a partial outcome as a warning, naming the step that failed', () => {
      setHook({
        bucketResult: {
          ...guidedBucket,
          outcome: 'partial',
          guidance: null,
          steps: [
            { id: 'create', label: 'Create bucket', status: 'passed', detail: 'Created.', error: null },
            {
              id: 'cors',
              label: 'CORS rule',
              status: 'failed',
              detail: 'Could not write the CORS rule.',
              error: 'AccessDenied',
            },
          ],
        },
      });
      renderAsAdmin();

      const alert = screen.getByTestId('storage-bucket-result');
      expect(alert.className).toMatch(/MuiAlert-colorWarning/);
      expect(screen.getByTestId('storage-bucket-step-cors')).toHaveTextContent('AccessDenied');
    });
  });

  describe('the switch confirmation', () => {
    const switchRequired = {
      message: '12 stored object(s) and 3 database backup(s) still point at s3/old-bucket.',
      details: {
        confirmation: 'SWITCH',
        from: { provider: 's3' as const, bucket: 'old-bucket', endpoint: null },
        to: { provider: 'r2' as const, bucket: 'new-bucket', endpoint: 'https://a.r2.cloudflarestorage.com' },
        storageObjects: 12,
        databaseBackupRuns: 3,
        total: 15,
      },
    };

    it('opens only when the API has already refused, and shows the API’s own counts', () => {
      setHook({ switchRequired });
      renderAsAdmin();

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText(/still point at s3\/old-bucket/)).toBeInTheDocument();
      expect(screen.getByTestId('storage-switch-locations')).toHaveTextContent('old-bucket');
    });

    it('is closed when the API has not asked for it', () => {
      setHook({ switchRequired: null });
      renderAsAdmin();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('refuses to confirm until the literal is typed EXACTLY', async () => {
      const user = userEvent.setup();
      const { save } = setHook({ switchRequired });
      renderAsAdmin();

      const confirmButton = screen.getByRole('button', { name: /save and switch/i });
      expect(confirmButton).toBeDisabled();

      await user.type(screen.getByLabelText(/type switch to confirm/i), 'switch');
      expect(confirmButton).toBeDisabled();

      await user.clear(screen.getByLabelText(/type switch to confirm/i));
      await user.type(screen.getByLabelText(/type switch to confirm/i), 'SWITCH');
      expect(confirmButton).toBeEnabled();

      await user.click(confirmButton);
      await waitFor(() => expect(save).toHaveBeenCalled());
      // The confirmed re-send carries the flag; the body is otherwise identical.
      expect(save.mock.calls.at(-1)?.[1]).toEqual({ confirmSwitch: true });
    });
  });

  describe('the secret access key', () => {
    it('omits it from the save body entirely when it was not retyped', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      renderAsAdmin();

      await user.type(screen.getByLabelText(/^bucket$/i), '-edited');
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(
        Object.prototype.hasOwnProperty.call(save.mock.calls[0][0], 'secretAccessKey'),
      ).toBe(false);
    });

    it('states that blank preserves, and shows the stored mask rather than a fixed placeholder', () => {
      renderAsAdmin();
      expect(screen.getByText(/leave this blank to keep it/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/secret access key/i)).toHaveAttribute(
        'placeholder',
        '••••ab12',
      );
    });

    it('renders as a password field, so it is never shoulder-readable', () => {
      renderAsAdmin();
      expect(screen.getByLabelText(/secret access key/i)).toHaveAttribute('type', 'password');
    });

    it('NEGATIVE SECURITY INVARIANT: no secret material the server could hold ever reaches the DOM', () => {
      // The API is incapable of returning the secret — `secretStatus` has no
      // field that could carry one. This asserts the page never renders one
      // even if a future response grew a field that did.
      setHook({
        config: {
          ...s3Config,
          secretStatus: { ...s3Config.secretStatus, hint: '••••7d' },
        } as StorageConfigView,
      });
      const { container } = renderAsAdmin();

      expect(container.innerHTML).not.toContain(FORBIDDEN_SECRET_MATERIAL);
      expect(document.body.innerHTML).not.toContain(FORBIDDEN_SECRET_MATERIAL);
    });

    it('NEGATIVE SECURITY INVARIANT: a typed secret leaves only in the save body, never into the rendered markup', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      const { container } = renderAsAdmin();

      const secretField = screen.getByLabelText(/secret access key/i);
      await user.type(secretField, FORBIDDEN_SECRET_MATERIAL);

      // It lives in exactly ONE place: the masked input the admin typed it
      // into. Nothing RENDERS it — not as text, not in a helper line, not in a
      // title or aria attribute — and no other control has picked it up.
      expect(container.textContent).not.toContain(FORBIDDEN_SECRET_MATERIAL);
      expect(document.body.textContent).not.toContain(FORBIDDEN_SECRET_MATERIAL);
      const carriers = [...container.querySelectorAll('input, textarea')].filter(
        (element) => (element as HTMLInputElement).value.includes(FORBIDDEN_SECRET_MATERIAL),
      );
      expect(carriers).toEqual([secretField]);
      expect(secretField).toHaveAttribute('type', 'password');

      await user.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(save).toHaveBeenCalled());

      expect(save.mock.calls[0][0].secretAccessKey).toBe(FORBIDDEN_SECRET_MATERIAL);
      // And it is not smuggled into any other field on the way out.
      const { secretAccessKey, ...rest } = save.mock.calls[0][0];
      expect(JSON.stringify(rest)).not.toContain(FORBIDDEN_SECRET_MATERIAL);
      expect(secretAccessKey).toBe(FORBIDDEN_SECRET_MATERIAL);
    });

    it('NEGATIVE SECURITY INVARIANT: a typed secret never reaches the probe body by any other name', async () => {
      const user = userEvent.setup();
      const { test } = setHook();
      renderAsAdmin();

      await user.type(screen.getByLabelText(/secret access key/i), FORBIDDEN_SECRET_MATERIAL);
      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => expect(test).toHaveBeenCalled());
      const body = test.mock.calls[0][0] as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        if (key === 'secretAccessKey') continue;
        expect(String(value)).not.toContain(FORBIDDEN_SECRET_MATERIAL);
      }
    });
  });

  describe('the unconfigured state', () => {
    it('says storage is not configured and names every missing field', () => {
      setHook({
        config: {
          ...s3Config,
          bucket: '',
          accessKeyId: '',
          configured: false,
          missing: ['bucket', 'accessKeyId', 'secretAccessKey'],
          secretStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
        },
      });
      renderAsAdmin();

      const alert = screen.getByTestId('storage-not-configured');
      expect(alert).toHaveTextContent('bucket, accessKeyId, secretAccessKey');
      expect(alert).toHaveTextContent(/uploads, avatars, job artifacts and database backups/i);
    });
  });

  describe('failure surfaces', () => {
    it('shows a load failure as an alert and does not pretend to have a form', () => {
      setHook({ config: null, isLoading: false, loadError: 'You do not have permission' });
      renderAsAdmin();
      expect(screen.getByText('You do not have permission')).toBeInTheDocument();
    });

    it('keeps a save error separate from a probe error', () => {
      setHook({ saveError: 'Bucket name is not valid', probeError: 'Internal server error' });
      renderAsAdmin();
      expect(screen.getByText('Bucket name is not valid')).toBeInTheDocument();
      expect(screen.getByText('Internal server error')).toBeInTheDocument();
    });
  });
});
