/**
 * "Import lab report", H4 (#188): the entry point to `LabReportDialog`, next
 * to "Read from photo" on the Health page.
 *
 * Rendered ONLY when `useCanReadFromPhoto()` holds (AI on, `ai:use`,
 * `intakes:write`, `storage:write`, `health_data:write`): the same gate as the
 * photo reading, since the lab report is the same intake flow with another
 * kind. Whether a model is assigned for `lab_report` is the dialog's
 * `useVisionAvailability('lab_report')`, which explains a blocked state in
 * words. Presentation only: the API enforces every permission on every call.
 */
import { Button, type ButtonProps } from '@mui/material';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { useCanReadFromPhoto } from '../../hooks/useCanReadFromPhoto';

export const IMPORT_LAB_REPORT_LABEL = 'Import lab report';

interface LabReportButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  onClick: () => void;
}

export function LabReportButton({ onClick, variant = 'outlined', ...props }: LabReportButtonProps) {
  const available = useCanReadFromPhoto();
  if (!available) return null;
  return (
    <Button variant={variant} startIcon={<ScienceOutlinedIcon />} onClick={onClick} {...props}>
      {IMPORT_LAB_REPORT_LABEL}
    </Button>
  );
}

export default LabReportButton;
