/**
 * The lab review's "Needs attention" badges and filters (#317): a badge on
 * each kind of blocking row (not in the catalog, already saved with no
 * decision, a server issue), reasons shown by a tap (no hover needed), the
 * search over printed names, analytes, aliases and panels, the single-select
 * status chips with their counts, Clear filters and the empty state, the
 * dialog's requests (reveal a row, apply a filter), and an axe pass with
 * filters on. Bulk actions keep acting on every result.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within } from '../../utils/test-utils';
import {
  LabReportReview,
  NO_MATCH_TEXT,
  SEARCH_PLACEHOLDER,
  type LabReportReviewProps,
  type LabReviewRequest,
} from '../../../components/health/LabReportReview';
import { DUPLICATE_REASON, UNMATCHED_REASON, type LabReportIssue } from '../../../services/labReport';
import type { MetricCatalog, MetricDef } from '../../../services/health';
import { LAB_METRICS, labItem, labValue, mockLabCatalog } from '../../mocks/fixtures/labReportIntake';

const NO_VALUE: LabReportIssue = {
  code: 'NO_VALUE',
  field: 'value',
  message: 'BUN/creatinine ratio has no numeric value; enter one or reject it',
};

/** The fixture catalog plus a red blood cell count printed as "RBC". */
const rbcMetric: MetricDef = {
  ...LAB_METRICS.find((metric) => metric.key === 'hdl_cholesterol')!,
  key: 'rbc',
  label: 'Red blood cell count',
  panel: 'cbc',
  canonicalUnit: 'M/µL',
  units: [{ unit: 'M/µL', factor: 1, label: 'M/µL', decimals: 2 }],
  displayUnit: { metric: 'M/µL', imperial: 'M/µL' },
  aliases: ['RBC', 'Erythrocytes'],
  siUnit: 'M/µL',
};
const catalog: MetricCatalog = { ...mockLabCatalog, metrics: [...mockLabCatalog.metrics, rbcMetric] };

function fixture() {
  const lpa = labItem(
    labValue({ nameAsPrinted: 'Lipoprotein (a)', value: 32, unit: 'nmol/L', panel: 'lipids', match: 'unmatched' }),
    { sourcePhotoIds: [] },
  );
  const cholesterol = labItem(
    labValue({ analyteKey: 'total_cholesterol', nameAsPrinted: 'Cholesterol, Total', value: 212, unit: 'mg/dL', panel: 'lipids' }),
    { sourcePhotoIds: [] },
  );
  const hdl = labItem(
    labValue({ analyteKey: 'hdl_cholesterol', nameAsPrinted: 'HDL Cholesterol', value: 48, unit: 'mg/dL', panel: 'lipids' }),
    { sourcePhotoIds: [], status: 'accepted' },
  );
  const bun = labItem(
    labValue({ analyteKey: 'creatinine', nameAsPrinted: 'BUN/Creatinine Ratio', value: null, valueText: 'SEE NOTE', panel: 'cmp' }),
    { sourcePhotoIds: [] },
  );
  const erythrocytes = labItem(
    labValue({ analyteKey: 'rbc', nameAsPrinted: 'Eritrocitos', value: 4.8, unit: 'M/µL', panel: 'cbc' }),
    { sourcePhotoIds: [], status: 'accepted' },
  );
  const rejected = labItem(
    labValue({ analyteKey: 'triglycerides', nameAsPrinted: 'Triglycerides', value: 130, unit: 'mg/dL', panel: 'lipids' }),
    { sourcePhotoIds: [], status: 'rejected' },
  );
  return { lpa, cholesterol, hdl, bun, erythrocytes, rejected };
}

function renderReview(overrides: Partial<LabReportReviewProps> = {}) {
  const items = fixture();
  const props: LabReportReviewProps = {
    items: Object.values(items),
    photos: [],
    catalog,
    onAcceptItem: vi.fn(),
    onRejectItem: vi.fn(),
    onRestoreItem: vi.fn(),
    onEditItem: vi.fn(),
    onAddItem: vi.fn(),
    onAcceptAll: vi.fn(),
    onAcceptHighConfidence: vi.fn(),
    duplicateDates: new Map([[items.cholesterol.id, '2026-09-15']]),
    keptDuplicateIds: new Set(),
    onSkipDuplicate: vi.fn(),
    onKeepDuplicate: vi.fn(),
    issues: new Map([[items.bun.id, [NO_VALUE]]]),
    ...overrides,
  };
  const user = userEvent.setup();
  const utils = render(<LabReportReview {...props} />);
  return { ...utils, items, props, user };
}

const rowFor = (name: string) => {
  const row = screen.getAllByTestId('lab-result-row').find((candidate) => candidate.textContent?.includes(name));
  if (!row) throw new Error(`No row for ${name}`);
  return row;
};
const shownNames = () =>
  screen
    .queryAllByTestId('lab-result-row')
    .filter((row) => !row.closest('[aria-label="Rejected results"]'))
    .map((row) => row.getAttribute('data-item-id'));
