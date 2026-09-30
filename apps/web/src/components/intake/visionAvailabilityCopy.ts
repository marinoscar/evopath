/**
 * What to tell a user when AI cannot read their photos, per
 * `useVisionAvailability` status (#173). Every sentence here must be TRUE for
 * the state it describes: who can fix it (`fix`) decides whether the user is
 * sent to their own keys or told an administrator has to act, and a failed
 * check is never reported as a missing key.
 *
 * Shared by `NoVisionModelNotice` (the full notice) and the Scan gym /
 * Prefill from photo buttons (a one-line reason).
 */
import type { UseVisionAvailabilityReturn, VisionAvailabilityStatus } from '../../hooks/useVisionAvailability';
import { AI_KEYS_PATH } from '../ai/AiErrorAlert';

/** Where an AI administrator assigns models (#173). */
export const AI_ASSIGNMENTS_PATH = '/admin/settings/ai/assignments';

export type NoVisionReason = Exclude<VisionAvailabilityStatus, 'ready'>;

export interface VisionNoticeCopy {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error';
  link: { label: string; to: string } | null;
  /** Offer "Try again" (the check itself failed). */
  retry: boolean;
}

const ADMIN_HAS_NOT_ASSIGNED = "Your administrator hasn't assigned an AI model that can read photos yet.";

type Availability = Pick<UseVisionAvailabilityReturn, 'status' | 'fix'>;

/**
 * The notice for a status. `canAssign` is whether the caller holds
 * `ai_config:write` (they can fix an administrator state themselves).
 */
export function visionNoticeCopy(reason: NoVisionReason, fix: Availability['fix'], canAssign: boolean): VisionNoticeCopy {
  const adminLink = canAssign ? { label: 'Assign a model', to: AI_ASSIGNMENTS_PATH } : null;
  switch (reason) {
    case 'loading':
      return {
        title: 'Checking AI availability',
        body: 'Checking whether AI can read your photos.',
        severity: 'info',
        link: null,
        retry: false,
      };
    case 'ai_disabled':
      return {
        title: 'AI is turned off for this app',
        body: 'You can still enter everything yourself.',
        severity: 'info',
        link: null,
        retry: false,
      };
    case 'no_key':
      return {
        title: 'Add your own AI key in Settings → AI Keys',
        body: 'No AI key is available to you yet. Add one to let AI read your photos, or enter everything yourself.',
        severity: 'info',
        link: { label: 'Open AI Keys', to: AI_KEYS_PATH },
        retry: false,
      };
    case 'no_models':
    case 'missing_capability':
      if (fix === 'keys') {
        return {
          title: 'None of the AI models your keys reach can read photos',
          body: 'Add a key for a provider with a model that reads photos, or enter everything yourself.',
          severity: 'warning',
          link: { label: 'Open AI Keys', to: AI_KEYS_PATH },
          retry: false,
        };
      }
      return {
        title: ADMIN_HAS_NOT_ASSIGNED,
        body: canAssign
          ? 'Enable a model that reads photos and assign it to this feature, or enter everything yourself.'
          : 'You can still enter everything yourself.',
        severity: 'warning',
        link: adminLink,
        retry: false,
      };
    case 'web_search_disabled':
      return {
        title: 'An administrator needs to turn on web search',
        body: 'You can still enter everything yourself.',
        severity: 'warning',
        link: null,
        retry: false,
      };
    case 'error':
    default:
      return {
        title: "Couldn't check AI availability",
        body: 'Try again, or enter everything yourself.',
        severity: 'error',
        link: null,
        retry: true,
      };
  }
}

/**
 * A one-line reason the AI path is not offered (a disabled button's caption),
 * or `null` when it is ready. `action` completes "… to <action>".
 */
export function visionShortReason({ status, fix }: Availability, action: string): string | null {
  switch (status) {
    case 'ready':
      return null;
    case 'loading':
      return 'Checking whether AI can read your photos…';
    case 'ai_disabled':
      return 'AI is turned off for this app.';
    case 'no_key':
      return `Add your own AI key in Settings → AI Keys to ${action}.`;
    case 'no_models':
    case 'missing_capability':
      return fix === 'keys'
        ? `None of the AI models your keys reach can read photos. Add a key for one to ${action}.`
        : ADMIN_HAS_NOT_ASSIGNED;
    case 'web_search_disabled':
      return 'An administrator needs to turn on web search.';
    case 'error':
    default:
      return "Couldn't check AI availability.";
  }
}
