/**
 * `ScanGymButton` (E3.4): a link to `/gyms/:gymId/scan` when the scan can
 * run; otherwise a disabled button described by the reason (missing
 * permission, AI off, no key, no vision model). A caller without the
 * permissions causes no AI request.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { ScanGymButton } from '../../../components/gyms/ScanGymButton';
import { mockUsableAiModels } from '../../mocks/fixtures/ai';

const GYM_ID = '00000000-0000-4000-8000-a00000000123';
const SCANNER = { ...mockUser, permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'] };

function withModels(data: unknown[]) {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data })));
}

describe('ScanGymButton', () => {
  it('links to the scan page with AI on and a vision model', async () => {
    render(<ScanGymButton gymId={GYM_ID} />, { wrapperOptions: { user: SCANNER, aiEnabled: true } });
    expect(await screen.findByRole('link', { name: 'Scan gym' })).toHaveAttribute('href', `/gyms/${GYM_ID}/scan`);
  });

  it.each<[string, boolean, unknown[], string]>([
    ['AI is off', false, mockUsableAiModels, 'AI is turned off for this app.'],
    ['there is no key', true, [], 'Add your own AI key in Settings → AI to scan.'],
    [
      'no model reads images',
      true,
      [{ ...mockUsableAiModels[0], capabilities: { capabilities: ['responses'], inputModalities: ['text'], outputModalities: ['text'] } }],
      'None of your available models can read images.',
    ],
  ])('is disabled with the reason when %s', async (_case, aiEnabled, models, reason) => {
    withModels(models);
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
      http.get('*/api/ai/models', () => {
        modelReads += 1;
        return HttpResponse.json({ data: mockUsableAiModels });
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
