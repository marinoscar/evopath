/**
 * `EquipmentOriginTags` (E3.3, extended in E3.4): "Added by you"; for a scan
 * row "AI guess" + confidence until verified, "You verified" afterwards, and
 * "AI said…" opening what the AI proposed when the owner changed it.
 */
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../utils/test-utils';
import { EquipmentOriginTags, describeOriginalAiValue } from '../../../components/gyms/EquipmentOriginTags';
import { ELLIPTICAL, LEG_CURL, mockEquipment } from '../../mocks/fixtures/gyms';

describe('EquipmentOriginTags', () => {
  it('tags a manual row "Added by you"', () => {
    render(<EquipmentOriginTags item={mockEquipment(ELLIPTICAL)} />);
    expect(screen.getByText('Added by you')).toBeInTheDocument();
    expect(screen.queryByText('AI guess')).toBeNull();
  });

  it('tags an unverified scan row "AI guess" with its confidence', () => {
    render(<EquipmentOriginTags item={mockEquipment(LEG_CURL, { origin: 'ai', confidence: 'low', userVerified: false })} />);
    expect(screen.getByText('From photo scan')).toBeInTheDocument();
    expect(screen.getByText('AI guess')).toBeInTheDocument();
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
    expect(screen.queryByText('You verified')).toBeNull();
    expect(screen.queryByText('AI said…')).toBeNull();
  });

  it('tags a verified row "You verified" and opens "AI said: …" for an edited one', async () => {
    const user = userEvent.setup();
    const item = mockEquipment(ELLIPTICAL, {
      origin: 'ai',
      confidence: 'medium',
      userVerified: true,
      quantity: 4,
      originalAiValue: {
        equipmentTypeId: ELLIPTICAL.id,
        equipmentTypeSlug: 'elliptical',
        name: 'Elliptical',
        quantity: 3,
        brand: 'Precor',
        model: null,
        notes: null,
      },
    });
    render(<EquipmentOriginTags item={item} />);
    expect(screen.getByText('You verified')).toBeInTheDocument();
    expect(screen.queryByText('AI guess')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'AI said…' }));
    expect(await screen.findByRole('dialog', { name: 'What the AI proposed' })).toHaveTextContent(
      'AI said: Elliptical ×3, Precor',
    );
  });

  it('describes the stored value defensively', () => {
    const base = mockEquipment(ELLIPTICAL, { origin: 'ai' });
    expect(describeOriginalAiValue({ ...base, originalAiValue: null })).toBeNull();
    expect(describeOriginalAiValue({ ...base, originalAiValue: 'nonsense' })).toBeNull();
    // The E3.3 edit snapshot carries no name: the current type's name stands in.
    expect(
      describeOriginalAiValue({ ...base, originalAiValue: { equipmentTypeId: ELLIPTICAL.id, quantity: 2, brand: null } }),
    ).toBe('Elliptical ×2');
    expect(
      describeOriginalAiValue({ ...base, originalAiValue: { equipmentTypeId: 'other-type', quantity: 1, model: 'X' } }),
    ).toBe('a different equipment type ×1, X');
  });
});
