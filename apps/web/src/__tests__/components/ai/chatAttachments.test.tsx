/**
 * Chat attachment rules and chips — issue #445 (mirrors #441's API rules).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  attachableKinds,
  attachmentKind,
  attachmentProblem,
  chatTurnInput,
  withAttachmentContext,
  type AiChatAttachment,
} from '../../../components/ai/playground/chatAttachments';
import { AiAttachmentChips } from '../../../components/ai/AiAttachmentChips';
import type { UsableAiModel } from '../../../services/ai';

function model(capabilities: string[], inputModalities: string[]): UsableAiModel {
  return {
    provider: 'acme',
    modelId: 'm',
    displayName: null,
    capabilities: { capabilities: ['responses', ...capabilities], inputModalities, outputModalities: ['text'] },
    keySource: 'user',
  };
}

describe('chatAttachments', () => {
  it('decides the kind by MIME type, as the API does', () => {
    expect(attachmentKind('image/gif')).toBe('image');
    expect(attachmentKind('IMAGE/PNG; charset=binary')).toBe('image');
    expect(attachmentKind('image/svg+xml')).toBe('file');
    expect(attachmentKind('application/pdf')).toBe('file');
  });

  it('needs the capability AND the input modality', () => {
    expect(attachableKinds(model(['vision_input', 'file_input'], ['text', 'image', 'file']))).toEqual({ image: true, file: true });
    expect(attachableKinds(model(['vision_input'], ['text']))).toEqual({ image: false, file: false });
    expect(attachableKinds(model([], ['text', 'image', 'file']))).toEqual({ image: false, file: false });
    expect(attachableKinds(null)).toEqual({ image: false, file: false });
  });

  it('refuses unreadable kinds and oversize files', () => {
    const vision = model(['vision_input'], ['text', 'image']);
    expect(attachmentProblem(new File(['x'], 'a.png', { type: 'image/png' }), vision)).toBeNull();
    expect(attachmentProblem(new File(['x'], 'a.pdf', { type: 'application/pdf' }), vision)).toBe("This model can't read files");
    const big = new File(['x'], 'b.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    expect(attachmentProblem(big, vision)).toBe('Images must be 20.0 MB or smaller');
  });

  it('keeps a plain string input without attachments and builds parts with them', () => {
    const attachments: AiChatAttachment[] = [
      { storageObjectId: 'i', name: 'a.png', mimeType: 'image/png', size: 1, kind: 'image' },
      { storageObjectId: 'f', name: 'b.pdf', mimeType: 'application/pdf', size: 1, kind: 'file' },
    ];
    expect(chatTurnInput('hi', [])).toBe('hi');
    expect(chatTurnInput('hi', attachments)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', storageObjectId: 'i' },
          { type: 'file', storageObjectId: 'f', filename: 'b.pdf' },
        ],
      },
    ]);
  });

  it('explains plain 404/403 answers only when the turn had attachments', () => {
    const notFound = { code: null, message: 'Not found', status: 404 };
    expect(withAttachmentContext(notFound, false)).toBe(notFound);
    expect(withAttachmentContext(notFound, true).message).toMatch(/could not be found/);
    expect(withAttachmentContext({ code: null, message: 'x', status: 403 }, true).message).toMatch(/do not have access/);
    const coded = { code: 'AI_INVALID_REQUEST', message: 'too big', status: 400 };
    expect(withAttachmentContext(coded, true)).toBe(coded);
  });
});

describe('AiAttachmentChips', () => {
  it('names each chip, spells out a problem, and removes by key', async () => {
    const onRemove = vi.fn();
    render(
      <AiAttachmentChips
        onRemove={onRemove}
        items={[
          { key: 'k1', name: 'a.png', size: 2048, kind: 'image' },
          { key: 'k2', name: 'b.pdf', size: 10, kind: 'file', problem: "This model can't read files" },
        ]}
      />,
    );
    expect(screen.getByLabelText('a.png, 2 KB')).toBeInTheDocument();
    expect(screen.getByLabelText("b.pdf, 10 B: This model can't read files")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove b.pdf' }));
    expect(onRemove).toHaveBeenCalledWith('k2');
  });

  it('renders no remove buttons for a sent message', () => {
    render(<AiAttachmentChips label="Attached files" items={[{ key: 'k', name: 'a.png', size: 1, kind: 'image' }]} />);
    expect(screen.getByRole('list', { name: 'Attached files' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