const chip = (label: RegExp) => within(screen.getByRole('group', { name: 'Show only' })).getByRole('button', { name: label });

describe('LabReportReview: needs attention (#317)', () => {
  it('badges every kind of blocking row, with the reason count, and leaves the others alone', () => {
    renderReview();
    const badge = (name: string) => within(rowFor(name)).queryByTestId('lab-result-attention-badge');

    expect(badge('Lipoprotein (a)')).toHaveTextContent('Needs attention');
    expect(badge('Cholesterol, Total')).toHaveTextContent('Needs attention');
    expect(badge('BUN/Creatinine Ratio')).toHaveTextContent('Needs attention');
    expect(badge('HDL Cholesterol')).toBeNull();
    expect(badge('Eritrocitos')).toBeNull();
    expect(rowFor('BUN/Creatinine Ratio')).toHaveAttribute('data-blocking', 'true');
    expect(rowFor('BUN/Creatinine Ratio')).toHaveAttribute('data-attention', 'true');
    expect(rowFor('HDL Cholesterol')).toHaveAttribute('data-attention', 'false');
    expect(rowFor('HDL Cholesterol')).toHaveAttribute('data-blocking', 'false');
  });

  it('counts the reasons when there is more than one', () => {
    const { lpa } = fixture();
    render(
      <LabReportReview
        items={[lpa]}
        photos={[]}
        catalog={catalog}
        onAcceptItem={vi.fn()}
        onRejectItem={vi.fn()}
        onRestoreItem={vi.fn()}
        onEditItem={vi.fn()}
        onAddItem={vi.fn()}
        onAcceptAll={vi.fn()}
        onAcceptHighConfidence={vi.fn()}
        issues={new Map([[lpa.id, [{ code: 'UNMATCHED', field: 'analyteKey', message: 'x' }, NO_VALUE]]])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Needs attention · 2: Lipoprotein (a)' })).toBeInTheDocument();
  });

  it('a duplicate the user chose to save again needs no attention', () => {
    const { items, props, rerender } = renderReview();
    expect(within(rowFor('Cholesterol, Total')).getByTestId('lab-result-attention-badge')).toBeInTheDocument();
    rerender(<LabReportReview {...props} keptDuplicateIds={new Set([items.cholesterol.id])} />);
    expect(within(rowFor('Cholesterol, Total')).queryByTestId('lab-result-attention-badge')).toBeNull();
    expect(rowFor('Cholesterol, Total')).toHaveAttribute('data-duplicate', 'true');
  });

  it('shows the reasons on a tap and hides them again (no hover needed)', async () => {
    const { user } = renderReview();
    const badge = within(rowFor('Lipoprotein (a)')).getByRole('button', { name: /^Needs attention/ });
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    const reasons = document.getElementById(badge.getAttribute('aria-controls')!)!;
    expect(reasons).not.toBeVisible();

    await user.click(badge);
    expect(badge).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(reasons).toBeVisible());
    expect(reasons).toHaveTextContent(UNMATCHED_REASON);

    await user.click(within(rowFor('Cholesterol, Total')).getByRole('button', { name: /^Needs attention/ }));
    expect(within(rowFor('Cholesterol, Total')).getByTestId('lab-result-attention-reasons')).toHaveTextContent(DUPLICATE_REASON);

    await user.click(within(rowFor('BUN/Creatinine Ratio')).getByRole('button', { name: /^Needs attention/ }));
    expect(within(rowFor('BUN/Creatinine Ratio')).getByTestId('lab-result-attention-reasons')).toHaveTextContent(NO_VALUE.message);

    await user.click(badge);
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(reasons).not.toBeVisible());
  });

  it('opens the reasons from the keyboard', async () => {
    const { user } = renderReview();
    const badge = within(rowFor('Lipoprotein (a)')).getByRole('button', { name: /^Needs attention/ });
    badge.focus();
    await user.keyboard('{Enter}');
    expect(badge).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('LabReportReview: search and filters (#317)', () => {
  it('finds a result by an alias of its analyte ("RBC" finds "Eritrocitos")', async () => {
    const { user, items } = renderReview();
    expect(screen.getByTestId('lab-review-showing')).toHaveTextContent('Showing 6 of 6 results');

    await user.type(screen.getByRole('textbox', { name: 'Search results' }), 'rbc');
    await waitFor(() => expect(shownNames()).toEqual([items.erythrocytes.id]));
    expect(screen.getByTestId('lab-review-showing')).toHaveTextContent('Showing 1 of 6 results');
    expect(screen.getByRole('textbox', { name: 'Search results' })).toHaveAttribute('placeholder', SEARCH_PLACEHOLDER);
    // Only the matching panel is left, with its count out of the whole.
    expect(screen.getAllByTestId('lab-panel').map((panel) => panel.getAttribute('data-panel'))).toEqual(['cbc']);
    expect(screen.getByRole('heading', { name: 'Complete blood count (1 of 1)' })).toBeInTheDocument();
    // The rejected section follows the search: no rejected result matches.
    expect(screen.queryByText(/^Rejected/)).not.toBeInTheDocument();
  });

  it('matches the panel label and the printed name, without accents, and the rejected section too', async () => {
    const { user, items } = renderReview();
    const search = screen.getByRole('textbox', { name: 'Search results' });
    await user.type(search, 'metabolic');
    await waitFor(() => expect(shownNames()).toEqual([items.bun.id]));

    await user.clear(search);
    await user.type(search, 'TRIGLYCÉRIDES');
    await waitFor(() => expect(screen.getByText('Rejected (1 of 1)')).toBeInTheDocument());
    expect(screen.getByText(NO_MATCH_TEXT)).toBeInTheDocument();
  });

  it('filters by one status at a time, with counts, and Clear filters brings everything back', async () => {
    const { user, items } = renderReview();
    expect(chip(/^Needs attention \(3\)$/)).toHaveAttribute('aria-pressed', 'false');
    expect(chip(/^Unmatched \(1\)$/)).toBeInTheDocument();
    expect(chip(/^Already saved \(1\)$/)).toBeInTheDocument();
    expect(chip(/^Pending \(3\)$/)).toBeInTheDocument();

    await user.click(chip(/^Needs attention/));
    expect(chip(/^Needs attention/)).toHaveAttribute('aria-pressed', 'true');
    expect(shownNames()).toEqual([items.lpa.id, items.cholesterol.id, items.bun.id]);

    // Single-select: another chip replaces it.
    await user.click(chip(/^Unmatched/));
    expect(chip(/^Needs attention/)).toHaveAttribute('aria-pressed', 'false');
    expect(chip(/^Unmatched/)).toHaveAttribute('aria-pressed', 'true');
    expect(shownNames()).toEqual([items.lpa.id]);

    // Filters never change what the bulk actions act on.
    expect(screen.getByRole('button', { name: 'Accept all (3)' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(shownNames()).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('combines a chip with the search and shows the empty state with Clear filters', async () => {
    const { user } = renderReview();
    await user.click(chip(/^Unmatched/));
    await user.type(screen.getByRole('textbox', { name: 'Search results' }), 'glucose');
    expect(await screen.findByText(NO_MATCH_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId('lab-review-showing')).toHaveTextContent('Showing 0 of 6 results');

    await user.click(within(screen.getByTestId('lab-review-no-match')).getByRole('button', { name: 'Clear filters' }));
    expect(screen.queryByText(NO_MATCH_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search results' })).toHaveValue('');
  });

  it('clears the search with its own button', async () => {
    const { user } = renderReview();
    const search = screen.getByRole('textbox', { name: 'Search results' });
    await user.type(search, 'zzz');
    expect(await screen.findByText(NO_MATCH_TEXT)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(screen.queryByText(NO_MATCH_TEXT)).not.toBeInTheDocument();
  });

  it('has no axe violations with filters on and reasons open', async () => {
    const { user, container } = renderReview();
    await user.click(chip(/^Needs attention/));
    await user.click(within(rowFor('Lipoprotein (a)')).getByRole('button', { name: /^Needs attention/ }));
    await user.type(screen.getByRole('textbox', { name: 'Search results' }), 'chol');
    await waitFor(() => expect(screen.getByTestId('lab-review-showing')).toHaveTextContent('Showing 1 of 6 results'));
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

describe('LabReportReview: requests from the dialog (#317)', () => {
  it('reveals a row: clears a filter hiding it, opens its reasons and highlights it', async () => {
    const { user, items, props, rerender } = renderReview();
    await user.click(chip(/^Unmatched/));
    expect(shownNames()).toEqual([items.lpa.id]);

    const request: LabReviewRequest = { seq: 1, type: 'reveal', itemId: items.bun.id };
    rerender(<LabReportReview {...props} request={request} />);

    await waitFor(() => expect(rowFor('BUN/Creatinine Ratio')).toHaveAttribute('data-highlighted', 'true'));
    expect(chip(/^Unmatched/)).toHaveAttribute('aria-pressed', 'false');
    expect(within(rowFor('BUN/Creatinine Ratio')).getByRole('button', { name: /^Needs attention/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(rowFor('BUN/Creatinine Ratio')).toHaveFocus();
  });

  it('applies the Needs attention filter on request', async () => {
    const { items, props, rerender } = renderReview();
    rerender(<LabReportReview {...props} request={{ seq: 1, type: 'filter', filter: 'attention' }} />);
    await waitFor(() => expect(chip(/^Needs attention/)).toHaveAttribute('aria-pressed', 'true'));
    expect(shownNames()).toEqual([items.lpa.id, items.cholesterol.id, items.bun.id]);
  });
});
