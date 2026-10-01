/**
 * `HealthProfileSettings` (issue #47, E2.1): the controlled form.
 *
 * The load-bearing cases are the unit round trip (5 ft 10 in ↔ 1778 mm ↔
 * 177.8 cm, with a unit switch that never saves and never drifts), the write
 * gate (`canWrite === false` disables everything), the pre-save validation,
 * and a `409` that keeps the user's edits on screen.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  BIO_HELPER_TEXT,
  HEALTH_PROFILE_CONFLICT_MESSAGE,
  HealthProfileSettings,
  defaultUnitSystem,
} from '../../../components/settings/HealthProfileSettings';
import { ApiError } from '../../../services/api';
import type { HealthProfile, HealthProfileInput } from '../../../services/health';
import { mockHealthProfileEmpty, mockHealthProfileSaved } from '../../mocks/fixtures/health';

function setup(
  props: Partial<React.ComponentProps<typeof HealthProfileSettings>> & {
    profile?: HealthProfile;
  } = {},
) {
  const onSave = props.onSave ?? vi.fn().mockResolvedValue(undefined);
  const onSaved = props.onSaved ?? vi.fn();
  const onError = props.onError ?? vi.fn();
  const onReload = props.onReload ?? vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <HealthProfileSettings
      profile={props.profile ?? mockHealthProfileSaved}
      canWrite={props.canWrite ?? true}
      isSaving={props.isSaving}
      onSave={onSave}
      onSaved={onSaved}
      onError={onError}
      onReload={onReload}
    />,
  );
  return { ...utils, user, onSave, onSaved, onError, onReload };
}

const saveButton = () => screen.getByRole('button', { name: /save/i });
const savedInput = (onSave: ReturnType<typeof vi.fn>) =>
  onSave.mock.calls[0][0] as HealthProfileInput;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HealthProfileSettings', () => {
  describe('height units', () => {
    it('shows a saved imperial 1778 mm as 5 ft 10 in', () => {
      setup();
      expect(screen.getByRole('button', { name: 'Imperial' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('textbox', { name: 'Height (feet)' })).toHaveValue('5');
      expect(screen.getByRole('textbox', { name: 'Height (inches)' })).toHaveValue('10');
    });

    it('switching to metric shows 177.8 cm without saving, and back shows 5 ft 10 in', async () => {
      const { user, onSave } = setup();

      await user.click(screen.getByRole('button', { name: 'Metric' }));
      expect(screen.getByRole('textbox', { name: 'Height' })).toHaveValue('177.8');
      expect(onSave).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Imperial' }));
      expect(screen.getByRole('textbox', { name: 'Height (feet)' })).toHaveValue('5');
      expect(screen.getByRole('textbox', { name: 'Height (inches)' })).toHaveValue('10');
      expect(onSave).not.toHaveBeenCalled();
    });

    it('imperial 5 ft 10 in saves heightMm 1778 and unitSystem imperial', async () => {
      const { user, onSave, onSaved } = setup({
        profile: { ...mockHealthProfileSaved, heightMm: null, unitSystem: 'imperial' },
      });

      await user.type(screen.getByRole('textbox', { name: 'Height (feet)' }), '5');
      await user.type(screen.getByRole('textbox', { name: 'Height (inches)' }), '10');
      await user.click(saveButton());

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave)).toMatchObject({ heightMm: 1778, unitSystem: 'imperial' });
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    it('metric 177.8 cm saves heightMm 1778 and unitSystem metric', async () => {
      const { user, onSave } = setup({
        profile: { ...mockHealthProfileSaved, heightMm: null, unitSystem: 'metric' },
      });

      await user.type(screen.getByRole('textbox', { name: 'Height' }), '177.8');
      await user.click(saveButton());

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave)).toMatchObject({ heightMm: 1778, unitSystem: 'metric' });
    });

    it('saving after a unit switch stores the new unitSystem and the unchanged height', async () => {
      const { user, onSave } = setup();

      await user.click(screen.getByRole('button', { name: 'Metric' }));
      await user.click(saveButton());

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave)).toMatchObject({ heightMm: 1778, unitSystem: 'metric' });
    });

    it('clearing the height saves null', async () => {
      const { user, onSave } = setup({
        profile: { ...mockHealthProfileSaved, unitSystem: 'metric' },
      });

      await user.clear(screen.getByRole('textbox', { name: 'Height' }));
      await user.click(saveButton());

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave).heightMm).toBeNull();
    });
  });

  describe('defaults for a user with no saved profile', () => {
    it('preselects Imperial for en-US', () => {
      vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
      setup({ profile: mockHealthProfileEmpty });
      expect(screen.getByRole('button', { name: 'Imperial' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('preselects Metric for any other locale', () => {
      vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-GB');
      setup({ profile: mockHealthProfileEmpty });
      expect(screen.getByRole('button', { name: 'Metric' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('keeps a saved unit system whatever the locale', () => {
      vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
      setup({ profile: { ...mockHealthProfileSaved, unitSystem: 'metric' } });
      expect(screen.getByRole('button', { name: 'Metric' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('defaultUnitSystem is Imperial only for en-US', () => {
      expect(defaultUnitSystem('en-US')).toBe('imperial');
      expect(defaultUnitSystem('en-us')).toBe('imperial');
      expect(defaultUnitSystem('es-CR')).toBe('metric');
      expect(defaultUnitSystem(undefined)).toBe('metric');
    });

    it("pre-fills the browser's time zone as a suggestion the user still saves", async () => {
      const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { user, onSave } = setup({ profile: mockHealthProfileEmpty });

      expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveValue(browserZone);
      expect(onSave).not.toHaveBeenCalled();

      await user.click(saveButton());
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave).timeZone).toBe(browserZone);
    });
  });

  describe('round trip of the other fields', () => {
    it('renders the saved values and sends them back unchanged', async () => {
      const { user, onSave } = setup();

      expect(screen.getByLabelText('Date of birth')).toHaveValue('1990-02-28');
      expect(screen.getByRole('combobox', { name: 'Sex at birth' })).toHaveTextContent('Female');
      expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveValue('America/New_York');
      expect(screen.getByRole('textbox', { name: 'Bio' })).toHaveValue(
        'Training for a half marathon.',
      );

      await user.click(saveButton());
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave)).toEqual({
        dateOfBirth: '1990-02-28',
        sexAtBirth: 'female',
        heightMm: 1778,
        unitSystem: 'imperial',
        timeZone: 'America/New_York',
        bio: 'Training for a half marathon.',
        labUnits: 'conventional',
      });
    });

    it('offers "Not set" for sex at birth and saves it as null', async () => {
      const { user, onSave } = setup();

      await user.click(screen.getByRole('combobox', { name: 'Sex at birth' }));
      const listbox = await screen.findByRole('listbox');
      expect(within(listbox).getByRole('option', { name: 'Prefer not to say' })).toBeInTheDocument();
      await user.click(within(listbox).getByRole('option', { name: 'Not set' }));
      await user.click(saveButton());

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave).sexAtBirth).toBeNull();
    });

    it('trims the bio, stores an empty bio as null and shows the counter and helper text', async () => {
      const { user, onSave } = setup();
      const bio = screen.getByRole('textbox', { name: 'Bio' });

      expect(screen.getByText(BIO_HELPER_TEXT)).toBeInTheDocument();
      expect(screen.getByText('29/1000')).toBeInTheDocument();

      await user.clear(bio);
      await user.type(bio, '   ');
      expect(screen.getByText('0/1000')).toBeInTheDocument();
      await user.click(saveButton());

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave).bio).toBeNull();
    });
  });

  describe('validation', () => {
    it('refuses a date of birth in the future', async () => {
      const { onSave } = setup();
      fireEvent.change(screen.getByLabelText('Date of birth'), {
        target: { value: '2999-01-01' },
      });

      expect(screen.getByText('Date of birth cannot be in the future.')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('refuses a date of birth more than 120 years ago', () => {
      setup();
      fireEvent.change(screen.getByLabelText('Date of birth'), {
        target: { value: '1800-01-01' },
      });
      expect(
        screen.getByText('Date of birth cannot be more than 120 years ago.'),
      ).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    });

    it('caps the date picker at today', () => {
      setup();
      const max = screen.getByLabelText('Date of birth').getAttribute('max');
      expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('refuses a height outside 50 to 250 cm', async () => {
      const { user } = setup({ profile: { ...mockHealthProfileSaved, unitSystem: 'metric' } });
      const height = screen.getByRole('textbox', { name: 'Height' });

      await user.clear(height);
      await user.type(height, '10');
      expect(screen.getByText('Enter a height between 50 and 250 cm.')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();

      await user.clear(height);
      await user.type(height, 'abc');
      expect(screen.getByText('Enter a number of centimetres.')).toBeInTheDocument();
    });

    it('refuses 12 or more inches', async () => {
      const { user } = setup();
      const inches = screen.getByRole('textbox', { name: 'Height (inches)' });

      await user.clear(inches);
      await user.type(inches, '12');
      expect(screen.getByText('Enter whole feet and inches below 12.')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    });

    it('refuses a bio longer than 1000 characters', () => {
      setup();
      fireEvent.change(screen.getByRole('textbox', { name: 'Bio' }), {
        target: { value: 'a'.repeat(1001) },
      });
      expect(screen.getByText('Keep it to 1000 characters or fewer.')).toBeInTheDocument();
      expect(screen.getByText('1001/1000')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    });
  });

  describe('without health_data:write', () => {
    it('disables every input and Save', () => {
      setup({ canWrite: false });

      expect(screen.getByText(/can view your health profile but not change it/i)).toBeInTheDocument();
      expect(screen.getByLabelText('Date of birth')).toBeDisabled();
      expect(screen.getByRole('combobox', { name: 'Sex at birth' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Metric' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Imperial' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Height (feet)' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Height (inches)' })).toBeDisabled();
      expect(screen.getByRole('combobox', { name: 'Time zone' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'Bio' })).toBeDisabled();
      expect(screen.getByRole('radio', { name: 'US conventional (mg/dL)' })).toBeDisabled();
      expect(screen.getByRole('radio', { name: 'SI (mmol/L)' })).toBeDisabled();
      expect(saveButton()).toBeDisabled();
    });
  });

  describe('lab units (#234)', () => {
    it('shows the stored preference, conventional by default', () => {
      setup();
      const group = screen.getByRole('radiogroup', { name: 'Lab units' });
      expect(within(group).getByRole('radio', { name: 'US conventional (mg/dL)' })).toBeChecked();
      expect(within(group).getByRole('radio', { name: 'SI (mmol/L)' })).not.toBeChecked();
    });

    it('a profile with no labUnits (an older answer) reads as conventional and saves it', async () => {
      const { labUnits: _omit, ...older } = mockHealthProfileSaved;
      void _omit;
      const { user, onSave } = setup({ profile: older as HealthProfile });
      expect(screen.getByRole('radio', { name: 'US conventional (mg/dL)' })).toBeChecked();
      await user.click(saveButton());
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave).labUnits).toBe('conventional');
    });

    it('choosing SI saves labUnits: si with the rest of the profile', async () => {
      const { user, onSave } = setup();
      await user.click(screen.getByRole('radio', { name: 'SI (mmol/L)' }));
      await user.click(saveButton());
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave)).toMatchObject({ labUnits: 'si', unitSystem: 'imperial', heightMm: 1778 });
    });

    it('a stored SI preference is shown and can be switched back', async () => {
      const { user, onSave } = setup({ profile: { ...mockHealthProfileSaved, labUnits: 'si' } });
      expect(screen.getByRole('radio', { name: 'SI (mmol/L)' })).toBeChecked();
      await user.click(screen.getByRole('radio', { name: 'US conventional (mg/dL)' }));
      await user.click(saveButton());
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(savedInput(onSave).labUnits).toBe('conventional');
    });
  });

  describe('save failures', () => {
    it('a 409 shows the conflict message, keeps the edits and offers Reload', async () => {
      const onSave = vi.fn().mockRejectedValue(new ApiError('Version mismatch', 409));
      const { user, onError, onReload, onSaved } = setup({ onSave });
      const bio = screen.getByRole('textbox', { name: 'Bio' });

      await user.clear(bio);
      await user.type(bio, 'My unsaved edit');
      await user.click(saveButton());

      expect(await screen.findByText(HEALTH_PROFILE_CONFLICT_MESSAGE)).toBeInTheDocument();
      expect(bio).toHaveValue('My unsaved edit');
      expect(onError).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Reload' }));
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('a reloaded profile clears the conflict and resets the form', async () => {
      const onSave = vi.fn().mockRejectedValue(new ApiError('Version mismatch', 409));
      const { user, rerender, onReload } = setup({ onSave });

      await user.click(saveButton());
      expect(await screen.findByText(HEALTH_PROFILE_CONFLICT_MESSAGE)).toBeInTheDocument();

      rerender(
        <HealthProfileSettings
          profile={{ ...mockHealthProfileSaved, bio: 'Newer bio', version: 4 }}
          canWrite
          onSave={onSave}
          onReload={onReload}
        />,
      );

      expect(screen.queryByText(HEALTH_PROFILE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Bio' })).toHaveValue('Newer bio');
    });

    it('any other failure is reported through onError', async () => {
      const onSave = vi.fn().mockRejectedValue(new ApiError('Validation failed', 400));
      const { user, onError, onSaved } = setup({ onSave });

      await user.click(saveButton());

      await waitFor(() => expect(onError).toHaveBeenCalledWith('Validation failed'));
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.queryByText(HEALTH_PROFILE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
    });
  });

  describe('time zone list unavailable', () => {
    it('falls back to a free-text field and checks the name', async () => {
      const intl = Intl as unknown as { supportedValuesOf?: unknown };
      const original = intl.supportedValuesOf;
      intl.supportedValuesOf = undefined;
      try {
        const { user, onSave } = setup();
        const field = screen.getByRole('textbox', { name: 'Time zone' });
        expect(field).toHaveValue('America/New_York');

        await user.clear(field);
        await user.type(field, 'Mars/Base');
        expect(screen.getByText(/Enter a time zone name/)).toBeInTheDocument();
        expect(saveButton()).toBeDisabled();

        await user.clear(field);
        await user.type(field, 'UTC');
        await user.click(saveButton());
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(savedInput(onSave).timeZone).toBe('UTC');
      } finally {
        intl.supportedValuesOf = original;
      }
    });
  });
});
