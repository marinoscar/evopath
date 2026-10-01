/**
 * "Get the Android app" (#283): the release link and the four setup steps.
 * The page's empty state; the release URL is built from the repository slug
 * in `packages/shared/identity.json`, so a renamed fork links to its own APK.
 */
import { Box, Button, Card, CardContent, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { REPO_SLUG } from '@app/shared';
import { androidReleaseUrl } from '../../../services/healthSync';

export const ANDROID_SETUP_STEPS = [
  'Install the APK: download evopath-android.apk from the release on your phone and allow installing it.',
  'Open the app and enter this server’s address.',
  'Open Health sync (from the app menu, or long-press the app icon).',
  'Tap Connect, then approve the phone on the activation page that opens.',
] as const;

export function GetAndroidApp() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Card variant="outlined" data-testid="get-android-app">
      <CardContent>
        <Typography variant="h6" component="h2" gutterBottom>
          Connect your Android phone
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The Android app syncs your steps, walks and runs from Health Connect, so your activity goals fill in on
          their own.
        </Typography>
        <Button
          variant="contained"
          href={androidReleaseUrl(REPO_SLUG)}
          target="_blank"
          rel="noopener noreferrer"
          endIcon={<OpenInNewIcon />}
          sx={{ mb: 2 }}
        >
          Get the Android app
        </Button>
        <Box component="ol" sx={{ m: 0, pl: 3 }} aria-label="Setup steps">
          {ANDROID_SETUP_STEPS.map((step, index) => (
            <Typography component="li" variant="body2" key={step} sx={{ mb: 0.5 }}>
              {step}
              {index === 1 && origin && (
                <>
                  {' '}
                  <Box component="code" sx={{ overflowWrap: 'anywhere' }}>
                    {origin}
                  </Box>
                </>
              )}
            </Typography>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}
