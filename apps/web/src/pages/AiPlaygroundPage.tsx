/**
 * AI Playground (`/ai`) — issue #434, epic #419.
 *
 * The template's copyable reference for consuming AI from the browser, and a
 * user's way to prove their setup works end to end: pick a usable model, chat
 * with it token by token, stop it, and see what each turn cost.
 *
 * HOSTED TOOLS (#445, API #442). Web search, file search, code interpreter
 * and image generation are offered as toggles only when the model declares
 * `hosted_tools` and an administrator switched that tool on (`GET /ai/config`
 * `hostedTools`); their results render under the answer
 * (`AiHostedToolOutputs`). MCP is left to feature code — see
 * `AiHostedToolControls`.
 *
 * ATTACHMENTS (#445, API #441). Chat turns may carry images and files the
 * selected model can read (see `AiChatAttachmentPicker`). They are uploaded
 * through the storage API when the turn is sent, then named by
 * `storageObjectId` in `image`/`file` content parts — for a streamed turn and
 * a background run alike.
 *
 * MODES (#445). A segmented control switches between Chat, Image,
 * Transcribe, Speech, Embeddings and — only when an administrator allows
 * realtime sessions (`GET /ai/config` `allowRealtime`, #449) — Voice. Each mode lists only the usable models
 * that declare its capability, and a mode no usable model can serve is
 * disabled with the reason — all derived from `GET /api/ai/models`, never
 * from model names (`components/ai/playground/aiPlaygroundModes.ts`). A
 * mode's panel stays mounted once visited, so switching away and back keeps
 * its inputs and any run it is polling.
 *
 * LAYOUT. Every mode uses `AiPlaygroundPanels`: a settings panel beside the
 * work area from `sm` up; below `sm` the panel stacks above and collapses
 * behind a "Settings" toggle. The compact switch is `down('sm')` — the same
 * boundary as CLAUDE.md's five coupled breakpoint gates, none of which this
 * page changes.
 *
 * CONTROLS FOLLOW THE MODEL. Each control is shown only when the selected
 * model declares the capability it needs, so a request can never carry an
 * option the model would reject with `AI_CAPABILITY_UNSUPPORTED`.
 *
 * The page re-checks `ai:use` itself after its hooks, like every settings
 * page: the route's `RequirePermission` is the real gate, and this is defence
 * in depth for a render reached some other way.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Container,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Send as SendIcon, Stop as StopIcon } from '@mui/icons-material';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { useUserSettings } from '../hooks/useUserSettings';
import type { UserSettings } from '../types';
import { useAiChat, type AiChatRequestOptions } from '../hooks/useAiChat';
import { useAiRun } from '../hooks/useAiRun';
import { useAiConfig } from '../hooks/useAiConfig';
import { ApiError } from '../services/api';
import {
  isAiResponseRunOutput,
  listUsableAiModels,
  type AiResponseRequest,
  type UsableAiModel,
} from '../services/ai';
import { useIsMounted } from '../hooks/useIsMounted';
import { AiModelSelect, hasAiCapability } from '../components/ai/AiModelSelect';
import { AiChatThread } from '../components/ai/AiChatThread';
import { AI_KEYS_PATH } from '../components/ai/AiErrorAlert';
import { AiRunCard } from '../components/ai/AiRunCard';
import {
  AI_PLAYGROUND_MODES,
  hiddenPlaygroundModes,
  initialPlaygroundMode,
  modelsForMode,
  unavailableModes,
  type AiPlaygroundMode,
  type AiPlaygroundModeId,
} from '../components/ai/playground/aiPlaygroundModes';
import { AiPlaygroundModeSelector } from '../components/ai/playground/AiPlaygroundModeSelector';
import { AiPlaygroundPanels } from '../components/ai/playground/AiPlaygroundPanels';
import { AiModePlaceholder } from '../components/ai/playground/AiModePlaceholder';
import { AiImageMode } from '../components/ai/playground/AiImageMode';
import { AiEmbeddingsMode } from '../components/ai/playground/AiEmbeddingsMode';
import { AiTranscribeMode } from '../components/ai/playground/AiTranscribeMode';
import { AiSpeechMode } from '../components/ai/playground/AiSpeechMode';
import { AiVoiceMode } from '../components/ai/playground/AiVoiceMode';
import { usePlaygroundModel } from '../components/ai/playground/usePlaygroundModel';
import {
  AiChatAttachButtons,
  AiChatPendingAttachments,
  pendingAttachmentProblems,
  type PendingAttachment,
} from '../components/ai/AiChatAttachmentPicker';
import {
  attachmentKind,
  chatTurnInput,
  withAttachmentContext,
  type AiChatAttachment,
} from '../components/ai/playground/chatAttachments';
import { uploadStorageObjectAndWait } from '../services/storage';
import { toAiErrorInfo, type AiErrorInfo } from '../services/aiErrors';
import { AiErrorAlert } from '../components/ai/AiErrorAlert';
import {
  AiHostedToolControls,
  INITIAL_HOSTED_TOOL_SELECTION,
  buildHostedTools,
  offeredHostedTools,
  type HostedToolSelection,
} from '../components/ai/AiHostedToolControls';
import {
  AI_SCHEMA_PRESETS,
  CUSTOM_SCHEMA_ID,
  CUSTOM_SCHEMA_NAME,
  formatSchema,
  parseJsonSchemaText,
} from '../components/ai/aiSchemaPresets';

type ReasoningEffort = NonNullable<NonNullable<AiResponseRequest['reasoning']>['effort']>;
const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

interface PlaygroundControls {
  instructions: string;
  /** Blank = the provider's default. */
  maxOutputTokens: string;
  /** Blank = the provider's default. */
  temperature: string;
  /** '' = let the model decide. */
  reasoningEffort: ReasoningEffort | '';
  reasoningSummary: boolean;
  structured: boolean;
  schemaPreset: string;
  schemaText: string;
  /** Send as a background run (`POST /ai/runs`) instead of streaming. */
  background: boolean;
}

