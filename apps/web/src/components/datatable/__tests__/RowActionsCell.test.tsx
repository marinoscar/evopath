/**
 * `RowActionsCell` — `disabledReason` (issue #190). A disabled action says why:
 * the tooltip of a lone icon button, secondary text under a menu item. An
 * enabled action never shows its reason.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowActionsCell } from '../desktop/RowActionsCell';
import type { DataTableRowAction } from '../types';

interface Row {
  id: string;
  locked: boolean;
}

const action = (overrides: Partial<DataTableRowAction<Row>> = {}): DataTableRowAction<Row> => ({
  id: 'edit',
  label: 'Edit',
  onClick: vi.fn(),
  disabled: (row) => row.locked,
  disabledReason: () => 'Read-only access.',
  ...overrides,
});

describe('RowActionsCell — disabledReason', () => {
  it('shows the reason under a disabled menu item', async () => {
    const user = userEvent.setup();
    render(
      <RowActionsCell<Row>
        row={{ id: 'r1', locked: true }}
        rowLabel="r1"
        actions={[action(), action({ id: 'view', label: 'View', disabled: undefined })]}
        onRun={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Row actions for r1' }));
    const menu = await screen.findByRole('menu');
    const edit = within(menu).getByRole('menuitem', { name: /Edit/ });
    expect(edit).toHaveAttribute('aria-disabled', 'true');
    expect(edit).toHaveTextContent('Read-only access.');
    // The enabled sibling carries no reason.
    expect(within(menu).getByRole('menuitem', { name: 'View' })).not.toHaveTextContent(
      'Read-only access.',
    );
  });

  it('omits the reason while the action is enabled', async () => {
    const user = userEvent.setup();
    render(
      <RowActionsCell<Row>
        row={{ id: 'r1', locked: false }}
        rowLabel="r1"
        actions={[action(), action({ id: 'view', label: 'View' })]}
        onRun={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Row actions for r1' }));
    expect(await screen.findByRole('menu')).not.toHaveTextContent('Read-only access.');
  });

  it('puts the reason in the tooltip of a lone disabled icon button', async () => {
    const user = userEvent.setup();
    render(
      <RowActionsCell<Row>
        row={{ id: 'r1', locked: true }}
        rowLabel="r1"
        actions={[action()]}
        onRun={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: 'Edit for r1' });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Edit: Read-only access.');
  });
});
