/**
 * The coach persona gallery (E7.3, #243; docs/specs/ai-coach.md §2.3).
 *
 * One card per persona from `GET /api/coach/personas`: avatar, name, tagline,
 * vibe, the intensity labels, and the static sample lines per moment (a
 * preview that calls no model). The persona the user has SAVED is marked
 * "Active"; the one chosen on the page (not yet saved) is "Selected".
 *
 * Sample lines are shown at `level` (the intensity on the page). Whether
 * Sarge's level-3 lines are uncensored is the server's answer: a card with
 * `censored: true` carries the clean level-2 lines in their place, and the
 * gallery says why, from `register.reason`. Every line renders as text.
 */
import { useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Collapse,
  Stack,
  Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import {
  COACH_MOMENTS,
  COACH_MOMENT_LABELS,
  profanityReasonText,
  type CoachPersonaCard,
  type CoachRegister,
} from '../../services/coach';
import { personaIcon } from './personaAvatar';

/** Example values for the registry's placeholders, so a preview reads naturally. */
const PLACEHOLDER_EXAMPLES: Record<string, string> = {
  n: '3',
  streak: '4',
  lift: 'Squat',
  time: '18:30',
};

export function fillPlaceholders(line: string): string {
  return line.replace(/\{(n|streak|lift|time)\}/g, (_match, key: string) => PLACEHOLDER_EXAMPLES[key] ?? key);
}

/** The line for one moment at `level`, falling back to the nearest lower level present. */
export function sampleLineAt(persona: CoachPersonaCard, moment: (typeof COACH_MOMENTS)[number], level: number): string | null {
  const lines = persona.sampleLines[moment];
  if (!lines) return null;
  for (let candidate = level; candidate >= 1; candidate -= 1) {
    const line = lines[String(candidate)];
    if (line) return line;
  }
  return null;
}

export interface PersonaGalleryProps {
  personas: CoachPersonaCard[];
  /** The persona chosen on the page. */
  selectedId: string;
  /** The persona saved on the server. */
  activeId: string;
  /** The intensity on the page; sample lines are shown at this level. */
  level: number;
  register: CoachRegister;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

interface PersonaTileProps {
  persona: CoachPersonaCard;
  selected: boolean;
  active: boolean;
  level: number;
  register: CoachRegister;
  onSelect: () => void;
  disabled: boolean;
}

function PersonaTile({ persona, selected, active, level, register, onSelect, disabled }: PersonaTileProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = personaIcon(persona.avatar);
  const titleId = `persona-${persona.id}-name`;
  const linesId = `persona-${persona.id}-lines`;
  const profaneLevel = persona.intensities.find((entry) => entry.profane);
  const profaneLocked = !!profaneLevel && !register.profane;
  const showingCensored = persona.censored && !!profaneLevel && level >= profaneLevel.level;

  return (
    <Card
      component="section"
      aria-labelledby={titleId}
      variant="outlined"
      data-testid={`persona-card-${persona.id}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? 'primary.main' : 'divider',
      }}
    >
      <CardContent sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1 }}>
          <Avatar sx={{ bgcolor: selected ? 'primary.main' : 'action.selected', color: selected ? 'primary.contrastText' : 'text.primary' }}>
            <Icon aria-hidden="true" />
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography id={titleId} variant="subtitle1" component="h3" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {persona.name}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {persona.vibe}
            </Typography>
          </Box>
        </Stack>
        <Typography variant="body2" sx={{ mb: 1, overflowWrap: 'anywhere' }}>
          {persona.tagline}
        </Typography>
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
          {active && <Chip size="small" color="success" icon={<CheckCircleIcon />} label="Active" />}
          {selected && !active && <Chip size="small" color="primary" label="Selected, not saved" />}
          {persona.intensities.map((entry) => (
            <Chip
              key={entry.level}
              size="small"
              variant="outlined"
              icon={entry.profane && profaneLocked ? <LockOutlinedIcon /> : undefined}
              label={entry.profane ? `${entry.label} · 18+${profaneLocked ? ' · locked' : ''}` : entry.label}
            />
          ))}
        </Stack>
        {profaneLevel && profaneLocked && register.reason && (
          <Typography variant="caption" color="text.secondary" component="p" data-testid={`persona-${persona.id}-lock-reason`}>
            {profaneLevel.label}: {profanityReasonText(register.reason)}
          </Typography>
        )}
        <Collapse in={expanded} unmountOnExit>
          <Box id={linesId} sx={{ mt: 1.5 }}>
            {showingCensored && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
                Adult lines are hidden until adult language is unlocked; these are the {persona.intensities.find((e) => e.level === level - 1)?.label ?? 'clean'} lines.
              </Typography>
            )}
            <Box component="dl" sx={{ m: 0 }}>
              {COACH_MOMENTS.map((moment) => {
                const line = sampleLineAt(persona, moment, level);
                if (!line) return null;
                return (
                  <Box key={moment} sx={{ mb: 1 }}>
                    <Typography component="dt" variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                      {COACH_MOMENT_LABELS[moment]}
                    </Typography>
                    <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
                      {fillPlaceholders(line)}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Collapse>
      </CardContent>
      <CardActions sx={{ flexWrap: 'wrap', gap: 1, px: 2, pb: 2 }}>
        <Button
          variant={selected ? 'contained' : 'outlined'}
          size="small"
          aria-pressed={selected}
          disabled={disabled}
          onClick={onSelect}
        >
          {selected ? `${persona.name} selected` : `Choose ${persona.name}`}
        </Button>
        <Button
          size="small"
          aria-expanded={expanded}
          aria-controls={expanded ? linesId : undefined}
          endIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Hide sample lines' : 'Sample lines'}
          <Box component="span" sx={visuallyHidden}>
            {' '}
            for {persona.name}
          </Box>
        </Button>
      </CardActions>
    </Card>
  );
}

const visuallyHidden = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

export function PersonaGallery({
  personas,
  selectedId,
  activeId,
  level,
  register,
  onSelect,
  disabled = false,
}: PersonaGalleryProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' },
      }}
    >
      {personas.map((persona) => (
        <PersonaTile
          key={persona.id}
          persona={persona}
          selected={persona.id === selectedId}
          active={persona.id === activeId}
          level={level}
          register={register}
          onSelect={() => onSelect(persona.id)}
          disabled={disabled}
        />
      ))}
    </Box>
  );
}
