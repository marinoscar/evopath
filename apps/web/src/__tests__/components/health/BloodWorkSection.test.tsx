/**
 * "Blood work" on the Health page (#189) names the unit system the
 * biomarker views use (#234): US conventional by default, SI when preferred.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '../../utils/test-utils';
import { BloodWorkSection, VIEW_BIOMARKERS_LABEL } from '../../../components/health/biomarkers/BloodWorkSection';

describe('BloodWorkSection', () => {
  it('states US conventional units by default', () => {
    render(<BloodWorkSection />);
    expect(screen.getByRole('region', { name: 'Blood work' })).toBeInTheDocument();
    expect(screen.getByTestId('lab-units-note')).toHaveTextContent('Values in US conventional units.');
    expect(screen.getByRole('link', { name: VIEW_BIOMARKERS_LABEL })).toHaveAttribute('href', '/health/biomarkers');
  });

  it('states SI units under the SI preference', () => {
    render(<BloodWorkSection labUnits="si" />);
    expect(screen.getByTestId('lab-units-note')).toHaveTextContent('Values in SI units.');
  });
});
