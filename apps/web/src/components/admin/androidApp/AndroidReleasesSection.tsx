/**
 * Console → Android app → Releases (#287, epic #276).
 *
 * The APKs this server hosts for its users: which one is current, make
 * another current (a rollback asks first), delete one that is not current,
 * and upload a new one for an administrator without the CLI. Dropping the
 * `<app slug>-android-<version>.json` the CLI writes next to the APK fills the
 * form in (names derived from the identity in `utils/androidIdentity.ts`).
 *
 * Every write control is disabled without `system_settings:write` (passed in
 * as `canWrite`); the API enforces it either way, and it decides everything
 * else too: uniqueness, "newer than current", the checksum, trusting the
 * signer. The form only checks shapes so a typo fails before a 150 MB upload.
 */
import { memo, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useAndroidReleases, type ReleaseWriteError } from '../../../hooks/useHealthSync';
import {
  ANDROID_PACKAGE_PATTERN,
  RELEASE_ERROR,
  SHA256_FINGERPRINT_PATTERN,
  formatMegabytes,
  type AdminRelease,
  type AndroidAppConfig,
} from '../../../services/healthSync';
import { ANDROID_PACKAGE_NAME, androidMetadataFileName } from '../../../utils/androidIdentity';
import { formatRelativeTime } from '../../../utils/relativeTime';

export const CLI_HINT_COMMAND = 'evopathcli android release --bump patch';
export const DEFAULT_PACKAGE_NAME = ANDROID_PACKAGE_NAME;
export const MAX_VERSION_CODE = 2_100_000_000;
export const MAX_NOTES = 2000;
export const NOT_NEWER_MESSAGE =
  'This build is not newer than the current release. Phones only install a higher version code. Upload it anyway?';
export const VERSION_EXISTS_MESSAGE =
  'A release with this version code already exists for this package. Bump the version code and build again.';

const MONO = { fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere' } as const;

/** The metadata JSON `evopathcli android build` writes next to the APK. */
export interface ReleaseMetadata {
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  signingSha256?: string;
}

/** Read the CLI's metadata file; unknown or malformed fields are ignored. */
export function parseReleaseMetadata(text: string): ReleaseMetadata | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: ReleaseMetadata = {};
  if (typeof r.packageName === 'string') out.packageName = r.packageName;
  if (typeof r.versionName === 'string') out.versionName = r.versionName;
  if (typeof r.versionCode === 'number' && Number.isInteger(r.versionCode)) out.versionCode = r.versionCode;
  if (typeof r.signingSha256 === 'string') out.signingSha256 = r.signingSha256.trim().toUpperCase();
  return out;
}

/** The one signing fingerprint the deployment knows about, or `''` when there are none or several. */
export function soleKnownSigner(config: AndroidAppConfig | null): string {
  if (!config) return '';
  const shas = new Set(
    [...config.trustedApps, ...config.reportedApps].map((app) => app.sha256.toUpperCase()),
  );
  return shas.size === 1 ? [...shas][0] : '';
}

const isApk = (file: File) => /\.apk$/i.test(file.name);
const isJson = (file: File) => /\.json$/i.test(file.name);

interface FormState {
  apk: File | null;
  versionName: string;
  versionCode: string;
  packageName: string;
  signingSha256: string;
  notes: string;
  makeCurrent: boolean;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.apk) errors.apk = 'Choose the APK file.';
  else if (!isApk(form.apk)) errors.apk = 'The file must be an .apk.';
  const name = form.versionName.trim();
  if (!name) errors.versionName = 'Enter the version name, such as 0.2.0.';
  else if (name.length > 50) errors.versionName = 'At most 50 characters.';
  const code = Number(form.versionCode);
  if (!/^\d+$/.test(form.versionCode.trim()) || !Number.isInteger(code) || code < 1 || code > MAX_VERSION_CODE) {
    errors.versionCode = `A whole number from 1 to ${MAX_VERSION_CODE.toLocaleString()}.`;
  }
  if (!ANDROID_PACKAGE_PATTERN.test(form.packageName.trim())) {
    errors.packageName = 'Enter an Android package name, such as com.example.app.';
  }
  if (!SHA256_FINGERPRINT_PATTERN.test(form.signingSha256.trim().toUpperCase())) {
    errors.signingSha256 = 'Enter a SHA-256 fingerprint: 32 pairs of hex digits separated by colons.';
  }
  if (form.notes.length > MAX_NOTES) errors.notes = `At most ${MAX_NOTES} characters.`;
  return errors;
}

