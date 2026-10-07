import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { AiConfigService, providerPolicy } from '../../config/ai-config.service';
import { AI_SETTINGS_PATH } from '../../config/doctor/ai-enabled.doctor-check';
import { AiProviderRegistry } from '../../core/provider-registry';
import { AiAssignmentsAdminService } from '../ai-assignments-admin.service';
import { AI_ASSIGNMENT_ISSUES } from '../dto/ai-assignments.dto';
import { AI_ASSIGNMENTS_SETTINGS_PATH } from './ai-feature-assignments.doctor-check';
import { type AssignmentsView, effectiveAssignment, truncatedList } from './effective-assignment';

export interface WebSearchFacts {
  /** `ai.hostedTools.web_search`. */
  webSearchEnabled: boolean;
  /** Enabled providers whose adapter drives hosted tools (`AiProviderRegistry.supports(id, 'hosted_tools')`). */
  hostedToolProviders: readonly string[];
  /** The admin assignments view; not read (`null`) while web search is off. */
  view: AssignmentsView | null;
}

const REMEDY =
  `Enable OpenAI and a model with hosted tools at ${AI_SETTINGS_PATH} and assign it to the researcher at ` +
  `${AI_ASSIGNMENTS_SETTINGS_PATH}, or switch Web search off at ${AI_SETTINGS_PATH}.`;

/**
 * Pure: when web search is on, can the features that use it (the training
 * researcher) actually search?
 *
 *   - off → `skip`: an operator's choice (docs/runbooks/ai-training-plans.md
 *     §2 — it is off on a fresh deployment for egress and cost reasons);
 *   - on, but no enabled provider's adapter drives hosted tools (OpenAI does;
 *     Azure OpenAI, Gemini and Anthropic map none) → `warn`;
 *   - on, but a web-search feature has no eligible model (its needs include
 *     `hosted_tools` and its provider restriction) → `warn`;
 *   - on, and the stored assignment cannot search (incapable) → `warn`: calls
 *     fall through to another model, not the one the administrator chose.
 */
export function decideWebSearch(facts: WebSearchFacts): DoctorCheckOutcome {
  if (!facts.webSearchEnabled || !facts.view) {
    return { status: 'skip', detail: 'Web search is off', data: { webSearch: false } };
  }

  const view = facts.view;
  const rows = view.features.filter((row) => row.requiresWebSearch);
  const data = {
    webSearch: true,
    features: rows.length,
    hostedToolProviders: facts.hostedToolProviders.length,
  };

  if (rows.length === 0) {
    return { status: 'pass', detail: 'Web search is on; no feature uses it', data };
  }

  if (facts.hostedToolProviders.length === 0) {
    return {
      status: 'warn',
      detail: 'Web search is on, but no enabled provider supports hosted web search (OpenAI does)',
      remedy: REMEDY,
      data,
    };
  }

  const problems: string[] = [];
  const served: string[] = [];

  for (const row of rows) {
    const effective = effectiveAssignment(row, view);
    const restriction = row.providers ? ` (${row.providers.join('/')})` : '';

    if (!effective) {
      problems.push(`${row.label}: no enabled model${restriction} with hosted tools`);
      continue;
    }

    if (row.warning?.code === AI_ASSIGNMENT_ISSUES.MODEL_INCAPABLE && row.assignment) {
      problems.push(`${row.label}: assigned ${row.assignment.provider}/${row.assignment.modelId} cannot search`);
      continue;
    }

    served.push(
      effective.model
        ? `${row.label} on ${effective.model.provider}/${effective.model.modelId}`
        : `${row.label} auto-picks among ${truncatedList(effective.providers)}`,
    );
  }

  if (problems.length > 0) {
    return { status: 'warn', detail: `Web search is on, but ${problems.join('; ')}`, remedy: REMEDY, data };
  }

  return { status: 'pass', detail: `Web search is on: ${served.join('; ')}`, data };
}

/**
 * `ai` / `ai.web-search` — the hosted web-search switch and the models that
 * would use it agree. Reads the AI policy, the adapters' declared ports and
 * the admin assignments view; calls no model and runs no search.
 */
@Injectable()
export class AiWebSearchDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'ai.web-search';
  readonly category = 'ai';
  readonly label = 'Web search tool';
  readonly settingsPath = AI_SETTINGS_PATH;
  readonly dependsOn = ['ai.enabled'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly aiConfig: AiConfigService,
    private readonly providers: AiProviderRegistry,
    private readonly assignments: AiAssignmentsAdminService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const policy = await this.aiConfig.resolve({ fresh: true });

    if (!policy.hostedTools.web_search) {
      return decideWebSearch({ webSearchEnabled: false, hostedToolProviders: [], view: null });
    }

    const hostedToolProviders = this.providers
      .ids()
      .filter((id) => providerPolicy(policy, id)?.enabled && this.providers.supports(id, 'hosted_tools'));

    return decideWebSearch({
      webSearchEnabled: true,
      hostedToolProviders,
      view: await this.assignments.describe(),
    });
  }
}
