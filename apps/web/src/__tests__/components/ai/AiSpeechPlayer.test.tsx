/**
 * `AiSpeechPlayer` — issue #445 (API #439). The disclosure is always shown,
 * the player is labelled, and a failed signed-URL read is explained.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  AiSpeechPlayer,
  AI_GENERATED_AUDIO_LABEL,
  AI_SPEECH_PLAYBACK_FAILED_MESSAGE,
  AI_SPEECH_AUTOPLAY_BLOCKED_LABEL,
} from '../../../components/ai/AiSpeechPlayer';
import { SPEECH_OBJECT_ID, mockAiSpeechRunOutput, mockSignedUrl } from '../../mocks/fixtures/ai';
import { isAiResponseRunOutput, isAiSpeechRunOutput, isAiTranscriptionRunOutput } from '../../../services/ai';
import { mockAiResponse, mockAiTranscriptionRunOutput } from '../../mocks/fixtures/ai';

describe('AiSpeechPlayer', () => {
  it('discloses AI-generated audio before the player loads, then plays from the signed URL', async () => {
    const { container } = render(<AiSpeechPlayer output={mockAiSpeechRunOutput} />);
    expect(screen.getByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();
    expect(screen.getByText('Voice coral · MP3 · 11 characters')).toBeInTheDocument();

    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    const audio = container.querySelector('audio')!;
    expect(audio).toHaveAttribute('src', mockSignedUrl(SPEECH_OBJECT_ID));
    expect(audio).toHaveAccessibleName('AI-generated audio, voice coral');
    expect(screen.getByRole('link', { name: 'Download audio' })).toHaveAttribute('download', 'ai-speech.mp3');
  });

  it('explains a download URL that cannot be had, and keeps the disclosure', async () => {
    server.use(
      http.get('*/api/storage/objects/:id/download', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'Object not found' }, { status: 404 }),
      ),
    );
    const { container } = render(<AiSpeechPlayer output={mockAiSpeechRunOutput} />);
    expect(await screen.findByText('Object not found')).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();
  });

  it('explains a playback failure (issue #510) and keeps the download link working', async () => {
    const { container } = render(<AiSpeechPlayer output={mockAiSpeechRunOutput} />);
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    const audio = container.querySelector('audio')!;

    fireEvent.error(audio);

    expect(await screen.findByText(AI_SPEECH_PLAYBACK_FAILED_MESSAGE)).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download audio' })).toHaveAttribute(
      'href',
      mockSignedUrl(SPEECH_OBJECT_ID),
    );
  });
});

describe('run output guards', () => {
  it('tell the four output shapes apart', () => {
    expect(isAiSpeechRunOutput(mockAiSpeechRunOutput)).toBe(true);
    expect(isAiTranscriptionRunOutput(mockAiTranscriptionRunOutput)).toBe(true);
    expect(isAiResponseRunOutput(mockAiResponse)).toBe(true);
    expect(isAiResponseRunOutput(mockAiSpeechRunOutput)).toBe(false);
    expect(isAiSpeechRunOutput(mockAiTranscriptionRunOutput)).toBe(false);
    expect(isAiSpeechRunOutput(null)).toBe(false);
  });

  describe('autoPlay (E7.8, #248)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does not try to play without autoPlay', async () => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      const { container } = render(<AiSpeechPlayer output={mockAiSpeechRunOutput} />);
      await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
      expect(play).not.toHaveBeenCalled();
    });

    it('plays once the signed URL has loaded, and shows no Play button when allowed', async () => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      render(<AiSpeechPlayer output={mockAiSpeechRunOutput} autoPlay />);
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument();
    });

    it('shows a large Play button, not an unhandled rejection, when the browser refuses', async () => {
      const refusal = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(refusal);
      render(<AiSpeechPlayer output={mockAiSpeechRunOutput} autoPlay />);

      const button = await screen.findByRole('button', { name: /^Play/ });
      expect(button).toHaveTextContent(AI_SPEECH_AUTOPLAY_BLOCKED_LABEL);
      play.mockResolvedValueOnce(undefined);
      fireEvent.click(button);
      expect(play).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument());
    });

    it('accepts a stored message without format or character count', async () => {
      render(<AiSpeechPlayer output={{ storageObjectId: SPEECH_OBJECT_ID, voice: 'coral' }} />);
      expect(screen.getByText('Voice coral')).toBeInTheDocument();
      expect(screen.getByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();
    });
  });

  describe('playRequest (#259)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('plays each time the counter grows, from the start, and not at zero', async () => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      const { container, rerender } = render(<AiSpeechPlayer output={mockAiSpeechRunOutput} playRequest={0} />);
      await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
      expect(play).not.toHaveBeenCalled();

      rerender(<AiSpeechPlayer output={mockAiSpeechRunOutput} playRequest={1} />);
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      rerender(<AiSpeechPlayer output={mockAiSpeechRunOutput} playRequest={2} />);
      await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
      expect((container.querySelector('audio') as HTMLAudioElement).currentTime).toBe(0);
    });

    it('offers the Play button when the browser refuses a requested play', async () => {
      const refusal = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(refusal);
      render(<AiSpeechPlayer output={mockAiSpeechRunOutput} playRequest={1} />);
      expect(await screen.findByRole('button', { name: /^Play/ })).toBeInTheDocument();
    });
  });
});
