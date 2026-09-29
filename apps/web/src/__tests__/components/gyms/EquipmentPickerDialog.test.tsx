/**
 * The equipment picker (E3.3), with `services/gyms` mocked: debounced search,
 * out-of-order responses ignored, category chips, quantity clamping, Add, and
 * the custom-equipment path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../utils/test-utils';
import { EquipmentPickerDialog } from '../../../components/gyms/EquipmentPickerDialog';
import { ApiError } from '../../../services/api';
import * as gyms from '../../../services/gyms';
import { CAPABILITIES, CATALOG, DUMBBELLS, ELLIPTICAL, LEG_CURL } from '../../mocks/fixtures/gyms';

vi.mock('../../../services/gyms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/gyms')>();
  return {
    ...actual,
    listEquipmentTypes: vi.fn(),
    createEquipmentType: vi.fn(),
    listCapabilities: vi.fn(),
  };
});

const listEquipmentTypes = vi.mocked(gyms.listEquipmentTypes);
const createEquipmentType = vi.mocked(gyms.createEquipmentType);
const listCapabilities = vi.mocked(gyms.listCapabilities);

function filterCatalog(query: gyms.EquipmentTypeQuery = {}) {
  const q = query.q?.trim().toLowerCase();
  return CATALOG.filter(
    (t) =>
      (!q || t.name.toLowerCase().includes(q) || t.aliases.some((a) => a.includes(q))) &&
      (!query.category || t.category === query.category),
  );
}

function renderPicker(onAdd = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  render(<EquipmentPickerDialog open onClose={onClose} onAdd={onAdd} />);
  return { onAdd, onClose, dialog: screen.getByRole('dialog', { name: 'Add equipment' }) };
}

describe('EquipmentPickerDialog', () => {
  beforeEach(() => {
    listEquipmentTypes.mockReset().mockImplementation(async (query) => filterCatalog(query));
    createEquipmentType.mockReset();
    listCapabilities.mockReset().mockResolvedValue(CAPABILITIES);
  });

  it('lists the catalog with capability chips', async () => {
    const { dialog } = renderPicker();
    const results = await within(dialog).findByRole('list', { name: 'Search results' });
    expect(within(results).getAllByRole('button')).toHaveLength(3);
    expect(within(results).getByText('Dumbbell press')).toBeInTheDocument();
    expect(within(results).getByText('Dumbbell row')).toBeInTheDocument();
  });

  it('debounces the search: one request for a burst of keystrokes', async () => {
    const user = userEvent.setup();
    const { dialog } = renderPicker();
    await within(dialog).findByRole('list', { name: 'Search results' });
    listEquipmentTypes.mockClear();

    await user.type(within(dialog).getByRole('textbox', { name: 'Search equipment' }), 'curl');
    await waitFor(() => expect(listEquipmentTypes).toHaveBeenCalledTimes(1));
    expect(listEquipmentTypes).toHaveBeenCalledWith({ q: 'curl', category: undefined });
    const results = within(dialog).getByRole('list', { name: 'Search results' });
    await waitFor(() => expect(within(results).getAllByRole('button')).toHaveLength(1));
    expect(within(results).getByRole('button', { name: /Leg curl machine/ })).toBeInTheDocument();
  });

  it('ignores a slow response that arrives after a newer one', async () => {
    let releaseSlow: (value: gyms.EquipmentType[]) => void = () => {};
    listEquipmentTypes.mockImplementation((query) => {
      if (query?.q === 'dumb') return new Promise((resolve) => (releaseSlow = resolve));
      return Promise.resolve(filterCatalog(query));
    });
    const user = userEvent.setup();
    const { dialog } = renderPicker();
    const search = within(dialog).getByRole('textbox', { name: 'Search equipment' });

    await user.type(search, 'dumb');
    await waitFor(() => expect(listEquipmentTypes).toHaveBeenCalledWith({ q: 'dumb', category: undefined }));
    await user.clear(search);
    await user.type(search, 'cross');
    const results = await within(dialog).findByRole('list', { name: 'Search results' });
    await waitFor(() => expect(within(results).getByRole('button', { name: /Elliptical/ })).toBeInTheDocument());

    releaseSlow([DUMBBELLS]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(results).queryByRole('button', { name: /Dumbbells/ })).toBeNull();
    expect(within(results).getAllByRole('button')).toHaveLength(1);
  });

  it('filters by category chip', async () => {
    const user = userEvent.setup();
    const { dialog } = renderPicker();
    await within(dialog).findByRole('list', { name: 'Search results' });
    await user.click(within(dialog).getByRole('button', { name: 'Cardio' }));
    await waitFor(() => expect(listEquipmentTypes).toHaveBeenLastCalledWith({ q: '', category: 'cardio' }));
    const results = within(dialog).getByRole('list', { name: 'Search results' });
    await waitFor(() => expect(within(results).getAllByRole('button')).toHaveLength(1));
    expect(within(dialog).getByRole('button', { name: 'Cardio' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('adds the picked type with quantity, brand and model; the stepper clamps at 1', async () => {
    const user = userEvent.setup();
    const { dialog, onAdd, onClose } = renderPicker();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();

    await user.click(await within(dialog).findByRole('button', { name: /Elliptical/ }));
    const decrease = within(dialog).getByRole('button', { name: 'Decrease quantity' });
    expect(decrease).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Increase quantity' }));
    await user.click(within(dialog).getByRole('button', { name: 'Increase quantity' }));
    await user.click(within(dialog).getByRole('button', { name: 'Decrease quantity' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Brand' }), 'Precor');
    await user.type(within(dialog).getByRole('textbox', { name: 'Model' }), 'EFX');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdd).toHaveBeenCalledWith({
      equipmentTypeId: ELLIPTICAL.id,
      quantity: 2,
      brand: 'Precor',
      model: 'EFX',
    });
  });

  it('clamps a typed quantity to 99', async () => {
    const user = userEvent.setup();
    const { dialog, onAdd } = renderPicker();
    await user.click(await within(dialog).findByRole('button', { name: /Leg curl machine/ }));
    const quantity = within(dialog).getByRole('textbox', { name: 'Quantity' });
    await user.clear(quantity);
    await user.type(quantity, '150');
    await user.tab();
    expect(quantity).toHaveValue('99');
    expect(within(dialog).getByRole('button', { name: 'Increase quantity' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ equipmentTypeId: LEG_CURL.id, quantity: 99 })));
  });

  it('shows the API error and stays open when Add fails', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockRejectedValue(new ApiError('Equipment type not found', 404));
    const { dialog, onClose } = renderPicker(onAdd);
    await user.click(await within(dialog).findByRole('button', { name: /Dumbbells/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('Equipment type not found')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('creates custom equipment, prefilled from the search, and adds it', async () => {
    const custom: gyms.EquipmentType = {
      id: 'custom-1',
      slug: 'custom-abcdefgh',
      name: 'Prowler sled',
      category: 'accessories',
      aliases: [],
      description: null,
      isCustom: true,
      capabilities: [],
    };
    createEquipmentType.mockResolvedValue(custom);
    const user = userEvent.setup();
    const { dialog, onAdd, onClose } = renderPicker();

    await user.type(within(dialog).getByRole('textbox', { name: 'Search equipment' }), 'Prowler sled');
    await user.click(within(dialog).getByRole('button', { name: "Can't find it? Add custom equipment" }));
    expect(within(dialog).getByRole('textbox', { name: /Equipment name/ })).toHaveValue('Prowler sled');
    await user.click(within(dialog).getByRole('combobox', { name: /What it is used for/ }));
    await user.click(await screen.findByRole('option', { name: 'Farmer carry' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add custom equipment' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createEquipmentType).toHaveBeenCalledWith({
      name: 'Prowler sled',
      category: 'accessories',
      capabilityIds: ['c5'],
    });
    expect(onAdd).toHaveBeenCalledWith({ equipmentTypeId: 'custom-1', quantity: 1 });
  });

  it('refuses a blank custom name and can go back to search', async () => {
    const user = userEvent.setup();
    const { dialog } = renderPicker();
    await user.click(within(dialog).getByRole('button', { name: "Can't find it? Add custom equipment" }));
    await user.click(within(dialog).getByRole('button', { name: 'Add custom equipment' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(createEquipmentType).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Back to search' }));
    expect(within(dialog).getByRole('textbox', { name: 'Search equipment' })).toBeInTheDocument();
  });
});
