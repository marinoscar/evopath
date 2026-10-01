/**
 * The Biomarkers page (H5, #189) against MSW: analytes grouped by panel with
 * the latest and previous values, the change and the last test date; the
 * panel and out-of-range filters go to the API; the empty state leads to
 * Import lab report; axe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser, type MockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import BiomarkersPage from '../../pages/BiomarkersPage';
import { IMPORT_LAB_REPORT_LABEL } from '../../components/health/LabReportButton';
import { LAB_REPORT_TITLE } from '../../components/health/LabReportDialog';
import { resetMeasurementCatalogCache } from '../../hooks/useMeasurementCatalog';
import { HEALTH_DATA_UNAVAILABLE } from '../../services/health';
import type { BiomarkerSummaryItem } from '../../services/biomarkers';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';
import { mockLabCatalog } from '../mocks/fixtures/labReportIntake';
import { mockBiomarkerSummary } from '../mocks/fixtures/biomarkers';

const importer: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'],
};

/** Answers the summary from `answer(params)`, recording each query string. */
function summaryApi(answer: (params: URLSearchParams) => BiomarkerSummaryItem[] | Response = () => mockBiomarkerSummary) {
  const queries: string[] = [];
  server.use(
    http.get('*/api/measurements/metrics', () => HttpResponse.json({ data: mockLabCatalog })),
    http.get('*/api/health/biomarkers/summary', ({ request }) => {
      const params = new URL(request.url).searchParams;
      queries.push(params.toString());
      const result = answer(params);
      return result instanceof Response ? result : HttpResponse.json({ data: { items: result } });
    }),
  );
  return queries;
}

beforeEach(() => resetMeasurementCatalogCache());
afterEach(() => resetMeasurementCatalogCache());