type Confirm = { kind: 'rollback' | 'delete'; release: AdminRelease } | null;

interface AndroidReleasesSectionProps {
  canWrite: boolean;
  config: AndroidAppConfig | null;
  /** Called after a write that may have changed the trusted apps (upload, make current). */
  onTrustMayHaveChanged?: () => void;
}

/**
 * Memoized: the page around it re-renders on every keystroke in the trusted
 * apps form, and this section's list and form need not follow.
 */
export const AndroidReleasesSection = memo(function AndroidReleasesSection({
  canWrite,
  config,
  onTrustMayHaveChanged,
}: AndroidReleasesSectionProps) {
  const { releases, isLoading, error, busyId, isUploading, upload, makeCurrent, remove } = useAndroidReleases();
  const knownSigner = useMemo(() => soleKnownSigner(config), [config]);
  const knownPackage = useMemo(() => {
    const names = new Set([...(config?.trustedApps ?? []), ...(config?.reportedApps ?? [])].map((a) => a.packageName));
    return names.size === 1 ? [...names][0] : DEFAULT_PACKAGE_NAME;
  }, [config]);

  const emptyForm = (): FormState => ({
    apk: null,
    versionName: '',
    versionCode: '',
    packageName: '',
    signingSha256: '',
    notes: '',
    makeCurrent: true,
  });
  const [form, setForm] = useState<FormState>(emptyForm);
  // Until the admin types one (or a metadata file sets it), the package and
  // signer follow what the deployment already knows, which arrives with the
  // config after this section mounts.
  const [signerTouched, setSignerTouched] = useState(false);
  const [packageTouched, setPackageTouched] = useState(false);
  const signingSha256 = signerTouched ? form.signingSha256 : knownSigner;
  const packageName = packageTouched ? form.packageName : knownPackage;

  const [errors, setErrors] = useState<FormErrors>({});
  const [uploadError, setUploadError] = useState<ReleaseWriteError | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const current = releases.find((r) => r.isCurrent) ?? null;
  const writeDisabled = !canWrite || isUploading;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const applyMetadata = (meta: ReleaseMetadata) => {
    setForm((f) => ({
      ...f,
      versionName: meta.versionName ?? f.versionName,
      versionCode: meta.versionCode !== undefined ? String(meta.versionCode) : f.versionCode,
      packageName: meta.packageName ?? f.packageName,
      signingSha256: meta.signingSha256 ?? f.signingSha256,
    }));
    if (meta.packageName) setPackageTouched(true);
    if (meta.signingSha256) setSignerTouched(true);
  };

  const takeFiles = async (files: File[]) => {
    for (const file of files) {
      if (isJson(file)) {
        const meta = parseReleaseMetadata(await file.text());
        if (meta) {
          applyMetadata(meta);
          setMetadataNotice(`Filled in from ${file.name}.`);
        } else {
          setMetadataNotice(`${file.name} is not a release metadata file.`);
        }
      } else {
        set('apk', file);
      }
    }
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void takeFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (writeDisabled) return;
    void takeFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const submit = async (force: boolean) => {
    const values = { ...form, signingSha256, packageName };
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0 || !values.apk) return;
    setUploadError(null);
    setNotice(null);
    const result = await upload({
      apk: values.apk,
      versionName: values.versionName.trim(),
      versionCode: Number(values.versionCode),
      packageName: values.packageName.trim(),
      signingSha256: values.signingSha256.trim().toUpperCase(),
      notes: values.notes,
      makeCurrent: values.makeCurrent,
      force,
    });
    if (result.ok) {
      setNotice(`Uploaded ${result.value.versionName} (${result.value.versionCode}).`);
      setForm(emptyForm());
      setSignerTouched(false);
      setPackageTouched(false);
      setMetadataNotice(null);
      onTrustMayHaveChanged?.();
    } else {
      setUploadError(result.error);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(false);
  };

  const doMakeCurrent = async (release: AdminRelease) => {
    setRowError(null);
    const result = await makeCurrent(release.id);
    if (result.ok) {
      setNotice(`${release.versionName} is now the current release.`);
      onTrustMayHaveChanged?.();
    } else {
      setRowError(result.error.message);
    }
  };

  const doDelete = async (release: AdminRelease) => {
    setRowError(null);
    const result = await remove(release.id);
    if (result.ok) setNotice(`Deleted ${release.versionName}.`);
    else setRowError(result.error.message);
  };

  const requestMakeCurrent = (release: AdminRelease) => {
    if (current && release.versionCode < current.versionCode) setConfirm({ kind: 'rollback', release });
    else void doMakeCurrent(release);
  };

  const confirmAction = () => {
    if (!confirm) return;
    const { kind, release } = confirm;
    setConfirm(null);
    if (kind === 'rollback') void doMakeCurrent(release);
    else void doDelete(release);
  };

  let list;
  if (isLoading && releases.length === 0) {
    list = <Skeleton variant="rounded" height={80} />;
  } else if (error && releases.length === 0) {
    list = <Alert severity="error">{error}</Alert>;
  } else if (releases.length === 0) {
    list = (
      <Typography variant="body2" color="text.secondary">
        No release uploaded yet. Users see a link to the GitHub build until one is.
      </Typography>
    );
  } else {
    list = (
      <List dense disablePadding aria-label="Releases">
        {releases.map((release) => {
          const busy = busyId === release.id;
          return (
            <ListItem
              key={release.id}
              divider
              disableGutters
              sx={{ display: 'block' }}
              data-testid={`release-${release.versionCode}`}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="subtitle1" component="span">
                  {release.versionName}
                </Typography>
                <Typography variant="body2" color="text.secondary" component="span">
                  code {release.versionCode}
                </Typography>
                {release.isCurrent && <Chip size="small" color="success" label="Current" />}
              </Box>
              <ListItemText
                sx={{ my: 0 }}
                secondary={
                  <>
                    {release.packageName} · {formatMegabytes(release.sizeBytes)} · uploaded{' '}
                    {formatRelativeTime(release.createdAt)}
                    <Box component="span" sx={{ ...MONO, display: 'block' }} title={release.fileSha256}>
                      sha256 {release.fileSha256.slice(0, 12)}…
                    </Box>
                  </>
                }
              />
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 0.5 }}>
                {!release.isCurrent && (
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={!canWrite || busyId !== null}
                    onClick={() => requestMakeCurrent(release)}
                    aria-label={`Make ${release.versionName} current`}
                    startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
                  >
                    Make current
                  </Button>
                )}
                <Tooltip title={release.isCurrent ? 'The current release cannot be deleted' : 'Delete'}>
                  <span>
                    <IconButton
                      aria-label={`Delete ${release.versionName}`}
                      disabled={!canWrite || release.isCurrent || busyId !== null}
                      onClick={() => setConfirm({ kind: 'delete', release })}
                    >
                      <DeleteOutlineIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </ListItem>
          );
        })}
      </List>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-labelledby="releases-title">
      <Typography variant="h6" component="h2" id="releases-title" gutterBottom>
        Releases
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The APK users download from Settings → Android app. Publish from your computer with{' '}
        <Box component="code" sx={{ overflowWrap: 'anywhere' }}>
          {CLI_HINT_COMMAND}
        </Box>
        , or upload a build here.
      </Typography>

      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {rowError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRowError(null)}>
          {rowError}
        </Alert>
      )}

      {list}

      <Box
        component="form"
        onSubmit={onSubmit}
        noValidate
        aria-label="Upload a release"
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          if (!writeDisabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="release-upload-form"
        sx={{
          mt: 3,
          p: 2,
          border: 1,
          borderStyle: 'dashed',
          borderColor: dragging ? 'primary.main' : 'divider',
          borderRadius: 1,
        }}
      >
        <Typography variant="subtitle1" component="h3" gutterBottom>
          Upload a release
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Drop the APK here, with the <code>{androidMetadataFileName('<version>')}</code> the CLI writes next to it to
          fill in the fields.
        </Typography>
        <Stack spacing={1.5}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept=".apk,application/vnd.android.package-archive,.json,application/json"
              onChange={onPick}
              data-testid="release-file-input"
              disabled={writeDisabled}
            />
            <Button
              variant="outlined"
              startIcon={<UploadFileIcon />}
              onClick={() => fileInput.current?.click()}
              disabled={writeDisabled}
            >
              Choose APK or metadata
            </Button>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }} data-testid="release-file-name">
              {form.apk ? `${form.apk.name} · ${formatMegabytes(form.apk.size)}` : 'No APK chosen'}
            </Typography>
          </Box>
          {errors.apk && (
            <Typography variant="caption" color="error">
              {errors.apk}
            </Typography>
          )}
          {metadataNotice && <Alert severity="info">{metadataNotice}</Alert>}
          <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <TextField
              label="Version name"
              size="small"
              value={form.versionName}
              onChange={(e) => set('versionName', e.target.value)}
              error={Boolean(errors.versionName)}
              helperText={errors.versionName}
              disabled={writeDisabled}
            />
            <TextField
              label="Version code"
              size="small"
              value={form.versionCode}
              onChange={(e) => set('versionCode', e.target.value)}
              error={Boolean(errors.versionCode)}
              helperText={errors.versionCode ?? (current ? `Current: ${current.versionCode}` : undefined)}
              disabled={writeDisabled}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            />
          </Box>
          <TextField
            label="Package name"
            size="small"
            value={packageName}
            onChange={(e) => {
              setPackageTouched(true);
              set('packageName', e.target.value);
            }}
            error={Boolean(errors.packageName)}
            helperText={errors.packageName}
            disabled={writeDisabled}
            fullWidth
          />
          <TextField
            label="Signing certificate SHA-256"
            size="small"
            value={signingSha256}
            onChange={(e) => {
              setSignerTouched(true);
              set('signingSha256', e.target.value);
            }}
            error={Boolean(errors.signingSha256)}
            helperText={errors.signingSha256 ?? 'Making the release current also trusts this signer.'}
            disabled={writeDisabled}
            fullWidth
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />
          <TextField
            label="Release notes"
            size="small"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            error={Boolean(errors.notes)}
            helperText={errors.notes}
            disabled={writeDisabled}
            multiline
            minRows={2}
            fullWidth
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.makeCurrent}
                onChange={(e) => set('makeCurrent', e.target.checked)}
                disabled={writeDisabled}
              />
            }
            label="Make it the current release"
          />
          {isUploading && <LinearProgress aria-label="Uploading" />}
          {uploadError && uploadError.code === RELEASE_ERROR.VERSION_NOT_NEWER && (
            <Alert
              severity="warning"
              data-testid="upload-not-newer"
              action={
                <Button color="inherit" size="small" onClick={() => void submit(true)} disabled={writeDisabled}>
                  Force
                </Button>
              }
            >
              {NOT_NEWER_MESSAGE}
            </Alert>
          )}
          {uploadError && uploadError.code === RELEASE_ERROR.VERSION_EXISTS && (
            <Alert severity="error" data-testid="upload-version-exists">
              {VERSION_EXISTS_MESSAGE}
            </Alert>
          )}
          {uploadError &&
            uploadError.code !== RELEASE_ERROR.VERSION_NOT_NEWER &&
            uploadError.code !== RELEASE_ERROR.VERSION_EXISTS && <Alert severity="error">{uploadError.message}</Alert>}
          <Box>
            <Button
              type="submit"
              variant="contained"
              disabled={writeDisabled}
              startIcon={isUploading ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {isUploading ? 'Uploading…' : 'Upload release'}
            </Button>
          </Box>
        </Stack>
      </Box>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} aria-labelledby="release-confirm-title">
        <DialogTitle id="release-confirm-title">
          {confirm?.kind === 'rollback'
            ? `Roll back to ${confirm.release.versionName}?`
            : `Delete ${confirm?.release.versionName ?? ''}?`}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm?.kind === 'rollback'
              ? `Version code ${confirm.release.versionCode} is lower than the current ${current?.versionCode ?? ''}. ` +
                'Phones that already run a newer build cannot install it: Android refuses downgrades, so they need to ' +
                'uninstall the app first.'
              : 'The APK file is deleted from storage. Users can no longer download this version.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            onClick={confirmAction}
            color={confirm?.kind === 'delete' ? 'error' : 'warning'}
            variant="contained"
          >
            {confirm?.kind === 'rollback' ? 'Roll back' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
});
