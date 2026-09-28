/**
 * `AiPlaygroundModeSelector` and the mode registry — issue #445.
 *
 * Modes are derived from capabilities alone; the selector is a labelled,
 * keyboard-operable segmented control whose unavailable modes stay focusable
 * and explain themselves.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { AiPlaygroundModeSelector } from '../../../components/ai/playground/AiPlaygroundModeSelector';
import {
  AI_PLAYGROUND_MODES,
  aiPlaygroundMode,
  hiddenPlaygroundModes,
  initialPlaygroundMode,
  modelsForMode,
  unavailableModes,
  type AiPlaygroundModeId,
} from '../../../components/ai/playground/aiPlaygroundModes';
import type { UsableAiModel } from '../../../services/ai';

function model(modelId: string, capabilities: string[]): UsableAiModel {
  return {
    provider: 'acme',
    modelId,
    displayName: null,
    capabilities: { capabilities, inputModalities: ['text'], outputModalities: ['text'] },
    keySource: 'user',
  };
}

describe('aiPlaygroundModes', () => {
  // Deliberately odd model ids: nothing may depend on a model's name.
  const models = [model('zz-1', ['responses', 'streaming']), model('qq-2', ['embeddings']), model('pp-3', ['image_generation'])];

  it('maps each mode to exactly one capability', () => {
    expect(AI_PLAYGROUND_MODES.map((mode) => [mode.id, mode.capability])).toEqual([
      ['chat', 'responses'],
      ['image', 'image_generation'],
      ['transcribe', 'audio_transcription'],
      ['speech', 'audio_speech'],
      ['embeddings', 'embeddings'],
      ['voice', 'realtime'],
    ]);
  });

  it('filters models by the mode capability', () => {
    expect(modelsForMode(models, aiPlaygroundMode('embeddings')).map((m) => m.modelId)).toEqual(['qq-2']);
    expect(modelsForMode(models, aiPlaygroundMode('image')).map((m) => m.modelId)).toEqual(['pp-3']);
    expect(modelsForMode(models, aiPlaygroundMode('speech'))).toEqual([]);
  });

  it('reports modes no model can serve', () => {
    expect([...unavailableModes(models)].sort()).toEqual(['speech', 'transcribe', 'voice']);
    expect(unavailableModes([]).size).toBe(AI_PLAYGROUND_MODES.length);
  });

  it('hides Voice unless realtime sessions are allowed (#449)', () => {
    expect([...hiddenPlaygroundModes({ allowRealtime: false })]).toEqual(['voice']);
    // An older API that omits the flag reads as off.
    expect([...hiddenPlaygroundModes({})]).toEqual(['voice']);
    expect(hiddenPlaygroundModes({ allowRealtime: true }).size).toBe(0);
  });

  it('treats a hidden mode as unavailable even when a model can serve it', () => {
    const realtime = [model('rr-9', ['realtime'])];
    expect(unavailableModes(realtime).has('voice')).toBe(false);
    expect(unavailableModes(realtime, new Set(['voice'])).has('voice')).toBe(true);
    expect(initialPlaygroundMode(realtime)).toBe('voice');
    expect(initialPlaygroundMode(realtime, new Set(['voice']))).toBe('chat');
  });

  it('opens on Chat when usable, else on the first usable mode', () => {
    expect(initialPlaygroundMode(models)).toBe('chat');
    expect(initialPlaygroundMode([model('a', ['embeddings'])])).toBe('embeddings');
    expect(initialPlaygroundMode([])).toBe('chat');
  });
});

describe('AiPlaygroundModeSelector', () => {
  function renderSelector(
    value: AiPlaygroundModeId = 'chat',
    unavailable: AiPlaygroundModeId[] = ['speech'],
    hidden: AiPlaygroundModeId[] = [],
  ) {
    const onChange = vi.fn();
    render(
      <AiPlaygroundModeSelector
        value={value}
        onChange={onChange}
        unavailable={new Set(unavailable)}
        hidden={new Set(hidden)}
      />,
    );
    return { onChange, user: userEvent.setup() };
  }

  it('marks the selected mode pressed', () => {
    renderSelector('image');
    expect(screen.getByRole('button', { name: 'Image' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('selects a mode on click, and ignores the selected and unavailable ones', async () => {
    const { onChange, user } = renderSelector();
    await user.click(screen.getByRole('button', { name: 'Embeddings' }));
    expect(onChange).toHaveBeenCalledWith('embeddings');

    onChange.mockClear();
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    await user.click(screen.getByRole('button', { name: 'Speech' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an unavailable mode focusable, describing why via its tooltip', async () => {
    const { user } = renderSelector();
    const speech = screen.getByRole('button', { name: 'Speech' });
    expect(speech).toHaveAttribute('aria-disabled', 'true');
    expect(speech).not.toBeDisabled();

    screen.getByRole('button', { name: 'Transcribe' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(speech).toHaveFocus();
    // The reason is the description, never the name.
    expect(await screen.findByRole('tooltip')).toHaveTextContent('None of the models available to you can generate speech');
    expect(speech).toHaveAccessibleName('Speech');
  });

  it('moves focus with Home/End and wraps with the arrow keys', async () => {
    const { user, onChange } = renderSelector();
    screen.getByRole('button', { name: 'Chat' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Voice' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenCalledWith('transcribe');
  });

  it('does not render a hidden mode, and keyboard movement skips it (#449)', async () => {
    const { user } = renderSelector('chat', ['speech'], ['voice']);
    expect(screen.queryByRole('button', { name: 'Voice' })).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Chat' }).focus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Embeddings' })).toHaveFocus();
  });
});