describe('BiomarkersPage', () => {
  it('groups analytes by panel with latest, previous, change and last test date', async () => {
    const queries = summaryApi();
    const { container } = render(<BiomarkersPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Biomarkers' })).toBeInTheDocument();
    expect(screen.getByTestId('lab-units-note')).toHaveTextContent('Values in US conventional units');

    const panels = await screen.findAllByTestId('biomarker-panel');
    expect(panels.map((p) => within(p).getByRole('heading', { level: 2 }).textContent)).toEqual([
      'Lipids',
      'Glycemic',
      'Thyroid',
    ]);

    const lipids = screen.getByRole('region', { name: 'Lipids' });
    const ldl = within(lipids).getByRole('article', { name: 'LDL cholesterol' });
    expect(within(ldl).getByTestId('biomarker-latest')).toHaveTextContent('142.0 mg/dL');
    expect(within(ldl).getByText('Flag: High')).toBeInTheDocument();
    expect(within(ldl).getByTestId('biomarker-previous')).toHaveTextContent('Previous 130.0 mg/dL on Mar 10, 2026');
    expect(within(ldl).getByTestId('biomarker-change')).toHaveTextContent('Change up: +12.0 mg/dL');
    expect(within(ldl).getByTestId('biomarker-last-test')).toHaveTextContent('Last test Sep 15, 2026 · 3 results');
    expect(within(ldl).getByRole('link')).toHaveAttribute('href', '/health/biomarkers/ldl_cholesterol');

    const hdl = within(lipids).getByRole('article', { name: 'HDL cholesterol' });
    expect(within(hdl).getByTestId('biomarker-change')).toHaveTextContent('Change down: −3.0 mg/dL');

    const hba1c = screen.getByRole('article', { name: 'HbA1c' });
    expect(within(hba1c).getByTestId('biomarker-latest')).toHaveTextContent('5.6%');
    expect(within(hba1c).getByTestId('biomarker-change')).toHaveTextContent('Change unchanged: No change');

    const tsh = screen.getByRole('article', { name: 'TSH' });
    expect(within(tsh).getByTestId('biomarker-previous')).toHaveTextContent('First result');
    expect(within(tsh).queryByTestId('biomarker-change')).not.toBeInTheDocument();
    expect(within(tsh).getByTestId('biomarker-last-test')).toHaveTextContent('Last test Sep 15, 2026');
    expect(within(tsh).getByTestId('biomarker-last-test')).not.toHaveTextContent('results');

    expect(queries).toEqual(['']);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('under the SI preference shows latest, previous, change and units in SI (#234)', async () => {
    summaryApi();
    server.use(
      http.get('*/api/health-profile', () => HttpResponse.json({ data: { ...mockHealthProfileSaved, labUnits: 'si' } })),
    );
    render(<BiomarkersPage />);

    const lipids = await screen.findByRole('region', { name: 'Lipids' });
    expect(screen.getByTestId('lab-units-note')).toHaveTextContent('Values in SI units');
    const ldl = within(lipids).getByRole('article', { name: 'LDL cholesterol' });
    expect(within(ldl).getByTestId('biomarker-latest')).toHaveTextContent('3.67 mmol/L');
    expect(within(ldl).getByTestId('biomarker-previous')).toHaveTextContent('Previous 3.36 mmol/L on Mar 10, 2026');
    // The delta converts with the factor only: +12 mg/dL is +0.31 mmol/L.
    expect(within(ldl).getByTestId('biomarker-change')).toHaveTextContent('Change up: +0.31 mmol/L');
    const hdl = within(lipids).getByRole('article', { name: 'HDL cholesterol' });
    expect(within(hdl).getByTestId('biomarker-change')).toHaveTextContent('Change down: −0.08 mmol/L');

    const hba1c = screen.getByRole('article', { name: 'HbA1c' });
    expect(within(hba1c).getByTestId('biomarker-latest')).toHaveTextContent('38 mmol/mol');
    expect(within(hba1c).getByTestId('biomarker-change')).toHaveTextContent('Change unchanged: No change');
    // An analyte whose SI unit is its canonical one is unchanged.
    expect(within(screen.getByRole('article', { name: 'TSH' })).getByTestId('biomarker-latest')).toHaveTextContent('2.1 mIU/L');
  });

  it('sends the panel and out-of-range filters to the API', async () => {
    const queries = summaryApi((params) =>
      mockBiomarkerSummary.filter(
        (item) =>
          (!params.get('panel') || item.panel === params.get('panel')) &&
          (params.get('outOfRange') !== 'true' || ['low', 'high', 'critical'].includes(item.latest.flag ?? '')),
      ),
    );
    const user = userEvent.setup();
    render(<BiomarkersPage />);
    await screen.findAllByTestId('biomarker-card');

    await user.click(screen.getByRole('switch', { name: 'Out of range only' }));
    await waitFor(() => expect(screen.getAllByTestId('biomarker-card')).toHaveLength(1));
    expect(screen.getByRole('article', { name: 'LDL cholesterol' })).toBeInTheDocument();
    expect(queries.at(-1)).toBe('outOfRange=true');

    await user.click(screen.getByRole('switch', { name: 'Out of range only' }));
    await user.click(screen.getByRole('combobox', { name: 'Panel' }));
    await user.click(await screen.findByRole('option', { name: 'Thyroid' }));
    await waitFor(() => expect(screen.getAllByTestId('biomarker-card')).toHaveLength(1));
    expect(screen.getByRole('article', { name: 'TSH' })).toBeInTheDocument();
    expect(queries.at(-1)).toBe('panel=thyroid');
  });

  it('with filters that match nothing, offers to clear them', async () => {
    summaryApi((params) => (params.get('panel') === 'iron' ? [] : mockBiomarkerSummary));
    const user = userEvent.setup();
    render(<BiomarkersPage />);
    await screen.findAllByTestId('biomarker-card');

    await user.click(screen.getByRole('combobox', { name: 'Panel' }));
    await user.click(await screen.findByRole('option', { name: 'Iron' }));
    expect(await screen.findByText('No biomarkers match these filters')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getAllByTestId('biomarker-card')).toHaveLength(4));
  });

  it('with no results, the empty state leads to Import lab report', async () => {
    summaryApi(() => []);
    const user = userEvent.setup();
    const { container } = render(<BiomarkersPage />, { wrapperOptions: { user: importer, aiEnabled: true } });

    expect(await screen.findByRole('heading', { name: 'No blood work yet' })).toBeInTheDocument();
    expect(screen.getByText(/Import a lab report/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: IMPORT_LAB_REPORT_LABEL });
    // One in the header, one in the empty state.
    expect(buttons).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();

    await user.click(buttons[1]);
    expect(await screen.findByRole('dialog', { name: LAB_REPORT_TITLE })).toBeInTheDocument();
  });

  it('without AI the empty state explains, with no import control', async () => {
    summaryApi(() => []);
    render(<BiomarkersPage />, { wrapperOptions: { aiEnabled: false } });
    expect(await screen.findByRole('heading', { name: 'No blood work yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: IMPORT_LAB_REPORT_LABEL })).not.toBeInTheDocument();
  });

  it('a 403 reads as health data unavailable', async () => {
    summaryApi(() => HttpResponse.json({ error: { message: 'Forbidden' } }, { status: 403 }) as Response);
    render(<BiomarkersPage />);
    expect(await screen.findByText(HEALTH_DATA_UNAVAILABLE)).toBeInTheDocument();
  });

  it('without health_data:read nothing is fetched', async () => {
    const queries = summaryApi();
    render(<BiomarkersPage />, {
      wrapperOptions: { user: { ...mockUser, permissions: mockUser.permissions.filter((p) => !p.startsWith('health_data')) } },
    });
    expect(await screen.findByText(HEALTH_DATA_UNAVAILABLE)).toBeInTheDocument();
    expect(queries).toEqual([]);
  });
});
