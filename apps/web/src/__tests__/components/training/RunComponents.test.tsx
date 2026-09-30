/**
 * Run view components in isolation (E5.6): the stage stepper's states and
 * polite announcement, the source list's cap and dropped counts, the critic
 * scorecard's text alternatives, the sent-data panel, and each at phone
 * width in dark mode without axe violations.
 */
import { describe, it, expect, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, within } from '../../utils/test-utils';
import { setViewportWidth, resetViewportWidth } from '../../setup';
import { RunStageStepper } from '../../../components/training/RunStageStepper';
import { SourceList } from '../../../components/training/SourceList';
import { CriticScorecard } from '../../../components/training/CriticScorecard';
import { SentDataPanel, NEVER_SENT } from '../../../components/training/SentDataPanel';
import { initialRunViewState, reduceRunEventList } from '../../../utils/reduceRunEvents';
import { runEvents } from '../../mocks/fixtures/runEvents';
import { mockRun } from '../../mocks/fixtures/programs';

afterEach(() => {
  resetViewportWidth();
  localStorage.removeItem('theme_mode');
});

describe('RunStageStepper', () => {
  it('marks done, current and pending stages and announces the activity politely', () => {
    const view = reduceRunEventList(initialRunViewState(), runEvents().slice(0, 13));
    render(<RunStageStepper view={view} run={mockRun()} active />);
    expect(screen.getByTestId('run-stage-research')).toHaveTextContent('Research, done');
    expect(screen.getByTestId('run-stage-plan')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('run-stage-ready')).toHaveTextContent('Ready, not started');
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Planner (frontier-1) is revising the plan.');
  });

  it('says nothing when the run is not working', () => {
    render(<RunStageStepper view={initialRunViewState()} run={mockRun({ status: 'failed' })} active={false} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});

describe('SourceList', () => {
  it('caps the list with show more', async () => {
    const sources = Array.from({ length: 12 }, (_, i) => ({
      id: `S${i + 1}`,
      url: `https://example${i}.org/a`,
      title: `Source ${i + 1}`,
      domain: `example${i}.org`,
      kind: 'rct',
    }));
    render(<SourceList sources={sources} brief={{ claimCount: 5, sourceCount: 12, droppedClaims: 1, droppedSources: 1 }} />);
    expect(screen.getAllByTestId('source-row')).toHaveLength(8);
    await userEvent.click(screen.getByRole('button', { name: 'Show 4 more' }));
    expect(screen.getAllByTestId('source-row')).toHaveLength(12);
    expect(screen.getByText(/1 source could not be verified and was removed; 1 claim without a verified source was dropped/)).toBeInTheDocument();
    expect(screen.getAllByText('Trial')[0]).toBeInTheDocument();
  });
});

describe('CriticScorecard', () => {
  it('gives every bar a text alternative', () => {
    const view = reduceRunEventList(initialRunViewState(), runEvents());
    render(<CriticScorecard round={view.critic[1]} />);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('rowheader');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Goal fit',
      'Equipment',
      'Volume and intensity',
      'Recovery',
      'Injury handling',
      'Progression',
      'Realistic to follow',
      'Evidence',
    ]);
    expect(within(table).getAllByText(/of 5$/)).toHaveLength(8);
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Good plan.')).toBeInTheDocument();
  });

  it('shows a skipped round without a table', () => {
    render(<CriticScorecard round={{ round: 3, verdict: 'skipped', scores: null, blockers: [], summary: '' }} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });
});

describe('SentDataPanel', () => {
  it('lists sections per agent and what is never sent', async () => {
    render(
      <SentDataPanel
        entries={[
          {
            role: 'critic',
            provider: 'openai',
            model: 'frontier-1',
            keySource: 'org',
            sections: [{ key: 'plan', title: 'The draft plan', items: [], count: 1 }],
            dropped: [],
            excluded: ['photos'],
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByText(/Critic \(frontier-1\): 1 section/));
    expect(await screen.findByText('The draft plan (1)')).toBeVisible();
    expect(screen.getByText('Never sent to this agent: photos.')).toBeInTheDocument();
    expect(screen.getByText(NEVER_SENT)).toBeInTheDocument();
  });
});

describe('at phone width in dark mode', () => {
  it('has no axe violations', async () => {
    localStorage.setItem('theme_mode', 'dark');
    setViewportWidth(360);
    const view = reduceRunEventList(initialRunViewState(), runEvents());
    const { container } = render(
      <>
        <RunStageStepper view={view} run={mockRun()} active={false} />
        <SourceList sources={view.sources} queries={view.queries} brief={view.brief} />
        <CriticScorecard round={view.critic[0]} />
      </>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