const INITIAL_CONTROLS: PlaygroundControls = {
  instructions: '',
  maxOutputTokens: '',
  temperature: '',
  reasoningEffort: '',
  reasoningSummary: true,
  structured: false,
  schemaPreset: AI_SCHEMA_PRESETS[0].id,
  schemaText: formatSchema(AI_SCHEMA_PRESETS[0].jsonSchema),
  background: false,
};

function useUsableModels() {
  const [models, setModels] = useState<UsableAiModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    void (async () => {
      try {
        const data = await listUsableAiModels();
        if (isMounted()) setModels(data);
      } catch (err) {
        if (isMounted()) {
          setError(err instanceof ApiError ? err.message : 'Failed to load available models');
        }
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    })();
  }, [isMounted]);

  return { models, isLoading, error };
}

/** An empty composer, or one still holding a preset's example, may be replaced by another example. */
function isUntouchedPrompt(prompt: string): boolean {
  return prompt.trim() === '' || AI_SCHEMA_PRESETS.some((preset) => preset.examplePrompt === prompt);
}

/** Parse an optional positive integer field; `undefined` when blank, `null` when invalid. */
function parseTokens(value: string, max?: number): number | undefined | null {
  if (value.trim() === '') return undefined;
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  if (n < 1 || (max !== undefined && n > max)) return null;
  return n;
}

/** Parse an optional temperature in [0, 2]; `undefined` when blank, `null` when invalid. */
function parseTemperature(value: string): number | undefined | null {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) return null;
  return n;
}

