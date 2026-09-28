import { http, HttpResponse } from 'msw';
import {
  mockAiAdminConfig,
  mockAiModelList,
  mockAiModels,
  mockAiProbeResultPassed,
  mockAiPublicConfigDisabled,
  mockAiResponse,
  mockAiImageRun,
  mockAiSpeechRunOutput,
  mockAiTranscriptionRunOutput,
  mockMediaRun,
  mockAiRun,
  mockAiStreamEvents,
  mockAiEmbeddingsFor,
  mockSignedUrl,
  mockStorageObject,
  MOCK_IMAGE_RUN_PREFIX,
  mockAiUsageReport,
  mockUsableAiModels,
  mockUserAiKeys,
  toSseBody,
} from './fixtures/ai';
import {
  mockTelemetryAdminConfig,
  mockTelemetryConnectionAutomaticStored,
  mockTelemetryConnectionCustomStored,
  mockTelemetryConnectionEnvironment,
  mockTelemetryConnectionStored,
  mockTelemetryConnectionTestResult,
  mockTelemetryPublicConfigDisabled,
  mockTelemetryQueryResult,
  mockTelemetrySchema,
  mockTelemetryStackRunning,
  mockTelemetryStatus,
} from './fixtures/telemetry';
import type {
  AiAdminConfig,
  AiAdminConfigInput,
  AiAdminConfigWithWarnings,
  AiModel,
  AiModelUpdateInput,
  AiUsageGroupBy,
} from '../../services/ai';

// Use wildcard pattern to match relative URLs
const API_BASE = '*/api';

// Mock data
const mockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  profileImageUrl: null,
  roles: [{ name: 'viewer' }],
  permissions: ['user_settings:read', 'user_settings:write'],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const mockUserSettings = {
  theme: 'system',
  profile: {
    displayName: null,
    imageSource: 'provider',
    imageObjectId: null,
  },
  updatedAt: new Date().toISOString(),
  version: 1,
};

const mockSystemSettings = {
  notifications: {
    browserEnabled: true,
    disabledEvents: [],
  },
  updatedAt: new Date().toISOString(),
  updatedBy: null,
  version: 1,
};

const mockProviders = [
  { name: 'google', authUrl: '/api/auth/google' },
];

