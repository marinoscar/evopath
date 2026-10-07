import type { SchemeTokens } from './tokens';
// The telemetry UI's theme-token contract (`palette.status`,
// `palette.chart.series`) and its MUI augmentation ship with the telemetry
// slice; this type-only import brings the augmentation with it.
import type { TelemetryStatusTokens } from '@marinoscar/platform-web/telemetry/headless';

/**
 * `palette.status` of the telemetry token contract
 * (`@marinoscar/platform-web/telemetry`, marinoscar/EnterpriseAppBase#719),
 * mapped onto this app's own tokens: the four status colours of `tokens.ts`,
 * and `outline` as the neutral ("other" log records), which is what the
 * app's own copy of the log-severity chart painted them with. The other half
 * of the contract, `palette.chart.series`, is already this app's
 * `chart.series` (`light.ts`, `dark.ts`): the same name and shape, so the two
 * augmentations merge.
 *
 * The tokens are set per colour scheme, in the `createTheme` options (the
 * contract's documented override). `withTelemetryTokens(theme)` is not used:
 * on a CSS-variables theme it would complete only the top-level (default
 * scheme) palette, while `ThemeProvider` swaps in each scheme's own palette.
 */
export function telemetryStatusTokens(t: SchemeTokens): TelemetryStatusTokens {
  return { ok: t.success, warn: t.warning, crit: t.error, info: t.info, neutral: t.outline };
}