export default function AiPlaygroundPage() {
  const { hasPermission } = usePermissions();

  const { models, isLoading: modelsLoading, error: modelsError } = useUsableModels();
  const { settings, isLoading: settingsLoading } = useUserSettings({ syncTheme: false });
  const chat = useAiChat();
  const { config: aiConfig } = useAiConfig();
  const backgroundAllowed = aiConfig.allowBackgroundRuns !== false;
  // The prompt of the current background run, for its card and for the thread.
  const [runPrompt, setRunPrompt] = useState('');
  const runPromptRef = useRef('');
  const runAttachmentsRef = useRef<AiChatAttachment[]>([]);
  const { appendExchange } = chat;
  const run = useAiRun({
    onSettled: (settled) => {
      if (settled.status === 'succeeded' && isAiResponseRunOutput(settled.output)) {
        appendExchange(runPromptRef.current, settled.output, {
          runId: settled.id,
          attachments: runAttachmentsRef.current,
        });
      }
    },
  });
  // Files chosen for the next turn, uploaded when it is sent.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [attachError, setAttachError] = useState<AiErrorInfo | null>(null);

  const [controls, setControls] = useState<PlaygroundControls>(INITIAL_CONTROLS);
  const [prompt, setPrompt] = useState('');

  // Modes (#445): which are usable, and which is shown. A chosen mode that
  // stops being usable falls back to the first usable one.
  // Voice is hidden outright unless realtime sessions are allowed (#449).
  const allowRealtime = aiConfig.allowRealtime;
  const hiddenModes = useMemo(() => hiddenPlaygroundModes({ allowRealtime }), [allowRealtime]);
  const unavailable = useMemo(() => unavailableModes(models, hiddenModes), [models, hiddenModes]);
  const [chosenMode, setChosenMode] = useState<AiPlaygroundModeId | null>(null);
  const mode: AiPlaygroundModeId =
    chosenMode && !unavailable.has(chosenMode) ? chosenMode : initialPlaygroundMode(models, hiddenModes);
  const [visitedModes, setVisitedModes] = useState<ReadonlySet<AiPlaygroundModeId>>(() => new Set());
  const chooseMode = (next: AiPlaygroundModeId) => {
    setChosenMode(next);
    setVisitedModes((current) => new Set(current).add(mode).add(next));
  };

  // `user_settings.ai.defaultModel` (docs/specs/ai-platform.md §2.1), typed by
  // `UserSettings['ai']` (#430): every mode starts on it when it is listed there.
  const preferredModel: NonNullable<UserSettings['ai']>['defaultModel'] = settings?.ai?.defaultModel;
  const modelsReady = !modelsLoading && !settingsLoading;
  // Each mode's models, filtered by its capability alone (never by name).
  const modeModels = useMemo(
    () =>
      Object.fromEntries(AI_PLAYGROUND_MODES.map((entry) => [entry.id, modelsForMode(models, entry)])) as Record<
        AiPlaygroundModeId,
        UsableAiModel[]
      >,
    [models],
  );
  const chatModels = modeModels.chat;
  const { modelKey, setModelKey, selected } = usePlaygroundModel(chatModels, preferredModel, modelsReady);

  const supportsReasoning = hasAiCapability(selected, 'reasoning');
  const supportsStructured = hasAiCapability(selected, 'structured_output');
  const efforts = (selected?.capabilities.reasoningEfforts ?? REASONING_EFFORTS).filter(
    (effort): effort is ReasoningEffort => (REASONING_EFFORTS as string[]).includes(effort),
  );
  const structuredOn = supportsStructured && controls.structured;
  const schema = structuredOn ? parseJsonSchemaText(controls.schemaText) : null;
  const schemaName =
    AI_SCHEMA_PRESETS.find((preset) => preset.id === controls.schemaPreset)?.name ?? CUSTOM_SCHEMA_NAME;
  const maxTokensCap = selected?.capabilities.maxOutputTokens;
  const maxTokens = parseTokens(controls.maxOutputTokens, maxTokensCap);
  const temperature = parseTemperature(controls.temperature);

  const [hostedSelection, setHostedSelection] = useState<HostedToolSelection>(INITIAL_HOSTED_TOOL_SELECTION);
  const offeredTools = offeredHostedTools(selected, aiConfig.hostedTools);
  const hosted = buildHostedTools(hostedSelection, offeredTools);

  const controlsValid =
    hosted.error === null &&
    maxTokens !== null && (supportsReasoning || temperature !== null) && (schema === null || schema.ok);

  const update = <K extends keyof PlaygroundControls>(key: K, value: PlaygroundControls[K]) =>
    setControls((current) => ({ ...current, [key]: value }));

  // A stateless provider (#446) cannot continue by `previousResponseId`; the
  // turn resends the conversation instead. Unknown to the config: chain.
  const chainResponses =
    !selected ||
    aiConfig.providers.find((provider) => provider.id === selected.provider)?.supportsPreviousResponseId !== false;

  const buildOptions = useCallback((): AiChatRequestOptions | null => {
    if (!selected || !controlsValid) return null;
    const options: AiChatRequestOptions = {
      provider: selected.provider,
      model: selected.modelId,
      stream: hasAiCapability(selected, 'streaming'),
      chainResponses,
    };
    if (controls.instructions.trim()) options.instructions = controls.instructions.trim();
    if (typeof maxTokens === 'number') options.maxOutputTokens = maxTokens;
    // Reasoning models reject sampling temperature, so it is only sent to the others.
    if (!supportsReasoning && typeof temperature === 'number') options.temperature = temperature;
    if (supportsReasoning) {
      const effort = controls.reasoningEffort && efforts.includes(controls.reasoningEffort) ? controls.reasoningEffort : undefined;
      const summary = controls.reasoningSummary ? ('auto' as const) : undefined;
      if (effort || summary) options.reasoning = { ...(effort ? { effort } : {}), ...(summary ? { summary } : {}) };
    }
    if (schema?.ok) options.structuredOutput = { name: schemaName, jsonSchema: schema.schema, strict: true };
    if (hosted.tools.length > 0) options.tools = hosted.tools;
    return options;
  }, [selected, controlsValid, chainResponses, controls, maxTokens, supportsReasoning, temperature, efforts, schema, schemaName, hosted.tools]);

  const choosePreset = (id: string) => {
    const preset = AI_SCHEMA_PRESETS.find((entry) => entry.id === id);
    setControls((current) => ({
      ...current,
      schemaPreset: id,
      schemaText: preset ? formatSchema(preset.jsonSchema) : current.schemaText,
    }));
    if (preset && isUntouchedPrompt(prompt)) setPrompt(preset.examplePrompt);
  };

  const busy = chat.isStreaming || run.isActive || isUploading;
  const attachmentProblems = pendingAttachmentProblems(pendingAttachments, selected);
  const canSend =
    !!selected && controlsValid && prompt.trim() !== '' && !busy && attachmentProblems.length === 0;
  const useBackground = backgroundAllowed && controls.background;

  /** Upload the pending files; `null` (with the error shown) when any upload fails. */
  const uploadPending = async (): Promise<AiChatAttachment[] | null> => {
    if (pendingAttachments.length === 0) return [];
    setIsUploading(true);
    setAttachError(null);
    try {
      return await Promise.all(
        pendingAttachments.map(async ({ file }) => {
          const object = await uploadStorageObjectAndWait(file);
          return {
            storageObjectId: object.id,
            name: file.name,
            mimeType: file.type || object.mimeType,
            size: file.size,
            kind: attachmentKind(file.type || object.mimeType),
          };
        }),
      );
    } catch (err) {
      setAttachError(toAiErrorInfo(err, 'Could not upload the attachments'));
      return null;
    } finally {
      setIsUploading(false);
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const options = buildOptions();
    if (!canSend || !options) return;
    const text = prompt.trim();
    // The prompt and the chips stay put until the files are safely uploaded.
    const attachments = await uploadPending();
    if (attachments === null) return;
    setPrompt('');
    setPendingAttachments([]);
    if (useBackground) {
      // A run is not streamed; it answers once, through polling.
      const { stream: _unused, chainResponses: chain, ...request } = options;
      runPromptRef.current = text;
      runAttachmentsRef.current = attachments;
      setRunPrompt(text);
      void run.start(
        chain === false
          ? { ...request, input: chat.historyInput(text, attachments) }
          : {
              ...request,
              input: chatTurnInput(text, attachments),
              ...(chat.previousResponseId ? { previousResponseId: chat.previousResponseId } : {}),
            },
      );
      return;
    }
    void chat.send(text, options, attachments);
  };

  const startNewConversation = () => {
    chat.reset();
    if (!run.isActive) {
      run.clear();
      setRunPrompt('');
    }
  };

  const onPromptKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  if (!hasPermission('ai:use')) {
    return <Navigate to="/" replace />;
  }

  const settingsContent = selected && (
    <Stack spacing={2}>
      <AiModelSelect
        models={chatModels}
        value={modelKey}
        onChange={setModelKey}
        disabled={busy}
      />
      <TextField
        label="Instructions"
        placeholder="Optional system instructions"
        size="small"
        multiline
        minRows={2}
        maxRows={6}
        value={controls.instructions}
        onChange={(event) => update('instructions', event.target.value)}
      />
      <TextField
        label="Max output tokens"
        size="small"
        value={controls.maxOutputTokens}
        onChange={(event) => update('maxOutputTokens', event.target.value)}
        error={maxTokens === null}
        helperText={
          maxTokens === null
            ? `Enter a whole number${maxTokensCap ? ` from 1 to ${maxTokensCap}` : ' of at least 1'}`
            : 'Blank uses the provider default'
        }
        slotProps={{ htmlInput: { inputMode: 'numeric' } }}
      />
      {!supportsReasoning && (
        <TextField
          label="Temperature"
          size="small"
          value={controls.temperature}
          onChange={(event) => update('temperature', event.target.value)}
          error={temperature === null}
          helperText={temperature === null ? 'Enter a number from 0 to 2' : 'Blank uses the provider default'}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
      )}
      {supportsReasoning && (
        <>
          <TextField
            select
            label="Reasoning effort"
            size="small"
            value={controls.reasoningEffort}
            onChange={(event) => update('reasoningEffort', event.target.value as ReasoningEffort | '')}
          >
            <MenuItem value="">Model default</MenuItem>
            {efforts.map((effort) => (
              <MenuItem key={effort} value={effort}>
                {effort.charAt(0).toUpperCase() + effort.slice(1)}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={controls.reasoningSummary}
                onChange={(event) => update('reasoningSummary', event.target.checked)}
              />
            }
            label="Show reasoning summary"
          />
        </>
      )}
      {supportsStructured && (
        <>
          <FormControlLabel
            control={
              <Switch
                checked={controls.structured}
                onChange={(event) => {
                  update('structured', event.target.checked);
                  if (event.target.checked) choosePreset(controls.schemaPreset);
                }}
              />
            }
            label="Structured output"
          />
          {controls.structured && (
            <>
              <TextField
                select
                label="Schema"
                size="small"
                value={controls.schemaPreset}
                onChange={(event) => choosePreset(event.target.value)}
              >
                {AI_SCHEMA_PRESETS.map((preset) => (
                  <MenuItem key={preset.id} value={preset.id}>
                    {preset.label}
                  </MenuItem>
                ))}
                <MenuItem value={CUSTOM_SCHEMA_ID}>Custom JSON Schema</MenuItem>
              </TextField>
              <TextField
                label="JSON Schema"
                multiline
                minRows={6}
                maxRows={16}
                value={controls.schemaText}
                onChange={(event) =>
                  setControls((current) => ({
                    ...current,
                    schemaText: event.target.value,
                    schemaPreset: CUSTOM_SCHEMA_ID,
                  }))
                }
                error={schema !== null && !schema.ok}
                helperText={schema !== null && !schema.ok ? schema.error : 'Sent with strict: true'}
                slotProps={{
                  htmlInput: { spellCheck: false, style: { fontFamily: 'monospace', fontSize: '0.8125rem' } },
                }}
              />
            </>
          )}
        </>
      )}
      <AiHostedToolControls
        offered={offeredTools}
        value={hostedSelection}
        onChange={setHostedSelection}
        error={hosted.error}
      />
      {backgroundAllowed && (
        <FormControlLabel
          control={
            <Switch
              checked={controls.background}
              onChange={(event) => update('background', event.target.checked)}
            />
          }
          label="Run in background"
        />
      )}
    </Stack>
  );

  const modelsLoaded = !modelsLoading && !modelsError;
  const noModels = modelsLoaded && models.length === 0;
  const noUsableMode = modelsLoaded && models.length > 0 && unavailable.size === AI_PLAYGROUND_MODES.length;

  const chatPanel = selected && (
    <AiPlaygroundPanels settings={settingsContent} label="Chat">
      {chat.messages.length === 0 && !runPrompt ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          Send a message to start a conversation.
        </Typography>
      ) : (
        <AiChatThread messages={chat.messages} />
      )}

      {runPrompt && (run.isActive || run.run || run.error) && (
        <AiRunCard
          prompt={runPrompt}
          run={run.run}
          error={run.error && withAttachmentContext(run.error, runAttachmentsRef.current.length > 0)}
          stale={run.stale}
          isStarting={run.isStarting}
          isCancelling={run.isCancelling}
          onCancel={() => void run.cancel()}
          onDismiss={() => {
            run.clear();
            setRunPrompt('');
          }}
        />
      )}

      <Divider />

      <Box
        component="form"
        onSubmit={(event) => void submit(event)}
        sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        {attachError && <AiErrorAlert error={attachError} onClose={() => setAttachError(null)} />}
        <AiChatPendingAttachments
          model={selected}
          pending={pendingAttachments}
          disabled={isUploading}
          onRemove={(key) => setPendingAttachments((current) => current.filter((item) => item.key !== key))}
        />
        <TextField
          label="Message"
          placeholder="Ask something…"
          multiline
          minRows={2}
          maxRows={8}
          fullWidth
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onPromptKeyDown}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <AiChatAttachButtons
            model={selected}
            disabled={busy}
            onAdd={(items) => setPendingAttachments((current) => [...current, ...items])}
          />
          <Box sx={{ flex: 1 }} />
          {isUploading && (
            <Typography variant="body2" color="text.secondary" role="status">
              Uploading attachments…
            </Typography>
          )}
          {chat.isStreaming ? (
            <Button variant="outlined" color="inherit" startIcon={<StopIcon />} onClick={chat.stop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="contained" endIcon={<SendIcon />} disabled={!canSend}>
              {useBackground ? 'Start run' : 'Send'}
            </Button>
          )}
        </Box>
      </Box>
    </AiPlaygroundPanels>
  );

  /** A non-chat mode's panel. Chat's state lives on this page, so its panel is rendered inline. */
  const renderModePanel = (entry: AiPlaygroundMode): ReactNode => {
    switch (entry.id) {
      case 'chat':
        return null;
      case 'image':
        return <AiImageMode models={modeModels.image} preferredModel={preferredModel} ready={modelsReady} />;
      case 'embeddings':
        return <AiEmbeddingsMode models={modeModels.embeddings} preferredModel={preferredModel} ready={modelsReady} />;
      case 'transcribe':
        return (
          <AiTranscribeMode models={modeModels.transcribe} preferredModel={preferredModel} ready={modelsReady} />
        );
      case 'speech':
        return <AiSpeechMode models={modeModels.speech} preferredModel={preferredModel} ready={modelsReady} />;
      case 'voice':
        return <AiVoiceMode models={modeModels.voice} preferredModel={preferredModel} ready={modelsReady} />;
      // A mode added to AI_PLAYGROUND_MODES before its panel exists.
      default:
        return <AiModePlaceholder mode={entry} />;
    }
  };

  const showModes = modelsLoaded && models.length > 0 && !noUsableMode;

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 2, md: 3 }, px: { xs: 2, sm: 3 } }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1,
          mb: 2,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4" component="h1">
            AI Playground
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Try prompts against the models available to you.
          </Typography>
        </Box>
        {mode === 'chat' && showModes && (
          <Button
            startIcon={<AddIcon />}
            onClick={startNewConversation}
            disabled={chat.messages.length === 0 || run.isActive}
          >
            New conversation
          </Button>
        )}
      </Box>

      {modelsLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress aria-label="Loading models" />
        </Box>
      )}

      {modelsError && <Alert severity="error">{modelsError}</Alert>}

      {(noModels || noUsableMode) && (
        <Alert
          severity="info"
          action={
            <Button component={RouterLink} to={AI_KEYS_PATH} color="inherit" size="small">
              Manage API keys
            </Button>
          }
        >
          {noModels
            ? 'No models are available to you yet. Add an API key for an enabled provider to start using the playground.'
            : 'None of the models available to you can be used in the playground. Add an API key that can reach a text model.'}
        </Alert>
      )}

      {showModes && (
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          <AiPlaygroundModeSelector
            value={mode}
            onChange={chooseMode}
            unavailable={unavailable}
            hidden={hiddenModes}
          />

          {mode === 'chat' && chatPanel}

          {AI_PLAYGROUND_MODES.filter(
            // A hidden mode is unmounted, so a voice call ends when realtime is switched off.
            (entry) =>
              entry.id !== 'chat' &&
              !hiddenModes.has(entry.id) &&
              (entry.id === mode || visitedModes.has(entry.id)),
          ).map((entry) => (
            // Kept mounted once visited: its inputs and any run it is polling survive a mode switch.
            <Box key={entry.id} hidden={entry.id !== mode} data-testid={`playground-mode-${entry.id}`}>
              {renderModePanel(entry)}
            </Box>
          ))}
        </Stack>
      )}
    </Container>
  );
}
