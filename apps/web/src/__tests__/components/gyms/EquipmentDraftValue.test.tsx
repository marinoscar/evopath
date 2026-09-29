/**
 * `EquipmentDraftValue` (E3.4): the read view of one `gym_equipment` draft —
 * name, ×quantity, "count uncertain", brand with its evidence, configuration,
 * capability chips, target muscles, notes.
 */
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../utils/test-utils';
import { EquipmentDraftValue, equipmentValueSummary } from '../../../components/gyms/EquipmentDraftValue';
import { EMPTY_EQUIPMENT_VALUE, type EquipmentValue } from '../../../services/gymScan';

const ELLIPTICAL: EquipmentValue = {
  ...EMPTY_EQUIPMENT_VALUE,
  equipmentTypeSlug: 'elliptical',
  name: 'Elliptical',
  quantity: 3,
  quantityUncertain: true,
  brand: 'Precor',
  brandEvidence: 'Brand inferred from the PRECOR-labelled bike beside them.',
  capabilitySlugs: ['steady_state_cardio', 'low_impact_cardio'],
  targetMuscles: ['full_body'],
};

describe('EquipmentDraftValue', () => {
  it('shows name, quantity, the uncertain count, capabilities and targets', () => {
    render(<EquipmentDraftValue value={ELLIPTICAL} />);
    expect(screen.getByText('Elliptical')).toBeInTheDocument();
    expect(screen.getByTestId('equipment-draft-quantity')).toHaveTextContent('quantity ×3');
    expect(screen.getByText('count uncertain')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Capabilities' })).toBeInTheDocument();
    expect(screen.getByText('Steady state cardio')).toBeInTheDocument();
    expect(screen.getByText('Low impact cardio')).toBeInTheDocument();
    expect(screen.getByText('Targets full body')).toBeInTheDocument();
    expect(screen.queryByText('Not in the catalog')).toBeNull();
  });

  it('shows the brand evidence as a tooltip and to screen readers', async () => {
    const user = userEvent.setup();
    render(<EquipmentDraftValue value={ELLIPTICAL} />);
    const brand = screen.getByTestId('equipment-draft-brand');
    expect(brand).toHaveTextContent('Precor (evidence: Brand inferred from the PRECOR-labelled bike beside them.)');
    await user.hover(brand);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Brand inferred from the PRECOR-labelled bike beside them.');
  });

  it('marks an item outside the catalog and shows model, configuration and notes', () => {
    render(
      <EquipmentDraftValue
        value={{
          ...EMPTY_EQUIPMENT_VALUE,
          name: 'Prowler sled',
          brand: 'Rogue',
          model: 'Echo',
          configuration: 'push/pull',
          notes: 'By the turf',
        }}
      />,
    );
    expect(screen.getByText('Not in the catalog')).toBeInTheDocument();
    expect(screen.getByText(/Echo/)).toBeInTheDocument();
    expect(screen.getByText('push/pull')).toBeInTheDocument();
    expect(screen.getByText('By the turf')).toBeInTheDocument();
    expect(screen.queryByText('count uncertain')).toBeNull();
  });

  it('summarizes a value in one line', () => {
    expect(equipmentValueSummary({ ...ELLIPTICAL, model: 'EFX 885', configuration: 'front drive' })).toBe(
      'Elliptical ×3, Precor EFX 885, front drive',
    );
    render(<EquipmentDraftValue value={ELLIPTICAL} compact />);
    expect(screen.getByText('Elliptical ×3, Precor')).toBeInTheDocument();
  });
});
