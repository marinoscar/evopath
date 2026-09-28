/**
 * The frame the telemetry assistant (`AssistantPanel`) lives in — issue #579
 * (extracted from the Telemetry Explorer, #537), epic #576.
 *
 * Shared by the Telemetry Explorer and the Telemetry Dashboard so both show
 * the assistant the same way. Which frame is the CALLER's decision, by size:
 *
 *   - `docked`     a persistent right drawer below the AppBar,
 *                  {@link ASSISTANT_WIDTH} wide. It does not cover the page:
 *                  the caller pads its content by that width.
 *   - `overlay`    a temporary right drawer over the page, with a backdrop
 *                  (Escape or a backdrop click closes it).
 *   - `fullscreen` a full-screen dialog (phones).
 *
 * Focus: the modal frames (`overlay`, `fullscreen`) trap focus while open and,
 * by default, MUI restores it on close. A caller that knows better where focus
 * belongs (the control that opened the assistant may have been inside a menu
 * that no longer exists) passes `returnFocus`; the frame then disables MUI's
 * restore and focuses what `returnFocus()` returns once it closes — for the
 * non-modal `docked` frame too.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle, Divider, Drawer, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

/** The docked / overlay drawer's width; a docked caller pads its content by it. */
export const ASSISTANT_WIDTH = 400;

/** The AppBar's height from `sm` up — the docked drawer sits below it. */
const APP_BAR_HEIGHT = 64;

export type AssistantContainerVariant = 'docked' | 'overlay' | 'fullscreen';

export interface AssistantContainerProps {
  open: boolean;
  onClose: () => void;
  variant: AssistantContainerVariant;
  /** Where focus goes once the frame closes. Omitted: MUI's default. */
  returnFocus?: () => HTMLElement | null;
  children: ReactNode;
}

const TITLE_ID = 'telemetry-assistant-title';

function DrawerHeader({ onClose }: { onClose: () => void }) {
  return (
    <>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="h6" component="h2">
          Assistant
        </Typography>
        <IconButton aria-label="Close assistant" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Stack>
      <Divider sx={{ mb: 1 }} />
    </>
  );
}

export function AssistantContainer({ open, onClose, variant, returnFocus, children }: AssistantContainerProps) {
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const wasOpen = useRef(open);

  // Closing (open → false): hand focus back to where the caller says.
  useEffect(() => {
    if (wasOpen.current && !open && returnFocusRef.current) {
      const target = returnFocusRef.current();
      // After the frame's own close handling has run.
      const timer = setTimeout(() => target?.focus(), 0);
      wasOpen.current = open;
      return () => clearTimeout(timer);
    }
    wasOpen.current = open;
    return undefined;
  }, [open]);

  const customFocus = returnFocus !== undefined;

  if (variant === 'fullscreen') {
    return (
      <Dialog
        fullScreen
        open={open}
        onClose={onClose}
        aria-labelledby={TITLE_ID}
        disableRestoreFocus={customFocus}
      >
        <DialogTitle id={TITLE_ID} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Assistant
          <IconButton aria-label="Close assistant" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column' }}>{children}</DialogContent>
      </Dialog>
    );
  }

  if (variant === 'overlay') {
    return (
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        disableRestoreFocus={customFocus}
        slotProps={{
          paper: {
            sx: {
              width: ASSISTANT_WIDTH,
              maxWidth: '90vw',
              p: 2,
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
            },
            role: 'dialog',
            'aria-label': 'Telemetry assistant',
          } as object,
        }}
      >
        <DrawerHeader onClose={onClose} />
        <Stack sx={{ flex: 1, minHeight: 0 }}>{children}</Stack>
      </Drawer>
    );
  }

  return (
    <Drawer
      anchor="right"
      variant="persistent"
      open={open}
      slotProps={{
        paper: {
          sx: {
            width: ASSISTANT_WIDTH,
            top: APP_BAR_HEIGHT,
            height: `calc(100% - ${APP_BAR_HEIGHT}px)`,
            p: 2,
            boxSizing: 'border-box',
          },
          'aria-label': 'Telemetry assistant',
        } as object,
      }}
    >
      <DrawerHeader onClose={onClose} />
      {children}
    </Drawer>
  );
}