export const handlers = [
  // Auth endpoints
  http.get(`${API_BASE}/auth/providers`, () => {
    // Real API returns { providers: [...] } which gets unwrapped by api.ts
    return HttpResponse.json({ providers: mockProviders });
  }),

  http.get(`${API_BASE}/auth/me`, () => {
    return HttpResponse.json({ data: mockUser });
  }),

  http.post(`${API_BASE}/auth/logout`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/auth/refresh`, () => {
    return HttpResponse.json({
      accessToken: 'new-mock-token',
      expiresIn: 900,
    });
  }),

  // User settings endpoints
  http.get(`${API_BASE}/user-settings`, () => {
    return HttpResponse.json({ data: mockUserSettings });
  }),

  http.put(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  // Profile picture endpoints (#367) — POST to upload, DELETE to remove.
  // Both return `{ settings, profileImageUrl }` after the client's `data` unwrap.
  http.post(`${API_BASE}/user-settings/profile-image`, () => {
    return HttpResponse.json({
      data: {
        settings: {
          ...mockUserSettings,
          profile: {
            ...mockUserSettings.profile,
            imageSource: 'upload',
            imageObjectId: 'mock-object-id',
          },
          version: mockUserSettings.version + 1,
          updatedAt: new Date().toISOString(),
        },
        profileImageUrl: 'https://example.com/uploaded-mock.jpg',
      },
    });
  }),

  http.delete(`${API_BASE}/user-settings/profile-image`, () => {
    return HttpResponse.json({
      data: {
        settings: {
          ...mockUserSettings,
          profile: {
            ...mockUserSettings.profile,
            imageSource: 'provider',
            imageObjectId: null,
          },
          version: mockUserSettings.version + 1,
          updatedAt: new Date().toISOString(),
        },
        profileImageUrl: null,
      },
    });
  }),

  // System settings endpoints
  http.get(`${API_BASE}/system-settings`, () => {
    return HttpResponse.json({ data: mockSystemSettings });
  }),

  http.patch(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockSystemSettings,
        ...body,
        version: mockSystemSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.put(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...body,
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        version: 1,
      },
    });
  }),

  // Users endpoints
  http.get(`${API_BASE}/users`, () => {
    return HttpResponse.json({
      items: [
        {
          id: mockUser.id,
          email: mockUser.email,
          displayName: mockUser.displayName,
          providerDisplayName: 'Test User (Provider)',
          profileImageUrl: mockUser.profileImageUrl,
          providerProfileImageUrl: null,
          isActive: mockUser.isActive,
          roles: mockUser.roles.map((r) => r.name),
          createdAt: mockUser.createdAt,
          updatedAt: mockUser.createdAt,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });
  }),

  http.get(`${API_BASE}/users/:id`, ({ params }) => {
    if (params.id === mockUser.id) {
      return HttpResponse.json({ data: mockUser });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  http.patch(`${API_BASE}/users/:id`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName: (body.displayName as string | null) ?? mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive: body.isActive !== undefined ? (body.isActive as boolean) : mockUser.isActive,
        roles: mockUser.roles.map((r) => r.name),
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  http.put(`${API_BASE}/users/:id/roles`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as { roles: string[] };
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName: mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive: mockUser.isActive,
        roles: body.roles,
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  // Health endpoints
  http.get(`${API_BASE}/health/live`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    });
  }),

  http.get(`${API_BASE}/health/ready`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'ok',
        },
      },
    });
  }),

  // Device Authorization endpoints
  http.get(`${API_BASE}/auth/device/activate`, ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');

    // Default success response
    return HttpResponse.json({
      data: {
        userCode: code || 'ABCD-1234',
        clientInfo: {
          deviceName: 'My Smart TV',
          userAgent: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
          ipAddress: '192.168.1.100',
        },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
  }),

  http.post(`${API_BASE}/auth/device/authorize`, async ({ request }) => {
    const body = (await request.json()) as { userCode: string; approve: boolean };

    return HttpResponse.json({
      data: {
        success: body.approve,
        message: body.approve
          ? 'Device authorized successfully!'
          : 'Device access denied.',
      },
    });
  }),

  // ===========================================================================
  // AI (issue #425, epic #419). Fixtures live in `./fixtures/ai.ts` so the page
  // stories (#429, #430, #434) reuse them. `GET /ai/config` defaults to AI
  // DISABLED — a fresh deployment; override it per test to switch AI on.
  // ===========================================================================

  // ===========================================================================
  // Telemetry (issue #537, epic #528). `GET /telemetry/config` defaults to
  // UNAVAILABLE — a deployment without a telemetry store. Fixtures live in
  // `./fixtures/telemetry.ts`.
  // ===========================================================================

  http.get(`${API_BASE}/telemetry/config`, () => {
    return HttpResponse.json({ data: mockTelemetryPublicConfigDisabled });
  }),

  http.get(`${API_BASE}/admin/telemetry/config`, () => {
    return HttpResponse.json({ data: mockTelemetryAdminConfig });
  }),

  http.put(`${API_BASE}/admin/telemetry/config`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const ifMatch = request.headers.get('If-Match');
    if (ifMatch !== null && Number(ifMatch) !== mockTelemetryAdminConfig.version) {
      return HttpResponse.json(
        { code: 'CONFLICT', message: 'The telemetry configuration was changed by someone else' },
        { status: 409 },
      );
    }
    // `instanceId` absent keeps the stored value; the effective one follows (#565).
    const instanceId =
      'instanceId' in body ? (body.instanceId as string | null) : mockTelemetryAdminConfig.instanceId;
    return HttpResponse.json({
      data: {
        ...mockTelemetryAdminConfig,
        ...body,
        instanceId,
        instanceIdEffective: instanceId ?? mockTelemetryAdminConfig.instanceIdDefault,
        version: mockTelemetryAdminConfig.version + 1,
      },
    });
  }),

  http.get(`${API_BASE}/admin/telemetry/status`, () => {
    return HttpResponse.json({ data: mockTelemetryStatus });
  }),

  // GreptimeDB connection (#558). If-Match is checked against the stored
  // connection's OWN version, never `/config`'s.
  http.get(`${API_BASE}/admin/telemetry/connection`, () => {
    return HttpResponse.json({ data: mockTelemetryConnectionStored });
  }),

  http.put(`${API_BASE}/admin/telemetry/connection`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const ifMatch = request.headers.get('If-Match');
    if (ifMatch !== null && Number(ifMatch) !== mockTelemetryConnectionStored.version) {
      return HttpResponse.json(
        { code: 'CONFLICT', message: 'The telemetry connection was changed by someone else' },
        { status: 409 },
      );
    }
    // Omitted, null or blank host is automatic (#562, #570): the deployment
    // supplies the rest, and every other field is ignored.
    const rawHost = body.host;
    const host = typeof rawHost === 'string' && rawHost.trim() ? rawHost.trim() : null;
    if (host === null) {
      return HttpResponse.json({
        data: {
          ...mockTelemetryConnectionAutomaticStored,
          version: mockTelemetryConnectionStored.version + 1,
        },
      });
    }
    const { readerPassword: _reader, adminPassword: _admin, host: _host, ...rest } = body;
    return HttpResponse.json({
      data: {
        ...mockTelemetryConnectionCustomStored,
        ...rest,
        host,
        effectiveHost: host,
        version: mockTelemetryConnectionStored.version + 1,
      },
    });
  }),

  http.delete(`${API_BASE}/admin/telemetry/connection`, () => {
    return HttpResponse.json({ data: mockTelemetryConnectionEnvironment });
  }),

  http.post(`${API_BASE}/admin/telemetry/connection/test`, async ({ request }) => {
    const body = (await request.json()) as { host?: string | null };
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : null;
    return HttpResponse.json({
      data: {
        ...mockTelemetryConnectionTestResult,
        host: host ?? mockTelemetryConnectionTestResult.host,
        hostMode: host ? 'custom' : 'auto',
      },
    });
  }),

  // Telemetry services (#567). Defaults to a healthy, deployed stack.
  http.get(`${API_BASE}/admin/telemetry/stack`, () => {
    return HttpResponse.json({ data: mockTelemetryStackRunning });
  }),

  http.post(`${API_BASE}/admin/telemetry/stack/deploy`, () => {
    return HttpResponse.json({ data: { jobId: 'job-deploy-1' } }, { status: 202 });
  }),

  http.get(`${API_BASE}/admin/telemetry/schema`, () => {
    return HttpResponse.json({ data: mockTelemetrySchema });
  }),

  http.post(`${API_BASE}/admin/telemetry/query`, () => {
    return HttpResponse.json({ data: mockTelemetryQueryResult });
  }),

  http.post(`${API_BASE}/admin/telemetry/export`, () => {
    return new HttpResponse('a,b\n1,2\n', {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename=telemetry-1.csv',
        'X-Telemetry-Row-Count': '1',
        'X-Telemetry-Truncated': 'false',
      },
    });
  }),

  http.get(`${API_BASE}/ai/config`, () => {
    return HttpResponse.json({ data: mockAiPublicConfigDisabled });
  }),

  http.get(`${API_BASE}/admin/ai/config`, () => {
    return HttpResponse.json({ data: mockAiAdminConfig });
  }),

  // PUT is a FULL REPLACE (#428): for each provider in the body, an omitted,
  // '' or null `baseUrl` clears the override; an omitted or null
  // `maxOutputTokensCap` clears the cap. A provider left out keeps its row.
  http.put(`${API_BASE}/admin/ai/config`, async ({ request }) => {
    const body = (await request.json()) as AiAdminConfigInput;
    const ifMatch = request.headers.get('If-Match');
    if (ifMatch !== null && Number(ifMatch) !== mockAiAdminConfig.version) {
      return HttpResponse.json(
        { code: 'CONFLICT', message: 'The AI configuration was changed by someone else' },
        { status: 409 },
      );
    }
    for (const [id, entry] of Object.entries(body.providers)) {
      const known = mockAiAdminConfig.providers.find((provider) => provider.id === id);
      if (!known) {
        return HttpResponse.json(
          { code: 'BAD_REQUEST', message: `Unknown AI provider: ${id}`, details: { reason: 'AI_UNKNOWN_PROVIDER' } },
          { status: 400 },
        );
      }
      // #448: a field the provider does not list in `settingsFields` is refused.
      const allowed = new Set<string>(['enabled', ...(known.settingsFields ?? ['baseUrl'])]);
      const field = Object.keys(entry).find((key) => !allowed.has(key));
      if (field) {
        return HttpResponse.json(
          {
            code: 'BAD_REQUEST',
            message: `The ${id} provider does not accept ${field}`,
            details: { reason: 'AI_PROVIDER_FIELD_UNSUPPORTED', provider: id, field },
          },
          { status: 400 },
        );
      }
    }
    return HttpResponse.json({
      data: {
        ...mockAiAdminConfig,
        enabled: body.enabled,
        keyPolicy: body.keyPolicy,
        logPromptContent: body.logPromptContent,
        defaults: {
          maxOutputTokensCap: body.defaults.maxOutputTokensCap ?? null,
          allowBackgroundRuns: body.defaults.allowBackgroundRuns,
        },
        hostedTools: body.hostedTools ?? mockAiAdminConfig.hostedTools,
        // Omitted keeps the stored value; sent, it replaces it wholesale (#450).
        limits: body.limits ?? mockAiAdminConfig.limits,
        providers: mockAiAdminConfig.providers.map((provider) => {
          const next = body.providers[provider.id];
          if (!next) return provider;
          return {
            ...provider,
            enabled: next.enabled,
            baseUrl: next.baseUrl || null,
            apiVersion: next.apiVersion || null,
            apiStyle: next.apiStyle ?? null,
            deployments: next.deployments && Object.keys(next.deployments).length > 0 ? next.deployments : null,
            requiresKey: next.requiresKey ?? null,
          };
        }),
        version: mockAiAdminConfig.version + 1,
      } satisfies AiAdminConfig,
    });
  }),

  http.put(`${API_BASE}/admin/ai/providers/:provider/key`, () => {
    return HttpResponse.json({ data: mockAiAdminConfig });
  }),

  http.delete(`${API_BASE}/admin/ai/providers/:provider/key`, () => {
    return HttpResponse.json({
      data: {
        ...mockAiAdminConfig,
        providers: mockAiAdminConfig.providers.map((provider) => ({
          ...provider,
          keyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
        })),
        warnings: [],
      } satisfies AiAdminConfigWithWarnings,
    });
  }),

  http.post(`${API_BASE}/admin/ai/providers/:provider/test`, () => {
    // Always 200 — the outcome is in the body.
    return HttpResponse.json({ data: mockAiProbeResultPassed });
  }),

  http.get(`${API_BASE}/admin/ai/models`, () => {
    return HttpResponse.json({ data: mockAiModelList });
  }),

  http.post(`${API_BASE}/admin/ai/models/refresh`, () => {
    return HttpResponse.json({ data: { jobId: 'job-ai-refresh-1', status: 'pending' } });
  }),

  http.patch(`${API_BASE}/admin/ai/models/:id`, async ({ params, request }) => {
    const body = (await request.json()) as AiModelUpdateInput;
    const model = mockAiModels.find((entry) => entry.id === params.id);
    if (!model) {
      return HttpResponse.json({ code: 'NOT_FOUND', message: 'Model not found' }, { status: 404 });
    }
    if (body.enabled && model.deprecatedAt) {
      return HttpResponse.json(
        { code: 'CONFLICT', message: 'This model has been withdrawn by the provider', details: { reason: 'AI_MODEL_DEPRECATED' } },
        { status: 409 },
      );
    }
    if (body.enabled && model.capabilitySource === 'unclassified' && !body.capabilities) {
      return HttpResponse.json(
        { code: 'BAD_REQUEST', message: 'Classify this model before enabling it', details: { reason: 'AI_MODEL_UNCLASSIFIED' } },
        { status: 400 },
      );
    }
    return HttpResponse.json({
      data: {
        ...model,
        ...body,
        ...(body.capabilities ? { capabilitySource: 'admin_override' as const } : {}),
      } satisfies AiModel,
    });
  }),

  // Usage aggregates (#443 contract, #444 UI): a populated report for
  // whichever `groupBy` was asked for.
  http.get(`${API_BASE}/admin/ai/usage`, ({ request }) => {
    const groupBy = (new URL(request.url).searchParams.get('groupBy') ?? 'day') as AiUsageGroupBy;
    return HttpResponse.json({ data: mockAiUsageReport(groupBy) });
  }),

  http.get(`${API_BASE}/ai/usage/me`, ({ request }) => {
    const groupBy = (new URL(request.url).searchParams.get('groupBy') ?? 'day') as AiUsageGroupBy;
    return HttpResponse.json({ data: mockAiUsageReport(groupBy) });
  }),

  http.get(`${API_BASE}/ai/keys`, () => {
    return HttpResponse.json({ data: mockUserAiKeys });
  }),

  http.put(`${API_BASE}/ai/keys/:provider`, ({ params }) => {
    return HttpResponse.json({
      data: { ...mockUserAiKeys[0], provider: String(params.provider) },
    });
  }),

  http.delete(`${API_BASE}/ai/keys/:provider`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/ai/keys/:provider/test`, () => {
    return HttpResponse.json({ data: mockAiProbeResultPassed });
  }),

  http.get(`${API_BASE}/ai/models`, () => {
    return HttpResponse.json({ data: mockUsableAiModels });
  }),

  http.post(`${API_BASE}/ai/responses/stream`, () => {
    return new HttpResponse(toSseBody(mockAiStreamEvents), {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }),

  http.post(`${API_BASE}/ai/responses`, () => {
    return HttpResponse.json({ data: mockAiResponse });
  }),

  http.post(`${API_BASE}/ai/runs`, () => {
    return HttpResponse.json({ data: { runId: mockAiRun.id, jobId: 'job-ai-run-1' } }, { status: 202 });
  }),

  http.get(`${API_BASE}/ai/runs/:id`, ({ params }) => {
    const id = String(params.id);
    const run = id.startsWith(MOCK_IMAGE_RUN_PREFIX)
      ? mockAiImageRun
      : id.startsWith('run_transcribe')
        ? mockMediaRun(id, mockAiTranscriptionRunOutput)
        : id.startsWith('run_speech')
          ? mockMediaRun(id, mockAiSpeechRunOutput)
          : mockAiRun;
    return HttpResponse.json({ data: { ...run, id } });
  }),

  // Embeddings (#440): synchronous, one deterministic vector per input.
  http.post(`${API_BASE}/ai/embeddings`, async ({ request }) => {
    const body = (await request.json()) as { input: string | string[]; dimensions?: number };
    return HttpResponse.json({ data: mockAiEmbeddingsFor(body.input, body.dimensions) });
  }),

  // Image runs (#437): always 202, then polled through `GET /ai/runs/:id`.
  http.post(`${API_BASE}/ai/images`, () => {
    return HttpResponse.json({ data: { runId: 'run_img_1', jobId: 'job-ai-image-1' } }, { status: 202 });
  }),

  http.post(`${API_BASE}/ai/images/edits`, () => {
    return HttpResponse.json({ data: { runId: 'run_img_edit_1', jobId: 'job-ai-image-2' } }, { status: 202 });
  }),

  // Audio runs (#438, #439): always 202, then polled through `GET /ai/runs/:id`.
  http.post(`${API_BASE}/ai/audio/transcriptions`, () => {
    return HttpResponse.json({ data: { runId: 'run_transcribe_1', jobId: 'job-ai-audio-1' } }, { status: 202 });
  }),

  http.post(`${API_BASE}/ai/audio/speech`, () => {
    return HttpResponse.json({ data: { runId: 'run_speech_1', jobId: 'job-ai-audio-2' } }, { status: 202 });
  }),

  // Storage objects (#445 playground inputs/outputs): an upload answers
  // `processing`, a read answers `ready`, and a download is a signed URL.
  http.post(`${API_BASE}/storage/objects`, () => {
    return HttpResponse.json({ data: mockStorageObject() }, { status: 201 });
  }),

  http.get(`${API_BASE}/storage/objects/:id/download`, ({ params }) => {
    return HttpResponse.json({ data: { url: mockSignedUrl(String(params.id)), expiresIn: 300 } });
  }),

  http.get(`${API_BASE}/storage/objects/:id`, ({ params }) => {
    return HttpResponse.json({ data: mockStorageObject({ id: String(params.id), status: 'ready' }) });
  }),

  http.post(`${API_BASE}/ai/runs/:id/cancel`, ({ params }) => {
    return HttpResponse.json({
      data: { ...mockAiRun, id: String(params.id), status: 'cancelled', output: null },
    });
  }),
];
