/**
 * The Telemetry Explorer's AI assistant conversation — issue #537, epic #528.
 *
 * Streams `POST /admin/telemetry/assistant/stream` (#536) through
 * `streamTelemetryAssistant` (`postSse`). The browser never talks to a model:
 * the API resolves the provider, the key and every tool call server-side and
 * reports each tool step and the final answer as SSE frames.
 *
 * The last {@link ASSISTANT_HISTORY_TURNS} turns (a question and its answer
 * each) are sent back as `history`, so a follow-up ("now only for the api
 * service") has context. `stop()` aborts the stream; `clear()` aborts it and
 * forgets the conversation (the panel's "New chat", issue #574), so the next
 * question is sent with no `history`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  streamTelemetryAssistant,
  type TelemetryAssistantAnswer,
  type TelemetryAssistantReport,
  type TelemetryAssistantStep,
  type TelemetryAssistantTurn,
} from '../services/telemetry';
import { toTelemetryError } from './useTelemetryExplorer';
import { useIsMounted } from './useIsMounted';

export const ASSISTANT_HISTORY_TURNS = 10;
export const ASSISTANT_QUESTION_MAX = 4000;

export interface AssistantUserMessage {
  id: string;
  role: 'user';
  text: string;
}

export interface AssistantReplyMessage {
  id: string;
  role: 'assistant';
  status: 'streaming' | 'done' | 'error' | 'stopped';
  steps: TelemetryAssistantStep[];
  answer: TelemetryAssistantAnswer | null;
  error: { code: string | null; message: string } | null;
}

export type AssistantMessage = AssistantUserMessage | AssistantReplyMessage;

/** Upper bound on one replayed answer, so a long report cannot crowd out the question. */
export const ASSISTANT_HISTORY_ANSWER_MAX = 6000;

function reportAsHistory(report: TelemetryAssistantReport): string {
  const lines: string[] = [`Status: ${report.status} (confidence ${report.confidence})`, `Summary: ${report.summary}`];
  if (report.findings.length) {
    lines.push('Findings:');
    for (const finding of report.findings) lines.push(`- [${finding.severity}] ${finding.title}`);
  }
  if (report.rootCause) lines.push(`Root cause: ${report.rootCause}`);
  if (report.recommendations.length) {
    lines.push('Recommendations:');
    report.recommendations.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  }
  const firstSql = report.queries[0]?.sql;
  if (firstSql) lines.push('', 'SQL:', firstSql);
  return lines.join('\n');
}

/**
 * How an answered turn is replayed to the model as history: a compact report
 * (status, summary, finding titles, root cause, recommendations, first query)
 * bounded to {@link ASSISTANT_HISTORY_ANSWER_MAX}; a legacy answer unchanged.
 */
export function answerAsHistory(answer: TelemetryAssistantAnswer): string {
  if (answer.report) {
    const text = reportAsHistory(answer.report);
    return text.length > ASSISTANT_HISTORY_ANSWER_MAX
      ? `${text.slice(0, ASSISTANT_HISTORY_ANSWER_MAX - 1)}…`
      : text;
  }
  return answer.sql ? `${answer.explanation}\n\nSQL:\n${answer.sql}` : answer.explanation;
}

/**
 * The `history` for the next question: completed turns only (a question whose
 * answer failed is dropped with it), the last {@link ASSISTANT_HISTORY_TURNS}.
 */
export function buildAssistantHistory(messages: AssistantMessage[]): TelemetryAssistantTurn[] {
  const turns: TelemetryAssistantTurn[][] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const next = messages[i + 1];
    if (message.role === 'user' && next?.role === 'assistant' && next.answer) {
      turns.push([
        { role: 'user', content: message.text },
        { role: 'assistant', content: answerAsHistory(next.answer) },
      ]);
      i += 1;
    }
  }
  return turns.slice(-ASSISTANT_HISTORY_TURNS).flat();
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}`;
}

export interface UseTelemetryAssistantOptions {
  /** Called once per turn when the final answer arrives. */
  onAnswer?: (answer: TelemetryAssistantAnswer) => void;
}

export function useTelemetryAssistant(options: UseTelemetryAssistantOptions = {}) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onAnswerRef = useRef(options.onAnswer);
  onAnswerRef.current = options.onAnswer;
  const isMounted = useIsMounted();

  useEffect(() => () => controllerRef.current?.abort(), []);

  const patchReply = useCallback(
    (id: string, patch: (reply: AssistantReplyMessage) => AssistantReplyMessage) => {
      if (!isMounted()) return;
      setMessages((prev) =>
        prev.map((message) =>
          message.id === id && message.role === 'assistant' ? patch(message) : message,
        ),
      );
    },
    [isMounted],
  );

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim().slice(0, ASSISTANT_QUESTION_MAX);
      if (!text || controllerRef.current) return;

      const history = buildAssistantHistory(messagesRef.current);
      const replyId = nextId('assistant');
      setMessages((prev) => [
        ...prev,
        { id: nextId('user'), role: 'user', text },
        { id: replyId, role: 'assistant', status: 'streaming', steps: [], answer: null, error: null },
      ]);

      const controller = new AbortController();
      controllerRef.current = controller;
      setIsStreaming(true);

      try {
        await streamTelemetryAssistant(
          { question: text, ...(history.length ? { history } : {}) },
          {
            signal: controller.signal,
            onStep: (step) =>
              patchReply(replyId, (reply) => ({ ...reply, steps: [...reply.steps, step] })),
            onAnswer: (answer) => {
              patchReply(replyId, (reply) => ({ ...reply, answer }));
              onAnswerRef.current?.(answer);
            },
            onError: (error) =>
              patchReply(replyId, (reply) => ({ ...reply, status: 'error', error })),
          },
        );
        patchReply(replyId, (reply) => ({
          ...reply,
          status: controller.signal.aborted
            ? 'stopped'
            : reply.status === 'error'
              ? 'error'
              : reply.answer
                ? 'done'
                : 'error',
          error:
            reply.error ??
            (controller.signal.aborted || reply.answer
              ? null
              : { code: null, message: 'The assistant ended without an answer.' }),
        }));
      } catch (err) {
        const info = toTelemetryError(err, 'The assistant request failed');
        patchReply(replyId, (reply) => ({
          ...reply,
          status: 'error',
          error: { code: info.reason ?? info.code, message: info.message },
        }));
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (isMounted()) setIsStreaming(false);
      }
    },
    [isMounted, patchReply],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    controllerRef.current?.abort();
    setMessages([]);
  }, []);

  return { messages, isStreaming, ask, stop, clear };
}
