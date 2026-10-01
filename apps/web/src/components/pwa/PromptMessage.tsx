import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import { BrandMark } from '../common/BrandMark';

/**
 * The message row shared by the PWA snackbars (`InstallPrompt`,
 * `UpdatePrompt`): the app icon, then the text.
 *
 * Both prompts talk about THE APP as an installable object — "install it",
 * "a new version of it" — so they show the same plate mark the user will see
 * on their home screen, which makes the offer recognisable at a glance. The
 * mark is decorative (`aria-hidden`): the text names the app, and a snackbar
 * is announced as a live region, where an extra image label would only be
 * noise. The text sits in its own element so it stays one exact text node.
 */
export function PromptMessage({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.5 }}>
      <BrandMark size={24} variant="plate" aria-hidden style={{ flexShrink: 0 }} />
      <span>{children}</span>
    </Box>
  );
}
