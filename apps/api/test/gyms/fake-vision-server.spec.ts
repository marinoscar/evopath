// =============================================================================
// The fake vision server (E3.4) through the REAL OpenAI-compatible adapter
// =============================================================================
//
// `tests/e2e/support/fake-vision-server.mjs` is what owner testing and e2e run
// behind `infra/compose/fake-ai.compose.yml`. This suite starts it as a child
// process on an ephemeral port and drives it with the production
// `OpenAiCompatibleProviderAdapter` in `chat_completions` style, keyless, with
// the photo delivered inline (the adapter's own strategy): the model list, the
// fixture selection, the control routes, and that the adapter parses the
// fixture into exactly the scan schema's output.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { AI_KEYLESS_API_KEY, type AiCallContext } from '../../src/ai/core/provider-adapter.interface';
import { AiProviderRegistry } from '../../src/ai/core/provider-registry';
import { OpenAiCompatibleClientFactory } from '../../src/ai/providers/openai-compatible/openai-compatible-client.factory';
import { OpenAiCompatibleProviderAdapter } from '../../src/ai/providers/openai-compatible/openai-compatible.adapter';
import { buildScanContent } from '../../src/gyms/scan/equipment-scan.handler';
import { buildEquipmentScanOutputSchema } from '../../src/gyms/scan/equipment-scan.prompt';
import { buildPrefillContent } from '../../src/workouts/prefill/workout-prefill.handler';
import { buildWorkoutPrefillOutputSchema } from '../../src/workouts/prefill/workout-prefill.prompt';
import { numberedInputParts } from '../../src/intake/intake-analyzer';
import { BODY_METRIC_INSTRUCTIONS, bodyMetricOutputSchema } from '../../src/measurements/photo/body-metric-reading.prompt';
import { bodyMetricFixture } from '../fixtures/body-metric/load';
import { LAB_REPORT_INSTRUCTIONS, labReportOutputSchema } from '../../src/measurements/lab-report/lab-report.prompt';
import { mapLabReportOutput } from '../../src/measurements/lab-report/lab-report.mapper';
import { labReportFixture } from '../fixtures/lab-report/load';
import { loadModelOutput, seedVocabulary } from '../fixtures/gym-scan.fixtures';
import { loadPrefillModelOutput, seedExerciseVocabulary } from '../fixtures/workout-prefill.fixtures';

const SERVER = join(__dirname, '..', '..', '..', '..', 'tests', 'e2e', 'support', 'fake-vision-server.mjs');
const PHOTO = Buffer.from('fake-jpeg-bytes');

