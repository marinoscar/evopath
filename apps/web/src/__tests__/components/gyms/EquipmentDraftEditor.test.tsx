/**
 * `EquipmentDraftEditor` (E3.4): the equipment Autocomplete over
 * `GET /equipment-types` with "Other (type a name)", quantity 1..99 (clears
 * "count uncertain"), brand (drops the AI's evidence), model, configuration
 * and notes. Controlled: each change reports the whole next value.
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../utils/test-utils';
import { EquipmentDraftEditor, OTHER_EQUIPMENT_LABEL } from '../../../components/gyms/EquipmentDraftEditor';
import { EMPTY_EQUIPMENT_VALUE, type EquipmentValue } from '../../../services/gymScan';
import { CATALOG, statefulGymsApi } from '../../mocks/fixtures/gyms';

function Harness({ initial, onChange }: { initial: EquipmentValue; onChange: (value: EquipmentValue) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <EquipmentDraftEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0] as EquipmentValue;

const PROWLER = {
  id: '00000000-0000-4000-8000-f00000000001',
  slug: 'custom-abcdefgh',
  name: 'Prowler sled',
  category: 'accessories',
  aliases: [],
  description: null,
  isCustom: true,
  capabilities: [{ id: 'c5', slug: 'farmer_carry', name: 'Farmer carry' }],
};

describe('EquipmentDraftEditor', () => {
  it('picks a catalog type from the search and sets its slug, name and capabilities', async () => {
    statefulGymsApi([]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={EMPTY_EQUIPMENT_VALUE} onChange={onChange} />);

    await user.type(screen.getByRole('combobox', { name: 'Equipment' }), 'cross');
    // Server-filtered (debounced): only the alias match plus "Other".
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Elliptical', OTHER_EQUIPMENT_LABEL]),
    );
    await user.click(screen.getByRole('option', { name: 'Elliptical' }));

    expect(last(onChange)).toMatchObject({
      equipmentTypeSlug: 'elliptical',
      name: 'Elliptical',
      capabilitySlugs: ['cardio_steady'],
    });
    expect(screen.queryByRole('textbox', { name: /Equipment name/ })).toBeNull();
  });

  it('keeps the slug of the caller\'s custom type', async () => {
    statefulGymsApi([], [...CATALOG, PROWLER]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={EMPTY_EQUIPMENT_VALUE} onChange={onChange} />);

    await user.type(screen.getByRole('combobox', { name: 'Equipment' }), 'prowler');
    await user.click(await screen.findByRole('option', { name: /Prowler sled/ }));
    expect(last(onChange)).toMatchObject({ equipmentTypeSlug: 'custom-abcdefgh', name: 'Prowler sled' });
  });

  it('"Other" asks for a name and leaves the slug null', async () => {
    statefulGymsApi([]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={EMPTY_EQUIPMENT_VALUE} onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Equipment' }));
    await user.click(await screen.findByRole('option', { name: OTHER_EQUIPMENT_LABEL }));
    const name = screen.getByRole('textbox', { name: /Equipment name/ });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    await user.type(name, 'Battle ropes');
    expect(last(onChange)).toMatchObject({ equipmentTypeSlug: null, name: 'Battle ropes' });
  });

  it('opens an unidentified AI item on "Other" with its name', () => {
    statefulGymsApi([]);
    render(
      <Harness initial={{ ...EMPTY_EQUIPMENT_VALUE, name: 'Unidentified machine' }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('combobox', { name: 'Equipment' })).toHaveValue(OTHER_EQUIPMENT_LABEL);
    expect(screen.getByRole('textbox', { name: /Equipment name/ })).toHaveValue('Unidentified machine');
  });

  it('shows a slugged value even before the search answers', () => {
    statefulGymsApi([]);
    render(
      <Harness
        initial={{ ...EMPTY_EQUIPMENT_VALUE, equipmentTypeSlug: 'stationary_bike', name: 'Stationary bike' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Equipment' })).toHaveValue('Stationary bike');
  });

  it('quantity clears "count uncertain"; brand drops the evidence; text fields map blank to null', async () => {
    statefulGymsApi([]);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...EMPTY_EQUIPMENT_VALUE,
          equipmentTypeSlug: 'elliptical',
          name: 'Elliptical',
          quantity: 3,
          quantityUncertain: true,
          brand: 'Precor',
          brandEvidence: 'Inferred from the bike beside it.',
        }}
        onChange={onChange}
      />,
    );

    await user.click(within(screen.getByRole('group', { name: 'Quantity' })).getByRole('button', { name: 'Increase quantity' }));
    expect(last(onChange)).toMatchObject({ quantity: 4, quantityUncertain: false, brandEvidence: 'Inferred from the bike beside it.' });

    const brand = screen.getByRole('textbox', { name: 'Brand' });
    await user.clear(brand);
    expect(last(onChange)).toMatchObject({ brand: null, brandEvidence: null });
    await user.type(brand, 'Life Fitness');
    expect(last(onChange).brand).toBe('Life Fitness');

    await user.type(screen.getByRole('textbox', { name: 'Model' }), 'X1');
    await user.type(screen.getByRole('textbox', { name: 'Configuration' }), 'front drive');
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Squeaks');
    expect(last(onChange)).toMatchObject({ model: 'X1', configuration: 'front drive', notes: 'Squeaks' });
  });
});
