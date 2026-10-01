/**
 * "Get the Android app" (#283): the release link and the four setup steps.
 * The page's empty state. With a release published on this server (#287) the
 * button goes to the Android app page, which serves it; without one it falls
 * back to the GitHub release, built from the repository slug in
 * `packages/shared/identity.json` so a renamed fork links to its own APK.
 */
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Card, CardContent, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import { REPO_SLUG } from '@app/shared';
import { ANDROID_APP_SETTINGS_PATH, androidReleaseUrl, type Release } from '../../../services/healthSync';
import { ANDROID_RELEASE_APK_ASSET } from '../../../utils/androidIdentity';

export const ANDROID_SETUP_STEPS = [
  `Install the APK: download ${ANDROID_RELEASE_APK_ASSET} from the release on your phone and allow installing it.`,
  'Open the app and enter this server’s address.',
  'Open Health sync (from the app menu, or long-press the app icon).',
  'Tap Connect, then approve the phone on the activation page that opens.',
] as const;

/** Step one when this server hosts the APK (#287). */
export const SERVER_INSTALL_STEP =
  'Install the APK: download it from the Android app page on your phone and allow installing it.';

interface GetAndroidAppProps {
  /** The release this server hosts, or `null`/absent to fall back to GitHub. */
  release?: Pick<Release, 'versionName'> | null;
}

export function GetAndroidApp({ release = null }: GetAndroidAppProps) {
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
        {release ? (
          <Button
            variant="contained"
            component={RouterLink}
            to={ANDROID_APP_SETTINGS_PATH}
            startIcon={<PhoneAndroidIcon />}
            sx={{ mb: 2 }}
          >
            Get the Android app
          </Button>
        ) : (
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
        )}
        <Box component="ol" sx={{ m: 0, pl: 3 }} aria-label="Setup steps">
          {(release ? [SERVER_INSTALL_STEP, ...ANDROID_SETUP_STEPS.slice(1)] : ANDROID_SETUP_STEPS).map((step, index) => (
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
