/**
 * The models the caller can use right now, grouped by provider — issue #430.
 *
 * Each row: display name (falling back to the id), the model id, and its
 * capability chips; "via organization key" marks a model the caller reaches
 * only through the organisation's key (`keySource: 'org'`).
 *
 * The chips are the shared `components/ai/AiCapabilityChips` (#429 dedupe).
 */
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItem,
  Stack,
  Typography,
} from '@mui/material';
import type { UsableAiModel } from '../../../services/ai';
import { AiCapabilityChips } from '../../ai/AiCapabilityChips';

export interface UsableAiModelsListProps {
  models: UsableAiModel[];
  isLoading: boolean;
  error: string | null;
  /** Provider id → display name, for the group headings. */
  providerNames: Record<string, string>;
}

export function UsableAiModelsList({ models, isLoading, error, providerNames }: UsableAiModelsListProps) {
  const groups = new Map<string, UsableAiModel[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }

  return (
    <Card component="section" aria-labelledby="usable-ai-models-title">
      <CardContent>
        <Typography id="usable-ai-models-title" variant="h6" component="h2" gutterBottom>
          Models you can use
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Models your administrator has enabled that your key (or your organization&apos;s) can
          reach.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={24} aria-label="Loading models" />
          </Box>
        ) : models.length === 0 ? (
          !error && (
            <Typography variant="body2" color="text.secondary">
              No models are available yet. Add a key above to see the models it can reach.
            </Typography>
          )
        ) : (
          <Stack spacing={2} divider={<Divider flexItem />}>
            {[...groups.entries()].map(([provider, list]) => (
              <Box
                key={provider}
                component="section"
                aria-label={`${providerNames[provider] ?? provider} models`}
              >
                <Typography variant="subtitle1" component="h3">
                  {providerNames[provider] ?? provider}
                </Typography>
                <List dense disablePadding>
                  {list.map((model) => (
                    <ListItem
                      key={`${model.provider}:${model.modelId}`}
                      disableGutters
                      sx={{ display: 'block', py: 1 }}
                    >
                      <Stack
                        sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
                        direction="row"
                        spacing={1}
                        useFlexGap
                      >
                        <Typography variant="body1">{model.displayName ?? model.modelId}</Typography>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                        >
                          {model.modelId}
                        </Typography>
                        {model.keySource === 'org' && (
                          <Chip size="small" color="info" label="via organization key" />
                        )}
                        {model.keySource === 'none' && (
                          <Chip size="small" label="no key needed" />
                        )}
                      </Stack>
                      <Box sx={{ mt: 0.5 }}>
                        <AiCapabilityChips capabilities={model.capabilities.capabilities} />
                      </Box>
                    </ListItem>
                  ))}
                </List>
              </Box>
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
