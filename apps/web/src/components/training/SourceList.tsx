/**
 * The researcher's verified sources as they arrive, the queries it ran, and
 * how many claims and sources were dropped. Once the brief arrives its
 * `basis` says how the plan is grounded: with no verified source
 * (`model_knowledge`) an info note replaces the empty list; with some
 * (`web_partial`) a short note follows the list. Links open in a new tab with
 * `rel="noopener noreferrer"`; no third-party icon is fetched. Capped with
 * "Show more" so a long stream never renders an unbounded list.
 */
import { useState } from 'react';
import { Alert, Box, Button, Chip, Link, List, ListItem, Stack, Typography } from '@mui/material';
import { Verified as VerifiedIcon } from '@mui/icons-material';
import type { RunSource, RunViewState } from '../../utils/reduceRunEvents';

export const SOURCE_KIND_LABEL: Record<string, string> = {
  guideline: 'Guideline',
  position_stand: 'Position stand',
  systematic_review: 'Systematic review',
  meta_analysis: 'Meta-analysis',
  rct: 'Trial',
  expert_article: 'Expert article',
  other: 'Other',
};

const INITIAL = 8;

/** Shown when research finished without a single verified web source. */
export const MODEL_KNOWLEDGE_NOTE =
  'No web sources could be verified for this plan, so it was built from established training principles.';
/** Shown when only part of the guidance is backed by a verified source. */
export const WEB_PARTIAL_NOTE = 'Some guidance comes from established training principles rather than a verified source.';

export interface SourceListProps {
  sources: RunSource[];
  queries?: string[];
  brief?: RunViewState['brief'];
}

export function SourceList({ sources, queries = [], brief = null }: SourceListProps) {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, INITIAL);
  return (
    <Box>
      {sources.length === 0 && brief?.basis === 'model_knowledge' ? (
        <Alert severity="info" data-testid="research-basis-note">
          {MODEL_KNOWLEDGE_NOTE}
        </Alert>
      ) : sources.length === 0 ? (
        <Typography color="text.secondary">No sources yet.</Typography>
      ) : (
        <List dense disablePadding aria-label="Sources">
          {shown.map((source) => (
            <ListItem key={source.id} disableGutters sx={{ display: 'block', py: 0.75 }} data-testid="source-row">
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <VerifiedIcon fontSize="small" color="success" titleAccess="Verified" />
                <Box sx={{ minWidth: 0 }}>
                  <Link href={source.url} target="_blank" rel="noopener noreferrer" sx={{ overflowWrap: 'anywhere' }}>
                    {source.title || source.domain}
                  </Link>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {source.domain}
                    </Typography>
                    <Chip size="small" label={SOURCE_KIND_LABEL[source.kind] ?? source.kind} />
                  </Stack>
                </Box>
              </Stack>
            </ListItem>
          ))}
        </List>
      )}
      {sources.length > INITIAL && (
        <Button size="small" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show ${sources.length - INITIAL} more`}
        </Button>
      )}
      {brief && sources.length > 0 && brief.basis !== 'web_verified' && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} data-testid="research-basis-note">
          {brief.basis === 'model_knowledge' ? MODEL_KNOWLEDGE_NOTE : WEB_PARTIAL_NOTE}
        </Typography>
      )}
      {queries.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="subtitle2" component="h3">
            Searches
          </Typography>
          <List dense disablePadding aria-label="Searches">
            {queries.map((query) => (
              <ListItem key={query} disableGutters sx={{ py: 0 }}>
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {query}
                </Typography>
              </ListItem>
            ))}
          </List>
        </Box>
      )}
      {brief && (brief.droppedSources > 0 || brief.droppedClaims > 0) && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {[
            brief.droppedSources > 0
              ? `${brief.droppedSources} source${brief.droppedSources === 1 ? '' : 's'} could not be verified and ${brief.droppedSources === 1 ? 'was' : 'were'} removed`
              : null,
            brief.droppedClaims > 0
              ? `${brief.droppedClaims} claim${brief.droppedClaims === 1 ? '' : 's'} without a verified source ${brief.droppedClaims === 1 ? 'was' : 'were'} dropped`
              : null,
          ]
            .filter(Boolean)
            .join('; ')}
          .
        </Typography>
      )}
    </Box>
  );
}

export default SourceList;
