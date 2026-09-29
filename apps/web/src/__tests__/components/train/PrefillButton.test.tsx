/**
 * `PrefillButton` (E4.5): a link to `/train/workouts/:id/prefill` when the
 * prefill can run; otherwise a disabled button described by the reason
 * (missing permission, AI off, no key, no vision model). A caller without the
 * permissions (a viewer) causes no AI request.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { PrefillButton } from '../../../components/train/PrefillButton';
import { mockUsableAiModels } from '../../mocks/fixtures/ai';

const WORKOUT_ID = '00000000-0000-4000-8000-e00000000123';
const PREFILLER = { ...mockUser, permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'] };

function withModels(data: unknown[]) {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data })));
}

describe('PrefillButton', () => {
  it('links to the prefill page with AI on and a vision model', async () => {
    render(<PrefillButton workoutId={WORKOUT_ID} />, { wrapperOptions: { user: PREFILLER, aiEnabled: true } });
    expect(await screen.findByRole('link', { name: 'Prefill from photo' })).toHaveAttribute(
      'href',
      `/train/workouts/${WORKOUT_ID}/prefill`,
    );
  });

  it.each<[string, boolean, unknown[], string]>([
    ['AI is off', false, mockUsableAiModels, 'AI is turned off for this app.'],
    ['there is no key', true, [], 'Add your own AI key in Settings → AI to prefill from photos.'],
    [
      'no model reads images',
      true,
      [{ ...mockUsableAiModels[0], capabilities: { capabilities: ['responses'], inputModalities: ['text'], outputModalities: ['text'] } }],
      'None of your available models can read images.',
    ],
  ])('is disabled with the reason when %s', async (_case, aiEnabled, models, reason) => {
    withModels(models);
    render(<PrefillButton workoutId={WORKOUT_ID} />, { wrapperOptions: { user: PREFILLER, aiEnabled } });
    const button = await screen.findByRole('button', { name: 'Prefill from photo' });
    expect(button).toBeDisabled();
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription(reason);
  });

  it.each<[string, string]>([
    ['ai:use', 'Your account cannot use AI features.'],
    ['storage:write', 'Prefilling needs permission to upload photos, which your account does not have.'],
    ['intakes:write', 'Prefilling needs permission to start a photo prefill, which your account does not have.'],
    ['exercises:write', 'Prefilling needs permission to add exercises, which your account does not have.'],
  ])('is disabled without %s and asks nothing of the AI API', async (permission, reason) => {
    let modelReads = 0;
    server.use(
      http.get('*/api/ai/models', () => {
        modelReads += 1;
        return HttpResponse.json({ data: mockUsableAiModels });
      }),
    );
    const user = { ...PREFILLER, permissions: PREFILLER.permissions.filter((p) => p !== permission) };
    render(<PrefillButton workoutId={WORKOUT_ID} />, { wrapperOptions: { user, aiEnabled: true } });
    const button = screen.getByRole('button', { name: 'Prefill from photo' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(reason);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(modelReads).toBe(0);
  });
});
