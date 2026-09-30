/**
 * `ScanGymButton` (E3.4): a link to `/gyms/:gymId/scan` when the scan can
 * run; otherwise a disabled button described by the reason (missing
 * permission, AI off, no key, no assigned model, a failed check). A caller without the
 * permissions causes no AI request.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { ScanGymButton } from '../../../components/gyms/ScanGymButton';
import { mockAiFeaturesView, mockBlockedFeatureView } from '../../mocks/fixtures/aiFeatures';

const GYM_ID = '00000000-0000-4000-8000-a00000000123';
const SCANNER = { ...mockUser, permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'] };

function withFeature(view: ReturnType<typeof mockAiFeaturesView> | null) {
  server.use(
    http.get('*/api/ai/features', () =>
      view
        ? HttpResponse.json({ data: view })
        : HttpResponse.json({ statusCode: 500, code: 'INTERNAL', message: 'boom' }, { status: 500 }),
    ),
  );
}

describe('ScanGymButton', () => {
  it('links to the scan page with AI on and a vision model', async () => {
    render(<ScanGymButton gymId={GYM_ID} />, { wrapperOptions: { user: SCANNER, aiEnabled: true } });
    expect(await screen.findByRole('link', { name: 'Scan gym' })).toHaveAttribute('href', `/gyms/${GYM_ID}/scan`);
  });

  it.each<[string, boolean, ReturnType<typeof mockAiFeaturesView> | null, string]>([
    ['AI is off', false, mockAiFeaturesView(), 'AI is turned off for this app.'],
    [
      'there is no key',
      true,
      mockAiFeaturesView({ gym_scan: mockBlockedFeatureView('gym_scan', 'no_key', 'keys') }),
      'Add your own AI key in Settings → AI Keys to scan.',
    ],
    [
      'no model is assigned',
      true,
      mockAiFeaturesView({ gym_scan: mockBlockedFeatureView('gym_scan', 'missing_capability', 'admin') }),
      "Your administrator hasn't assigned an AI model that can read photos yet.",
    ],
    ['the check fails', true, null, "Couldn't check AI availability."],
  ])('is disabled with the reason when %s', async (_case, aiEnabled, view, reason) => {
    withFeature(view);
    render(<ScanGymButton gymId={GYM_ID} />, { wrapperOptions: { user: SCANNER, aiEnabled } });
    const button = await screen.findByRole('button', { name: 'Scan gym' });
    expect(button).toBeDisabled();
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription(reason);
  });

  it.each<[string, string]>([
    ['ai:use', 'Your account cannot use AI features.'],
    ['storage:write', 'Scanning needs permission to upload photos, which your account does not have.'],
    ['intakes:write', 'Scanning needs permission to start a photo scan, which your account does not have.'],
  ])('is disabled without %s and asks nothing of the AI API', async (permission, reason) => {
    let modelReads = 0;
    server.use(
      http.get('*/api/ai/features', () => {
        modelReads += 1;
        return HttpResponse.json({ data: mockAiFeaturesView() });
      }),
    );
    const user = { ...SCANNER, permissions: SCANNER.permissions.filter((p) => p !== permission) };
    render(<ScanGymButton gymId={GYM_ID} />, { wrapperOptions: { user, aiEnabled: true } });
    const button = screen.getByRole('button', { name: 'Scan gym' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(reason);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(modelReads).toBe(0);
  });
});
