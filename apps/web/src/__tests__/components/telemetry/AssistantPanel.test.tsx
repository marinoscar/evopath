/**
 * The troubleshooting agent's UI (issue #571): the report card, the
 * investigation timeline, the panel's empty state, and how an answered turn
 * is replayed to the model as history.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ReportCard, LegacyAnswer } from '../../../components/telemetry/AssistantReport';
import { AssistantTimeline } from '../../../components/telemetry/AssistantTimeline';
import { AssistantPanel } from '../../../components/telemetry/AssistantPanel';
import {
  answerAsHistory,
  ASSISTANT_HISTORY_ANSWER_MAX,
  type AssistantReplyMessage,
} from '../../../hooks/useTelemetryAssistant';
import type {
  TelemetryAssistantAnswer,
  TelemetryAssistantReport,
  TelemetryAssistantStep,
} from '../../../services/telemetry';

const REPORT: TelemetryAssistantReport = {
  status: 'issue_found',
  summary: '42 of 1,310 requests failed in the last hour, all on POST /api/jobs.',
  findings: [
    { title: 'POST /api/jobs failing', severity: 'high', evidence: '42 error spans since 10:05 UTC.', queryIndex: 0 },
    { title: 'Latency also elevated', severity: 'low', evidence: 'p95 rose to 900ms.', queryIndex: 1 },
  ],
  rootCause: 'Database timeouts on the jobs insert.',
  confidence: 'medium',
  recommendations: ['Check database connection pool saturation.', 'Add an index on jobs.status.'],
  queries: [
    { title: 'Error spans by name', sql: "SELECT span_name, count(*) FROM opentelemetry_traces WHERE span_status_code = 'STATUS_CODE_ERROR'" },
    { title: 'p95 latency', sql: 'SELECT approx_percentile_cont(duration_nano, 0.95) FROM opentelemetry_traces' },
  ],
};

describe('ReportCard', () => {
  it('renders the status chip, confidence, findings with severity, root cause and recommendations', () => {
    render(<ReportCard report={REPORT} onInsert={vi.fn()} onInsertAndRun={vi.fn()} />);

    const status = screen.getByTestId('assistant-report-status');
    expect(status).toHaveAttribute('data-status', 'issue_found');
    expect(status).toHaveTextContent('Issue found');

    const findings = screen.getAllByTestId('assistant-finding');
    expect(findings).toHaveLength(2);
    expect(findings[0]).toHaveAttribute('data-severity', 'high');
    expect(findings[0]).toHaveTextContent('POST /api/jobs failing');
    expect(findings[1]).toHaveAttribute('data-severity', 'low');

    expect(screen.getByTestId('assistant-root-cause')).toHaveTextContent('Database timeouts on the jobs insert.');

    const recommendations = screen.getAllByTestId('assistant-recommendation');
    expect(recommendations).toHaveLength(2);
    expect(recommendations[0]).toHaveTextContent('Check database connection pool saturation.');
  });

  it('"View query" expands the query the finding points at, not just the first one', async () => {
    const user = userEvent.setup();
    render(<ReportCard report={REPORT} onInsert={vi.fn()} onInsertAndRun={vi.fn()} />);

    const accordions = screen.getAllByTestId('assistant-query');
    expect(accordions).toHaveLength(2);
    expect(accordions[0]).not.toHaveClass('Mui-expanded');
    expect(accordions[1]).not.toHaveClass('Mui-expanded');

    const findings = screen.getAllByTestId('assistant-finding');
    await user.click(within(findings[1]).getByRole('button', { name: 'View query' }));

    expect(accordions[1]).toHaveClass('Mui-expanded');
    expect(accordions[0]).not.toHaveClass('Mui-expanded');
    expect(within(accordions[1]).getByText(REPORT.queries[1].sql)).toBeInTheDocument();
  });

  it('Insert and Insert & run call back with the right query SQL', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    const onInsertAndRun = vi.fn();
    render(<ReportCard report={REPORT} onInsert={onInsert} onInsertAndRun={onInsertAndRun} />);

    // Open the second query's accordion, then use ITS buttons.
    const accordions = screen.getAllByTestId('assistant-query');
    await user.click(within(accordions[1]).getByRole('button', { name: REPORT.queries[1].title }));
    await user.click(within(accordions[1]).getByRole('button', { name: 'Insert into editor' }));
    expect(onInsert).toHaveBeenCalledWith(REPORT.queries[1].sql);

    await user.click(within(accordions[1]).getByRole('button', { name: 'Insert & run' }));
    expect(onInsertAndRun).toHaveBeenCalledWith(REPORT.queries[1].sql);

    expect(onInsert).not.toHaveBeenCalledWith(REPORT.queries[0].sql);
  });

  it('omits the findings/root-cause/recommendations/queries sections when the report has none', () => {
    const minimal: TelemetryAssistantReport = {
      status: 'no_data',
      summary: 'No telemetry for that period.',
      findings: [],
      rootCause: null,
      confidence: 'low',
      recommendations: [],
      queries: [],
    };
    render(<ReportCard report={minimal} onInsert={vi.fn()} onInsertAndRun={vi.fn()} />);

    expect(screen.queryByTestId('assistant-finding')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-root-cause')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-recommendation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-query')).not.toBeInTheDocument();
  });
});

describe('LegacyAnswer (pre-#571 API, or an unparsed model reply)', () => {
  it('renders the explanation and the one SQL block', () => {
    const answer: TelemetryAssistantAnswer = { sql: 'SELECT 1', explanation: 'One row.' };
    render(<LegacyAnswer answer={answer} onInsert={vi.fn()} onInsertAndRun={vi.fn()} />);

    expect(screen.getByTestId('assistant-explanation')).toHaveTextContent('One row.');
    expect(screen.getByTestId('assistant-sql')).toHaveTextContent('SELECT 1');
  });

  it('renders no SQL block when the answer carries none', () => {
    const answer: TelemetryAssistantAnswer = { sql: null, explanation: 'Not answerable.' };
    render(<LegacyAnswer answer={answer} onInsert={vi.fn()} onInsertAndRun={vi.fn()} />);

    expect(screen.queryByTestId('assistant-sql')).not.toBeInTheDocument();
  });
});

describe('AssistantTimeline', () => {
  const STEP_APP_CONTEXT: TelemetryAssistantStep = { index: 0, tool: 'get_app_context', durationMs: 85 };
  const STEP_HEALTH: TelemetryAssistantStep = {
    index: 1,
    tool: 'health_overview',
    input: { window: '1h' },
    durationMs: 420,
    thought: 'Taking a one-hour baseline of errors and latency.',
  };
  const STEP_TRACE: TelemetryAssistantStep = {
    index: 2,
    tool: 'get_trace',
    input: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' },
    rowCount: 7,
    truncated: false,
    durationMs: 55,
  };

  it('labels get_app_context, health_overview and get_trace steps', () => {
    render(
      <AssistantTimeline steps={[STEP_APP_CONTEXT, STEP_HEALTH, STEP_TRACE]} isInvestigating={false} collapsible={false} />,
    );

    const steps = screen.getAllByTestId('assistant-step');
    expect(steps[0]).toHaveTextContent('Read app configuration');
    expect(steps[1]).toHaveTextContent('Health overview');
    expect(steps[2]).toHaveTextContent('Traced');
  });

  it('shows the thought only on the step that carries one', () => {
    render(<AssistantTimeline steps={[STEP_APP_CONTEXT, STEP_HEALTH]} isInvestigating={false} collapsible={false} />);

    const thoughts = screen.getAllByTestId('assistant-thought');
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toHaveTextContent('Taking a one-hour baseline of errors and latency.');
  });

  it('shows "Investigating…" with a step count while streaming, and no toggle', () => {
    render(<AssistantTimeline steps={[STEP_APP_CONTEXT]} isInvestigating collapsible={false} />);

    expect(screen.getByText(/Investigating…/)).toHaveTextContent('Investigating… (1 step)');
    expect(screen.queryByTestId('assistant-timeline-toggle')).not.toBeInTheDocument();
  });

  it('renders nothing once done with zero steps', () => {
    const { container } = render(<AssistantTimeline steps={[]} isInvestigating={false} collapsible={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('collapses behind a toggle once an answer has arrived, and expands on click', async () => {
    const user = userEvent.setup();
    render(<AssistantTimeline steps={[STEP_APP_CONTEXT, STEP_HEALTH, STEP_TRACE]} isInvestigating={false} collapsible />);

    const toggle = screen.getByTestId('assistant-timeline-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Show investigation (3 steps)');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Hide investigation (3 steps)');
  });
});

describe('AssistantPanel empty state', () => {
  it('calls onAsk with the example prompt text when a chip is clicked', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(
      <AssistantPanel
        messages={[]}
        isStreaming={false}
        onAsk={onAsk}
        onStop={vi.fn()}
        onInsert={vi.fn()}
        onInsertAndRun={vi.fn()}
      />,
    );

    const chip = screen.getByText('Why is the API slow?');
    await user.click(chip);

    expect(onAsk).toHaveBeenCalledWith('Why is the API slow?');
  });

  it('disables the example chips while a turn is streaming', () => {
    render(
      <AssistantPanel
        messages={[]}
        isStreaming
        onAsk={vi.fn()}
        onStop={vi.fn()}
        onInsert={vi.fn()}
        onInsertAndRun={vi.fn()}
      />,
    );

    expect(screen.getByText('Why is the API slow?').closest('.MuiChip-root')).toHaveClass('Mui-disabled');
  });
});

describe('AssistantPanel reply rendering', () => {
  function replyMessage(overrides: Partial<AssistantReplyMessage> = {}): AssistantReplyMessage {
    return {
      id: 'assistant-1',
      role: 'assistant',
      status: 'done',
      steps: [],
      answer: null,
      error: null,
      ...overrides,
    };
  }

  it('falls back to the legacy explanation + sql rendering when the answer carries no report', () => {
    const reply = replyMessage({ answer: { sql: 'SELECT 1', explanation: 'Legacy answer.' } });
    render(
      <AssistantPanel
        messages={[{ id: 'u1', role: 'user', text: 'q' }, reply]}
        isStreaming={false}
        onAsk={vi.fn()}
        onStop={vi.fn()}
        onInsert={vi.fn()}
        onInsertAndRun={vi.fn()}
      />,
    );

    expect(screen.getByTestId('assistant-explanation')).toHaveTextContent('Legacy answer.');
    expect(screen.getByTestId('assistant-sql')).toHaveTextContent('SELECT 1');
    expect(screen.queryByTestId('assistant-report')).not.toBeInTheDocument();
  });

  it('renders the structured report when the answer carries one', () => {
    const reply = replyMessage({ answer: { sql: REPORT.queries[0].sql, explanation: REPORT.summary, report: REPORT } });
    render(
      <AssistantPanel
        messages={[{ id: 'u1', role: 'user', text: 'q' }, reply]}
        isStreaming={false}
        onAsk={vi.fn()}
        onStop={vi.fn()}
        onInsert={vi.fn()}
        onInsertAndRun={vi.fn()}
      />,
    );

    expect(screen.getByTestId('assistant-report')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-report-status')).toHaveAttribute('data-status', 'issue_found');
  });
});

describe('AssistantPanel New chat (#574)', () => {
  const conversation = [
    { id: 'u1', role: 'user' as const, text: 'q' },
    {
      id: 'a1',
      role: 'assistant' as const,
      status: 'done' as const,
      steps: [],
      answer: { sql: 'SELECT 1', explanation: 'Legacy answer.' },
      error: null,
    },
  ];

  it('is hidden while there is no conversation', () => {
    render(
      <AssistantPanel
        messages={[]}
        isStreaming={false}
        onAsk={vi.fn()}
        onStop={vi.fn()}
        onInsert={vi.fn()}
        onInsertAndRun={vi.fn()}
        onNewChat={vi.fn()}
        modelCaption="openai · gpt-5-mini"
      />,
    );

    expect(screen.queryByTestId('assistant-new-chat')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-model')).toHaveTextContent('openai · gpt-5-mini');
  });

  it('is shown once there are messages, and clicking it calls onNewChat and empties the input', async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    render(
      <AssistantPanel
        messages={conversation}
        isStreaming={false}
        onAsk={vi.fn()}
        onStop={vi.fn()}
        onInsert={vi.fn()}
        onInsertAndRun={vi.fn()}
        onNewChat={onNewChat}
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    await user.type(input, 'half-typed');
    const button = screen.getByRole('button', { name: 'Start a new chat' });
    expect(button).toHaveAttribute('data-testid', 'assistant-new-chat');
    expect(button).toHaveTextContent('New chat');

    await user.click(button);

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');
  });

  it('is available while a turn is streaming', async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    render(
      <AssistantPanel
        messages={conversation}
        isStreaming
        onAsk={vi.fn()}
        onStop={vi.fn()}
        onInsert={vi.fn()}
        onInsertAndRun={vi.fn()}
        onNewChat={onNewChat}
      />,
    );

    await user.click(screen.getByTestId('assistant-new-chat'));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});

describe('answerAsHistory', () => {
  it('turns a report into a compact status/summary/findings/root-cause/recommendations/sql text', () => {
    const answer: TelemetryAssistantAnswer = { sql: REPORT.queries[0].sql, explanation: REPORT.summary, report: REPORT };
    const text = answerAsHistory(answer);

    expect(text).toContain('Status: issue_found (confidence medium)');
    expect(text).toContain(`Summary: ${REPORT.summary}`);
    expect(text).toContain('- [high] POST /api/jobs failing');
    expect(text).toContain('- [low] Latency also elevated');
    expect(text).toContain('Root cause: Database timeouts on the jobs insert.');
    expect(text).toContain('1. Check database connection pool saturation.');
    expect(text).toContain('2. Add an index on jobs.status.');
    expect(text).toContain(`SQL:\n${REPORT.queries[0].sql}`);
  });

  it('falls back to explanation + sql for a legacy answer with no report', () => {
    const answer: TelemetryAssistantAnswer = { sql: 'SELECT 1', explanation: 'Legacy.' };
    expect(answerAsHistory(answer)).toBe('Legacy.\n\nSQL:\nSELECT 1');
  });

  it('falls back to just the explanation for a legacy answer with no sql', () => {
    const answer: TelemetryAssistantAnswer = { sql: null, explanation: 'No query.' };
    expect(answerAsHistory(answer)).toBe('No query.');
  });

  it('cuts a long report to ASSISTANT_HISTORY_ANSWER_MAX characters, with an ellipsis', () => {
    const longReport: TelemetryAssistantReport = {
      ...REPORT,
      summary: 'x'.repeat(ASSISTANT_HISTORY_ANSWER_MAX + 500),
    };
    const answer: TelemetryAssistantAnswer = { sql: null, explanation: longReport.summary, report: longReport };

    const text = answerAsHistory(answer);
    expect(text).toHaveLength(ASSISTANT_HISTORY_ANSWER_MAX);
    expect(text.endsWith('…')).toBe(true);
  });

  it('does not cut a report at or under the limit', () => {
    const report: TelemetryAssistantReport = { ...REPORT, findings: [], recommendations: [], queries: [], rootCause: null };
    const answer: TelemetryAssistantAnswer = { sql: null, explanation: report.summary, report };

    const text = answerAsHistory(answer);
    expect(text.length).toBeLessThan(ASSISTANT_HISTORY_ANSWER_MAX);
    expect(text.endsWith('…')).toBe(false);
  });
});

describe('AssistantPanel initialQuestion (#579)', () => {
  const panel = (props: { onAsk: (q: string) => void; initialQuestion?: string }) => (
    <AssistantPanel
      messages={[]}
      isStreaming={false}
      onStop={vi.fn()}
      onInsert={vi.fn()}
      onInsertAndRun={vi.fn()}
      {...props}
    />
  );

  it('prefills the question box and focuses it, without sending', () => {
    const onAsk = vi.fn();
    render(panel({ onAsk, initialQuestion: 'Investigate "Top errors".' }));

    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    expect(input).toHaveValue('Investigate "Top errors".');
    expect(input).toHaveFocus();
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('sends the (edited) prefill only when Ask is pressed', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(panel({ onAsk, initialQuestion: 'Why?' }));

    await user.type(screen.getByRole('textbox', { name: 'Ask the assistant' }), ' Now.');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk).toHaveBeenCalledWith('Why? Now.');
  });

  it('prefills again when remounted with a new key', () => {
    const onAsk = vi.fn();
    const { rerender } = render(<div key="a">{panel({ onAsk, initialQuestion: 'First' })}</div>);
    expect(screen.getByRole('textbox', { name: 'Ask the assistant' })).toHaveValue('First');
    rerender(<div key="b">{panel({ onAsk, initialQuestion: 'Second' })}</div>);
    expect(screen.getByRole('textbox', { name: 'Ask the assistant' })).toHaveValue('Second');
  });

  it('without it, starts empty and unfocused as before', () => {
    render(panel({ onAsk: vi.fn() }));
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    expect(input).toHaveValue('');
    expect(input).not.toHaveFocus();
  });
});