describe('fake vision server', () => {
  let child: ChildProcess;
  let base: string;
  const adapter = new OpenAiCompatibleProviderAdapter(new AiProviderRegistry(), new OpenAiCompatibleClientFactory());
  const schema = buildEquipmentScanOutputSchema(seedVocabulary());

  beforeAll(async () => {
    child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake vision server did not start')), 10_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        const match = /listening on :(\d+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on('exit', (code) => reject(new Error(`fake vision server exited with ${code}`)));
    });
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    child?.kill();
  });

  beforeEach(async () => {
    await fetch(`${base}/__control/reset`, { method: 'POST' });
  });

  function ctx(photoIds: string[]): AiCallContext {
    return {
      apiKey: AI_KEYLESS_API_KEY,
      baseUrl: `${base}/v1`,
      requestId: 'req-fake-vision',
      providerSettings: { apiStyle: 'chat_completions', requiresKey: false },
      storageInputs: new Map(
        photoIds.map((storageObjectId) => [
          storageObjectId,
          {
            storageObjectId,
            modality: 'image' as const,
            mimeType: 'image/jpeg',
            filename: `${storageObjectId}.jpg`,
            strategy: 'inline' as const,
            read: async () => ({ data: new Uint8Array(PHOTO), mimeType: 'image/jpeg' }),
          },
        ]),
      ),
    };
  }

  async function scan(photoIds: string[]) {
    return adapter.responses.create(
      {
        model: 'fake-vision',
        instructions: 'test',
        input: [{ type: 'message', role: 'user', content: buildScanContent(photoIds) }],
        structuredOutput: { name: 'gym_equipment_scan', schema, strict: true },
      },
      ctx(photoIds),
    );
  }

  it('lists fake-vision first, then the adaptation roles', async () => {
    const models = await adapter.listModels(ctx([]));
    expect(models.map((model) => model.id)).toEqual(['fake-vision', 'fake-planner', 'fake-critic', 'fake-text-only']);
  });

  it('answers one image with cardio-row-wide and two with both, parsed by the real adapter', async () => {
    const one = await scan(['p0']);
    expect(one.parsed).toEqual(loadModelOutput('cardio-row-wide'));
    expect(one.finishReason).toBe('stop');
    expect(one.usage.inputTokens).toBeGreaterThan(0);

    const two = await scan(['p0', 'p1']);
    expect(two.parsed).toEqual(loadModelOutput('both'));

    const requests = await (await fetch(`${base}/__control/requests`)).json();
    expect(requests).toEqual([
      { model: 'fake-vision', imageCount: 1, fileCount: 0, hasResponseFormat: true },
      { model: 'fake-vision', imageCount: 2, fileCount: 0, hasResponseFormat: true },
    ]);
  });

  it('a queued fixture answers the next request only', async () => {
    const queued = await fetch(`${base}/__control/next`, {
      method: 'POST',
      body: JSON.stringify({ fixture: 'leg-curl-placard' }),
    });
    expect(queued.status).toBe(200);

    expect((await scan(['p0'])).parsed).toEqual(loadModelOutput('leg-curl-placard'));
    expect((await scan(['p0'])).parsed).toEqual(loadModelOutput('cardio-row-wide'));
  });

  it.each([
    ['workout-placard', 'placard'],
    ['workout-notebook', 'notebook'],
    ['workout-empty', 'workout-empty'],
  ] as const)('serves %s from workout-prefill/, parsed by the real adapter into the prefill schema', async (fixture, file) => {
    const prefillSchema = buildWorkoutPrefillOutputSchema(seedExerciseVocabulary());
    await fetch(`${base}/__control/next`, { method: 'POST', body: JSON.stringify({ fixture }) });

    const response = await adapter.responses.create(
      {
        model: 'fake-vision',
        instructions: 'test',
        input: [{ type: 'message', role: 'user', content: buildPrefillContent(['p0'], 'notebook') }],
        structuredOutput: { name: 'workout_prefill', schema: prefillSchema, strict: true },
      },
      ctx(['p0']),
    );

    expect(response.parsed).toEqual(loadPrefillModelOutput(file));
    expect(prefillSchema.safeParse(response.parsed).success).toBe(true);
  });

  describe('body-metric readings, a PDF included (H2, #186)', () => {
    const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n', 'latin1');

    function bodyMetricCtx(inputs: Array<{ id: string; pdf: boolean }>): AiCallContext {
      return {
        ...ctx([]),
        storageInputs: new Map(
          inputs.map(({ id, pdf }) => [
            id,
            {
              storageObjectId: id,
              modality: pdf ? ('file' as const) : ('image' as const),
              mimeType: pdf ? 'application/pdf' : 'image/jpeg',
              filename: pdf ? `${id}.pdf` : `${id}.jpg`,
              strategy: 'inline' as const,
              read: async () => ({
                data: new Uint8Array(pdf ? PDF : PHOTO),
                mimeType: pdf ? 'application/pdf' : 'image/jpeg',
              }),
            },
          ]),
        ),
      };
    }

    async function read(inputs: Array<{ id: string; pdf: boolean }>) {
      return adapter.responses.create(
        {
          model: 'fake-vision',
          instructions: BODY_METRIC_INSTRUCTIONS,
          input: [
            {
              type: 'message',
              role: 'user',
              content: numberedInputParts(
                inputs.map(({ id, pdf }) => ({ storageObjectId: id, mimeType: pdf ? 'application/pdf' : 'image/jpeg' })),
                1,
              ),
            },
          ],
          structuredOutput: { name: 'body_metric_reading', schema: bodyMetricOutputSchema, strict: true },
        },
        bodyMetricCtx(inputs),
      );
    }

    it('answers a PDF with the smart-scale report and a photo with the scale display, parsed by the real adapter', async () => {
      const pdf = await read([{ id: 'd0', pdf: true }]);
      expect(pdf.parsed).toEqual(bodyMetricFixture('smart-scale-report'));

      const photo = await read([{ id: 'p0', pdf: false }]);
      expect(photo.parsed).toEqual(bodyMetricFixture('scale-display'));

      const requests = await (await fetch(`${base}/__control/requests`)).json();
      expect(requests).toEqual([
        { model: 'fake-vision', imageCount: 0, fileCount: 1, hasResponseFormat: true },
        { model: 'fake-vision', imageCount: 1, fileCount: 0, hasResponseFormat: true },
      ]);
      // The request log never carries bytes or file names.
      expect(JSON.stringify(requests)).not.toMatch(/PDF-|d0\.pdf/);
    });
  });

  describe('lab reports (H4, #188)', () => {
    it('answers a lab_report request with the panel fixture, parsed by the real adapter and schema', async () => {
      const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n', 'latin1');
      const response = await adapter.responses.create(
        {
          model: 'fake-vision',
          instructions: LAB_REPORT_INSTRUCTIONS,
          input: [
            {
              type: 'message',
              role: 'user',
              content: numberedInputParts([{ storageObjectId: 'r0', mimeType: 'application/pdf' }], 1),
            },
          ],
          structuredOutput: { name: 'lab_report', schema: labReportOutputSchema, strict: true },
        },
        {
          ...ctx([]),
          storageInputs: new Map([
            [
              'r0',
              {
                storageObjectId: 'r0',
                modality: 'file' as const,
                mimeType: 'application/pdf',
                filename: 'r0.pdf',
                strategy: 'inline' as const,
                read: async () => ({ data: new Uint8Array(PDF), mimeType: 'application/pdf' }),
              },
            ],
          ]),
        },
      );

      expect(response.parsed).toEqual(labReportFixture('lipid-glucose-panel'));
      const mapped = mapLabReportOutput(labReportOutputSchema.parse(response.parsed), ['r0']);
      expect(mapped.resultMeta).toMatchObject({ unmatched: 1, converted: 1 });

      const requests = await (await fetch(`${base}/__control/requests`)).json();
      expect(requests).toEqual([{ model: 'fake-vision', imageCount: 0, fileCount: 1, hasResponseFormat: true }]);
    });
  });

  it('refuses an unknown fixture name', async () => {
    const res = await fetch(`${base}/__control/next`, { method: 'POST', body: JSON.stringify({ fixture: 'nope' }) });
    expect(res.status).toBe(400);
  });
});
