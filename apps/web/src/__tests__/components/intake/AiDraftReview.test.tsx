/**
 * `AiDraftReview` + `DraftItemRow` + `ConfidenceBadge` — a low-confidence,
 * an uncertain and an edited item, each with its badge/tag/"AI said";
 * Accept all confirmation; Add missing; the Rejected section with Restore;
 * lazy source-photo thumbnails with a "photo removed" placeholder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TextField } from '@mui/material';
import { render, screen, waitFor, within } from '../../utils/test-utils';
import { AiDraftReview, ConfidenceBadge } from '../../../components/intake';
import { clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';
import type { DraftItemView } from '../../../services/intake';

type Value = { name: string };

function item(id: string, extra: Partial<DraftItemView<Value>> = {}): DraftItemView<Value> {
  return {
    id,
    kind: 'equipment',
    origin: 'ai',
    status: 'pending',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: [],
    userVerified: false,
    value: { name: id },
    originalAiValue: null,
    sortOrder: 0,
    ...extra,
  };
}

const LOW = item('Cable machine', { confidence: 'low', sortOrder: 2, sourcePhotoIds: ['obj-1'] });
const UNSURE = item('Smith machine', {
  confidence: 'medium',
  uncertain: true,
  uncertaintyNote: 'Could be a squat rack',
  sortOrder: 1,
  sourcePhotoIds: ['obj-gone'],
});
const EDITED = item('Leg press 45', {
  userVerified: true,
  status: 'accepted',
  originalAiValue: { name: 'Leg press' },
  sortOrder: 0,
});
const MINE = item('Kettlebells', { origin: 'user', confidence: null, userVerified: true, status: 'accepted', sortOrder: 3 });
const REJECTED = item('Treadmill', { status: 'rejected', sortOrder: 4 });

const photos = [{ storageObjectId: 'obj-1', name: 'rack.jpg' }];

function setup(items: DraftItemView<Value>[] = [LOW, UNSURE, EDITED, MINE, REJECTED]) {
  const handlers = {
    onAcceptItem: vi.fn(),
    onRejectItem: vi.fn(),
    onRestoreItem: vi.fn(),
    onEditItem: vi.fn(),
    onAddItem: vi.fn(),
    onAcceptAll: vi.fn(),
  };
  render(
    <AiDraftReview<Value>
      items={items}
      photos={photos}
      renderValue={(entry) => <span>{entry.value.name}</span>}
      renderEditor={({ value, onChange }) => (
        <TextField label="Name" value={value.name} onChange={(event) => onChange({ name: event.target.value })} />
      )}
      emptyValue={{ name: '' }}
      {...handlers}
    />,
  );
  return handlers;
}

const row = (name: string) => {
  const rows = screen.getAllByTestId('draft-item-row');
  const match = rows.find((entry) => within(entry).queryAllByText(name).length > 0);
  if (!match) throw new Error(`no row for ${name}`);
  return match;
};

beforeEach(() => clearPhotoUrlCache());

describe('ConfidenceBadge', () => {
  it('uses a text label, never colour alone', () => {
    const { unmount } = render(<ConfidenceBadge confidence="high" />);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
    unmount();
    render(<ConfidenceBadge confidence="low" />);
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
  });

  it('renders nothing for a user item', () => {
    const { container } = render(<ConfidenceBadge confidence={null} />);
    expect(container.querySelector('[data-confidence]')).toBeNull();
  });
});

describe('AiDraftReview', () => {
  it('keeps server sortOrder and never hides low-confidence or uncertain items', () => {
    setup();
    const active = within(screen.getByRole('list', { name: 'Draft items' }));
    const names = active.getAllByTestId('draft-item-row').map((entry) => entry.getAttribute('data-item-id'));
    expect(names).toEqual(['Leg press 45', 'Smith machine', 'Cable machine', 'Kettlebells']);
  });

  it('shows a low-confidence AI item as "AI guess" with a Low badge', () => {
    setup();
    const low = row('Cable machine');
    expect(within(low).getByText('AI guess')).toBeInTheDocument();
    expect(within(low).getByText('Low confidence')).toBeInTheDocument();
    expect(within(low).queryByText('You verified')).not.toBeInTheDocument();
  });

  it('shows an uncertain item with the Unsure flag and the AI note', () => {
    setup();
    const unsure = row('Smith machine');
    expect(within(unsure).getByText('Unsure')).toBeInTheDocument();
    expect(within(unsure).getByText('Medium confidence')).toBeInTheDocument();
    expect(within(unsure).getByTestId('draft-item-uncertainty')).toHaveTextContent('AI is unsure: Could be a squat rack');
  });

  it('shows an edited item as "You verified" with "AI said: <original>"', () => {
    setup();
    const edited = row('Leg press 45');
    expect(within(edited).getByText('You verified')).toBeInTheDocument();
    expect(within(edited).queryByText('AI guess')).not.toBeInTheDocument();
    expect(within(edited).getByTestId('draft-item-ai-said')).toHaveTextContent('AI said: Leg press');
  });

  it('shows a user item as "You added" with no confidence', () => {
    setup();
    const mine = row('Kettlebells');
    expect(within(mine).getByText('You added')).toBeInTheDocument();
    expect(within(mine).queryByText(/confidence/)).not.toBeInTheDocument();
  });

  it('loads source thumbnails through signed URLs and shows "photo removed" for a missing photo', async () => {
    setup();
    await waitFor(() => {
      const img = within(row('Cable machine')).getByRole('img', { name: 'rack.jpg' });
      expect(img.tagName).toBe('IMG');
      expect(img.getAttribute('src')).toContain('obj-1');
    });
    expect(within(row('Smith machine')).getByText('photo removed')).toBeInTheDocument();
  });

  it('Accept / Reject call back with the item id', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(within(row('Cable machine')).getByRole('button', { name: 'Accept' }));
    expect(handlers.onAcceptItem).toHaveBeenCalledWith('Cable machine');
    await user.click(within(row('Smith machine')).getByRole('button', { name: 'Reject' }));
    expect(handlers.onRejectItem).toHaveBeenCalledWith('Smith machine');
  });

  it('Edit opens the inline editor and Save reports the new value', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const target = row('Cable machine');
    await user.click(within(target).getByRole('button', { name: 'Edit' }));
    const field = within(target).getByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Cable crossover');
    await user.click(within(target).getByRole('button', { name: 'Save' }));
    expect(handlers.onEditItem).toHaveBeenCalledWith('Cable machine', { name: 'Cable crossover' });
  });

  it('Accept all with low-confidence items asks first, naming the count', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByRole('button', { name: 'Accept all (2)' }));
    expect(handlers.onAcceptAll).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('1 item has low confidence');

    await user.click(within(dialog).getByRole('button', { name: 'Review first' }));
    expect(handlers.onAcceptAll).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Accept all (2)' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Accept all' }));
    expect(handlers.onAcceptAll).toHaveBeenCalledTimes(1);
  });

  it('Accept all without low-confidence items accepts at once', async () => {
    const user = userEvent.setup();
    const handlers = setup([UNSURE, EDITED]);
    await user.click(screen.getByRole('button', { name: 'Accept all (1)' }));
    expect(handlers.onAcceptAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Add missing item opens the editor with emptyValue and calls onAddItem', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByRole('button', { name: 'Add missing item' }));
    const form = screen.getByTestId('draft-item-add');
    expect(within(form).getByLabelText('Name')).toHaveValue('');
    await user.type(within(form).getByLabelText('Name'), 'Rowing machine');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(handlers.onAddItem).toHaveBeenCalledWith({ name: 'Rowing machine' });
  });

  it('lists rejected items under "Rejected (n)" with Restore', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    expect(within(screen.getByRole('list', { name: 'Draft items' })).queryByText('Treadmill')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rejected (1)' }));
    const rejected = within(screen.getByRole('list', { name: 'Rejected items' }));
    expect(rejected.getByText('Treadmill')).toBeInTheDocument();
    await user.click(rejected.getByRole('button', { name: 'Restore' }));
    expect(handlers.onRestoreItem).toHaveBeenCalledWith('Treadmill');
  });

  it('disables actions while busy', () => {
    render(
      <AiDraftReview<Value>
        items={[LOW]}
        photos={[]}
        busy
        renderValue={(entry) => entry.value.name}
        renderEditor={() => null}
        emptyValue={{ name: '' }}
        onAcceptItem={vi.fn()}
        onRejectItem={vi.fn()}
        onRestoreItem={vi.fn()}
        onEditItem={vi.fn()}
        onAddItem={vi.fn()}
        onAcceptAll={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Accept all (1)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
  });
});
