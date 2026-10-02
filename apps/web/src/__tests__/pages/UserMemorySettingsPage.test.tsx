/**
 * `/settings/memory` (#325): the disclosure, the three preferences, the list
 * grouped by category, add / edit / pin / delete with Undo / delete all, the
 * mapping of refusals, and accessibility. Real hook, MSW for the network.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import UserMemorySettingsPage, {
  MEMORY_DISCLOSURE,
  MEMORY_EMPTY_MESSAGE,
  MEMORY_POLICY_OFF_MESSAGE,
} from '../../pages/UserMemorySettingsPage';
import { memoryId, mockMemories, mockMemory, mockMemoryListView } from '../mocks/fixtures/memories';
import type { MemoryListView } from '../../services/memories';

const API = '*/api';

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** Serves `view` for every GET and records every write. */
function serve(initial: MemoryListView = mockMemoryListView()) {
  let view = initial;
  const relist = (items: MemoryListView['items']) =>
    mockMemoryListView({ settings: view.settings, policy: view.policy, items });
  const calls: Recorded[] = [];
  const record = async (request: Request) => {
    const text = await request.text();
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
  };
  server.use(
    http.get(`${API}/memories`, () => HttpResponse.json({ data: view })),
    http.patch(`${API}/user-settings`, async ({ request }) => {
      await record(request.clone());
      const body = (await request.json()) as { memory: Partial<MemoryListView['settings']> };
      view = { ...view, settings: { ...view.settings, ...body.memory } };
      return HttpResponse.json({ data: { memory: view.settings, version: 2 } });
    }),
    http.post(`${API}/memories`, async ({ request }) => {
      await record(request.clone());
      const body = (await request.json()) as { content: string; category: string };
      const created = mockMemory({ id: memoryId(50), content: body.content, category: body.category as never });
      view = relist([...view.items, created]);
      return HttpResponse.json({ data: created }, { status: 201 });
    }),
    http.patch(`${API}/memories/:id`, async ({ request, params }) => {
      await record(request.clone());
      const body = (await request.json()) as Record<string, unknown>;
      view = {
        ...view,
        items: view.items.map((item) =>
          item.id === params.id ? { ...item, ...body, source: 'user_edited' as const } : item,
        ),
      };
      return HttpResponse.json({ data: view.items.find((item) => item.id === params.id) });
    }),
    http.delete(`${API}/memories/:id`, async ({ request, params }) => {
      await record(request);
      view = relist(view.items.filter((item) => item.id !== params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/memories/:id/restore`, async ({ request, params }) => {
      await record(request);
      const restored = initial.items.find((item) => item.id === params.id) ?? mockMemory({ id: String(params.id) });
      view = relist([...view.items, restored]);
      return HttpResponse.json({ data: restored });
    }),
    http.delete(`${API}/memories`, async ({ request }) => {
      await record(request);
      view = relist([]);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

async function renderPage(user = mockUser) {
  const events = userEvent.setup();
  const result = render(<UserMemorySettingsPage />, { wrapperOptions: { aiEnabled: true, user } });
  await screen.findByRole('switch', { name: 'Memory on' });
  return { user: events, ...result };
}

function item(id: string) {
  return screen.getByTestId(`memory-${id}`);
}

describe('UserMemorySettingsPage', () => {
  describe('rendering', () => {
    it('renders the title, the count and the memories grouped by category in display order', async () => {
      serve();
      await renderPage();
      expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
      expect(screen.getByTestId('memory-count')).toHaveTextContent('3 of 200');

      const groups = screen.getAllByRole('region').filter((el) => el.dataset.testid?.startsWith('memory-group-'));
      expect(groups.map((g) => g.dataset.testid)).toEqual([
        'memory-group-goal',
        'memory-group-preference',
        'memory-group-constraint_injury',
      ]);
      expect(within(screen.getByTestId('memory-group-goal')).getByRole('heading', { level: 3 })).toHaveTextContent(
        'Goals (1)',
      );
      expect(screen.getByRole('heading', { level: 3, name: 'Injuries & limits (1)' })).toBeInTheDocument();
    });

    it('shows the source badge, the health badge and the pinned badge', async () => {
      serve();
      await renderPage();
      expect(within(item(memoryId(1))).getByText('You said')).toBeInTheDocument();
      expect(within(item(memoryId(2))).getByText('Coach learned')).toBeInTheDocument();
      const injury = item(memoryId(3));
      expect(within(injury).getByText('Edited')).toBeInTheDocument();
      expect(within(injury).getByText('Health')).toBeInTheDocument();
      expect(within(injury).getByText('Pinned')).toBeInTheDocument();
      expect(within(item(memoryId(1))).queryByText('Health')).not.toBeInTheDocument();
    });

    it('shows the empty state when nothing is remembered', async () => {
      serve(mockMemoryListView({ items: [] }));
      await renderPage();
      expect(screen.getByTestId('memory-empty')).toHaveTextContent(MEMORY_EMPTY_MESSAGE);
      expect(screen.getByRole('button', { name: 'Delete all memories' })).toBeDisabled();
    });

    it('shows a load error with Retry', async () => {
      server.use(http.get(`${API}/memories`, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));
      render(<UserMemorySettingsPage />, { wrapperOptions: { aiEnabled: true } });
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('redirects away without ai:use', async () => {
      serve();
      render(<UserMemorySettingsPage />, {
        wrapperOptions: { aiEnabled: true, user: { ...mockUser, permissions: ['user_settings:read'] } },
      });
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Memory' })).not.toBeInTheDocument());
    });
  });

  describe('disclosure', () => {
    it('shows the disclosure until it is acknowledged, and "Got it" stamps disclosureSeenAt', async () => {
      const calls = serve(
        mockMemoryListView({
          settings: { enabled: true, autoExtract: true, allowHealth: true, disclosureSeenAt: null },
        }),
      );
      const { user } = await renderPage();
      const disclosure = screen.getByTestId('memory-disclosure');
      expect(disclosure).toHaveTextContent(MEMORY_DISCLOSURE);
      await user.click(within(disclosure).getByRole('button', { name: 'Got it' }));
      await waitFor(() => expect(screen.queryByTestId('memory-disclosure')).not.toBeInTheDocument());
      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe('/api/user-settings');
      const body = calls[0].body as { memory: { disclosureSeenAt: string } };
      expect(Object.keys(body.memory)).toEqual(['disclosureSeenAt']);
      expect(Number.isNaN(Date.parse(body.memory.disclosureSeenAt))).toBe(false);
    });

    it('is not shown once seen', async () => {
      serve();
      await renderPage();
      expect(screen.queryByTestId('memory-disclosure')).not.toBeInTheDocument();
    });
  });

  describe('preferences', () => {
    it.each([
      ['Memory on', { enabled: false }],
      ['Learn from conversations', { autoExtract: false }],
      ['Allow health-related memories', { allowHealth: false }],
    ])('toggling "%s" PATCHes only that field under memory', async (label, expected) => {
      const calls = serve();
      const { user } = await renderPage();
      const toggle = screen.getByRole('switch', { name: label });
      expect(toggle).toBeChecked();
      await user.click(toggle);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/user-settings', body: { memory: expected } });
      await waitFor(() => expect(screen.getByRole('switch', { name: label })).not.toBeChecked());
    });

    it('disables every control and explains when the deployment switched memory off', async () => {
      serve(mockMemoryListView({ policy: { enabled: false, autoExtract: true, maxPerUser: 200 } }));
      await renderPage();
      expect(screen.getByTestId('memory-policy-off')).toHaveTextContent(MEMORY_POLICY_OFF_MESSAGE);
      for (const label of ['Memory on', 'Learn from conversations', 'Allow health-related memories']) {
        expect(screen.getByRole('switch', { name: label })).toBeDisabled();
      }
      expect(screen.getByRole('textbox', { name: 'What should your coach remember?' })).toBeDisabled();
      // Existing memories can still be reviewed and deleted.
      expect(within(item(memoryId(1))).getByRole('button', { name: 'Delete' })).toBeEnabled();
    });

    it('disables learning from conversations and explains when the deployment switched it off', async () => {
      serve(mockMemoryListView({ policy: { enabled: true, autoExtract: false, maxPerUser: 200 } }));
      await renderPage();
      const toggle = screen.getByRole('switch', { name: 'Learn from conversations' });
      expect(toggle).toBeDisabled();
      expect(toggle).not.toBeChecked();
      expect(screen.getByText(/switched off learning from conversations/)).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Memory on' })).toBeEnabled();
    });

    it('shows a refusal when the preference cannot be saved and reverts the switch', async () => {
      serve();
      server.use(
        http.patch(`${API}/user-settings`, () =>
          HttpResponse.json({ message: 'nope', details: { code: 'MEMORY_DISABLED' } }, { status: 403 }),
        ),
      );
      const { user } = await renderPage();
      await user.click(screen.getByRole('switch', { name: 'Allow health-related memories' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/Memory is switched off/);
      expect(screen.getByRole('switch', { name: 'Allow health-related memories' })).toBeChecked();
    });
  });

  describe('add', () => {
    it('POSTs content and category, then lists the new memory', async () => {
      const calls = serve();
      const { user } = await renderPage();
      await user.type(screen.getByRole('textbox', { name: 'What should your coach remember?' }), 'I train at 6am');
      await user.click(screen.getByRole('combobox', { name: 'Category' }));
      await user.click(await screen.findByRole('option', { name: 'Schedule' }));
      await user.click(screen.getByRole('button', { name: 'Add memory' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({
        method: 'POST',
        path: '/api/memories',
        body: { content: 'I train at 6am', category: 'schedule' },
      });
      expect(await screen.findByTestId('memory-group-schedule')).toHaveTextContent('I train at 6am');
      expect(screen.getByRole('textbox', { name: 'What should your coach remember?' })).toHaveValue('');
      expect(screen.getByTestId('memory-count')).toHaveTextContent('4 of 200');
    });

    it.each([
      [409, { code: 'CONFLICT', message: 'x', details: { code: 'MEMORY_LIMIT_REACHED' } }, /limit of 200 memories/],
      [403, { code: 'FORBIDDEN', message: 'x', details: { code: 'MEMORY_DISABLED' } }, /Memory is switched off/],
      [
        400,
        { code: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'content', message: 'Content is too long' }] } },
        /Content is too long/,
      ],
    ])('maps a %s refusal to a sentence', async (status, body, expected) => {
      serve();
      server.use(http.post(`${API}/memories`, () => HttpResponse.json(body, { status })));
      const { user } = await renderPage();
      await user.type(screen.getByRole('textbox', { name: 'What should your coach remember?' }), 'Something');
      await user.click(screen.getByRole('button', { name: 'Add memory' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(expected);
      // The typed text is kept.
      expect(screen.getByRole('textbox', { name: 'What should your coach remember?' })).toHaveValue('Something');
    });

    it('disables Add at the limit', async () => {
      serve(mockMemoryListView({ policy: { enabled: true, autoExtract: true, maxPerUser: 3 } }));
      const { user } = await renderPage();
      await user.type(screen.getByRole('textbox', { name: 'What should your coach remember?' }), 'One more');
      expect(screen.getByRole('button', { name: 'Add memory' })).toBeDisabled();
      expect(screen.getByText(/reached the limit of 3 memories/)).toBeInTheDocument();
    });
  });

  describe('edit, pin and delete', () => {
    it('edits inline: Save PATCHes only what changed; Cancel discards', async () => {
      const calls = serve();
      const { user } = await renderPage();
      await user.click(within(item(memoryId(1))).getByRole('button', { name: 'Edit' }));
      const box = within(item(memoryId(1))).getByRole('textbox', { name: 'Memory' });
      await user.clear(box);
      await user.type(box, 'Prefers evening workouts');
      await user.click(within(item(memoryId(1))).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({
        method: 'PATCH',
        path: `/api/memories/${memoryId(1)}`,
        body: { content: 'Prefers evening workouts' },
      });
      expect(await within(item(memoryId(1))).findByText('Prefers evening workouts')).toBeInTheDocument();
      expect(within(item(memoryId(1))).getByText('Edited')).toBeInTheDocument();

      await user.click(within(item(memoryId(2))).getByRole('button', { name: 'Edit' }));
      await user.type(within(item(memoryId(2))).getByRole('textbox', { name: 'Memory' }), ' extra');
      await user.click(within(item(memoryId(2))).getByRole('button', { name: 'Cancel' }));
      expect(within(item(memoryId(2))).getByText(mockMemories[1].content)).toBeInTheDocument();
      expect(calls).toHaveLength(1);
    });

    it('pins and unpins', async () => {
      const calls = serve();
      const { user } = await renderPage();
      await user.click(within(item(memoryId(1))).getByRole('button', { name: 'Pin' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ method: 'PATCH', path: `/api/memories/${memoryId(1)}`, body: { pinned: true } });
      await user.click(within(item(memoryId(3))).getByRole('button', { name: 'Unpin' }));
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]).toMatchObject({ body: { pinned: false } });
    });

    it('deletes with an Undo that restores the memory', async () => {
      const calls = serve();
      const { user } = await renderPage();
      await user.click(within(item(memoryId(2))).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByTestId(`memory-${memoryId(2)}`)).not.toBeInTheDocument());
      expect(calls[0]).toMatchObject({ method: 'DELETE', path: `/api/memories/${memoryId(2)}` });
      expect(await screen.findByText('Memory deleted')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]).toMatchObject({ method: 'POST', path: `/api/memories/${memoryId(2)}/restore` });
      expect(await screen.findByTestId(`memory-${memoryId(2)}`)).toBeInTheDocument();
    });

    it('deletes everything only after confirming', async () => {
      const calls = serve();
      const { user } = await renderPage();
      await user.click(screen.getByRole('button', { name: 'Delete all memories' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete all memories?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(calls).toHaveLength(0);

      await user.click(screen.getByRole('button', { name: 'Delete all memories' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete all' }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/memories' });
      expect(await screen.findByTestId('memory-empty')).toBeInTheDocument();
    });
  });

  it('has no axe violations', async () => {
    serve(
      mockMemoryListView({ settings: { enabled: true, autoExtract: true, allowHealth: true, disclosureSeenAt: null } }),
    );
    const { container } = await renderPage();
    expect(await axe(container)).toHaveNoViolations();
  });
});
