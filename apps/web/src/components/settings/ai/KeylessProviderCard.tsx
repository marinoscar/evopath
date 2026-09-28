/**
 * One KEYLESS provider on `/settings/ai` — issue #448, epic #421.
 *
 * An administrator can mark an OpenAI-compatible server (a local Ollama, an
 * internal vLLM) as needing no key (`requiresKey: false` on the public AI
 * config). Its calls carry no credential and are recorded with
 * `keySource: 'none'`, so there is nothing for a user to add, test or remove:
 * this card says so instead of offering the key field `UserAiKeyCard` does.
 */
import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material';

/** What every surface says about a keyless provider. */
export const KEYLESS_PROVIDER_TEXT = 'No key needed — this server is keyless';

export interface KeylessProviderCardProps {
  provider: { id: string; displayName: string };
}

export function KeylessProviderCard({ provider }: KeylessProviderCardProps) {
  return (
    <Card component="section" aria-label={`${provider.displayName} key`}>
      <CardContent>
        <Stack spacing={1}>
          <Box>
            <Typography variant="h6" component="h2" gutterBottom>
              {provider.displayName}
            </Typography>
            <Chip size="small" label="No key needed" />
          </Box>
          <Typography variant="body2" color="text.secondary">
            {KEYLESS_PROVIDER_TEXT}. Your administrator runs it without an API key, so you can use
            its enabled models without adding one of your own.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
