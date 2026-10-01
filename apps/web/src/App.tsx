import CssBaseline from '@mui/material/CssBaseline';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { AiConfigProvider } from './contexts/AiConfigContext';
import { TelemetryConfigProvider } from './contexts/TelemetryConfigContext';
import { OnboardingProvider } from './contexts/OnboardingContext';
import { ThemeContextProvider } from './contexts/ThemeContext';
import { ProtectedRoute } from './components/common/ProtectedRoute';
import { RequirePermission } from './components/common/RequirePermission';
import { RequireAiEnabled } from './components/common/RequireAiEnabled';
import { RequireTelemetryEnabled } from './components/common/RequireTelemetryEnabled';
import { Layout } from './components/common/Layout';
import { ErrorBoundary } from './components/common/ErrorBoundary';
// Issue #258, epic #254. Eagerly imported, not lazy: it renders on the error
// path of a deployment that is deliberately out of service, and a code-split
// chunk fetched at that moment is one more thing that has to be working for the
// screen explaining why nothing is working to appear at all.
import { MaintenanceGate } from './components/common/MaintenanceGate';
// PWA prompts (#219, epic #215). Eagerly imported, not lazy: `UpdatePrompt` is
// what REGISTERS the service worker, and a registration deferred behind a
// dynamic import would not happen until React had already decided it was
// needed. Both render `null` in their default state, so the cost is a few
// hundred bytes in the entry chunk.
import { UpdatePrompt } from './components/pwa/UpdatePrompt';
import { InstallPrompt } from './components/pwa/InstallPrompt';

/** Where an AI plan route sends the user while AI is off or `ai:use` is missing. */
const PLANS_AI_REDIRECT = {
  notice: 'Creating a plan with AI is not available right now. You can still view, edit and build plans yourself.',
};

// Pages (lazy loaded)
import { Suspense, lazy } from 'react';
import { LoadingSpinner } from './components/common/LoadingSpinner';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage'));
const ActivateDevicePage = lazy(() => import('./pages/ActivateDevicePage'));
const TodayPage = lazy(() => import('./pages/TodayPage'));
const TrainPage = lazy(() => import('./pages/TrainPage'));
// E4.1: the exercise library. Owned by the `train` destination through the
// `/train` prefix.
const TrainExercisesPage = lazy(() => import('./pages/TrainExercisesPage'));
// E5.6: training plans, also under `/train` (owned by the `train` destination).
const PlansPage = lazy(() => import('./pages/Train/PlansPage'));
const PlanWizardPage = lazy(() => import('./pages/Train/PlanWizardPage'));
const PlanRunPage = lazy(() => import('./pages/Train/PlanRunPage'));
const PlanViewerPage = lazy(() => import('./pages/Train/PlanViewerPage'));
const PlanHistoryPage = lazy(() => import('./pages/Train/PlanHistoryPage'));
// #268 (epic #260): activity goals, also under `/train` (not a settings page).
const GoalsPage = lazy(() => import('./pages/Train/GoalsPage'));
// E4.3: one workout (active logger or completed detail), also under `/train`.
const WorkoutPage = lazy(() => import('./pages/WorkoutPage'));
// E4.5: "Prefill from photo", photos to AI-drafted exercises the user reviews.
const WorkoutPrefillPage = lazy(() => import('./pages/WorkoutPrefillPage'));
// E5.9: a plan's Progress view (signals), also under `/train`.
const PlanProgressPage = lazy(() => import('./pages/PlanProgressPage'));
// E6.1: one quick workout adaptation (live run, then review), also under `/train`.
const AdaptationReviewPage = lazy(() => import('./pages/AdaptationReviewPage'));
const HealthPage = lazy(() => import('./pages/HealthPage'));
// H5 (#189): blood-work history. Owned by the `health` destination through the
// `/health` prefix; not settings pages.
const BiomarkersPage = lazy(() => import('./pages/BiomarkersPage'));
const BiomarkerDetailPage = lazy(() => import('./pages/BiomarkerDetailPage'));
// E7.9 (#249): progress photos. Owned by the `health` destination through the
// `/health` prefix; `?add=1` opens the add flow (the Coach's "Take photo").
const ProgressPhotosPage = lazy(() => import('./pages/ProgressPhotosPage'));
const GymsPage = lazy(() => import('./pages/GymsPage'));
// E3.3: add a gym, and one gym's equipment and photos. Owned by the `gyms`
// destination through the `/gyms` prefix.
const GymNewPage = lazy(() => import('./pages/GymNewPage'));
const GymDetailPage = lazy(() => import('./pages/GymDetailPage'));
// E3.4: "Scan gym", photos to an AI-drafted equipment list the user reviews.
const GymScanPage = lazy(() => import('./pages/GymScanPage'));
// User settings — the hub (#96) plus one route per card in
// `config/userSettingsSections.tsx` (#91, epic #90). These replace the single
// stacked `UserSettingsPage`, which is deleted rather than left unrouted.
const UserSettingsHubPage = lazy(() => import('./pages/UserSettingsHubPage'));
const UserProfilePage = lazy(() => import('./pages/UserProfilePage'));
// `User`-prefixed to make explicit that it edits the signed-in user's own
// theme, not anything under the Console.
const UserAppearancePage = lazy(() => import('./pages/UserAppearancePage'));
// Issue #126, epic #109 — the per-user event x channel notification matrix.
const UserNotificationsPage = lazy(() => import('./pages/UserNotificationsPage'));
// AI Coach settings (E7.3, #243).
const UserCoachSettingsPage = lazy(() => import('./pages/UserCoachSettingsPage'));
const CoachAdminPage = lazy(() => import('./pages/Admin/CoachAdminPage'));
const UserTokensPage = lazy(() => import('./pages/UserTokensPage'));
// Issue #202 — the per-user factory reset (Danger Zone).
const UserDangerZonePage = lazy(() => import('./pages/UserDangerZonePage'));

// Console — the hub (#93) plus one route per card in
// `config/adminSections.tsx` (#92, epic #90).
const SettingsHubPage = lazy(() => import('./pages/Admin/SettingsHubPage'));
// Issue #124, epic #109 — the admin email configuration and its test send.
const EmailSettingsPage = lazy(() => import('./pages/Admin/EmailSettingsPage'));
// Issue #225, epic #215 — the deployment-wide browser-notification policy.
const NotificationSettingsPage = lazy(
  () => import('./pages/Admin/NotificationSettingsPage'),
);
// Issue #355 — runtime-configurable Web Push (VAPID) key management.
const PushConfigPage = lazy(() => import('./pages/Admin/PushConfigPage'));
// Issue #376, epic #372 — the object-storage configuration, its connection
// test and its bucket provisioner.
const StorageConfigPage = lazy(() => import('./pages/Admin/StorageConfigPage'));
// Issue #258, epic #254 — the maintenance window's switch and its layers.
// `Admin`-prefixed locally to keep it distinct from `pages/MaintenancePage`,
// which is the screen a BLOCKED user sees rather than the page that opens and
// closes the window.
const AdminMaintenancePage = lazy(() => import('./pages/Admin/MaintenancePage'));
// Issue #266, epic #254 — the background queue's two Operations pages. Lazy
// like every other admin page: both pull in the shared DataTable, and neither
// is on the path of a user who never opens the Console.
const JobsPage = lazy(() => import('./pages/Admin/JobsPage'));
const JobInsightsPage = lazy(() => import('./pages/Admin/JobInsightsPage'));
// Issue #271, epic #254 — the fleet page, and with it the node credentials it
// hosts as a section. Lazy for the same reason: two DataTables and two dialogs
// that nobody who never opens the Console will ever mount.
const WorkersPage = lazy(() => import('./pages/Admin/WorkersPage'));
// Issue #287, epic #254 — the backup policy, the run history and the restore
// dialog. Lazy for the same reason: a DataTable, a policy form and the restore
// dialog that nobody who never opens the Console will ever mount.
const DbBackupPage = lazy(() => import('./pages/Admin/DbBackupPage'));
// Issue #325, epic #319 — the admin broadcast list and its composer. Lazy for
// the same reason: a DataTable, a composer dialog and a detail dialog that
// nobody who never opens the Console will ever mount.
const BroadcastsPage = lazy(() => import('./pages/Admin/BroadcastsPage'));
// Issue #401, epic #397 — what is actually deployed here: the version, the
// commit, the deploy run that put it there. Lazy like every other admin page;
// nobody who never opens the Console mounts it.
const AboutPage = lazy(() => import('./pages/Admin/AboutPage'));
const AdminUsersPage = lazy(() => import('./pages/Admin/UsersPage'));
// Issue #425, epic #419 — placeholders, filled in by #429, #430 and #434.
const AiConfigPage = lazy(() => import('./pages/Admin/AiConfigPage'));
const AiModelsPage = lazy(() => import('./pages/Admin/AiModelsPage'));
// Issue #444, epic #420 — AI usage aggregates.
const AiUsagePage = lazy(() => import('./pages/Admin/AiUsagePage'));
// Issue #173 — the administrator's model per AI feature.
const AiAssignmentsPage = lazy(() => import('./pages/Admin/AiAssignmentsPage'));
const UserAiKeysPage = lazy(() => import('./pages/UserAiKeysPage'));
const UserAgentModelsPage = lazy(() => import('./pages/UserAgentModelsPage'));
const UserHealthProfilePage = lazy(() => import('./pages/UserHealthProfilePage'));
// Issue #190 (H6) — the caller's own uploaded health documents.
const UserHealthDocumentsPage = lazy(() => import('./pages/UserHealthDocumentsPage'));
const AiPlaygroundPage = lazy(() => import('./pages/AiPlaygroundPage'));
// E7.8 (#248): the AI Coach timeline.
const CoachPage = lazy(() => import('./pages/CoachPage'));
// Issue #537, epic #528 — the telemetry policy page and the SQL explorer. Lazy
// like every admin page; the explorer additionally lazy-loads its CodeMirror
// editor, so neither weighs on the entry chunk.
const TelemetrySettingsPage = lazy(() => import('./pages/Admin/TelemetrySettingsPage'));
const TelemetryExplorerPage = lazy(() => import('./pages/Admin/TelemetryExplorerPage'));
// Issue #578, epic #576 — the at-a-glance dashboard; lazy, and its charts
// (`@mui/x-charts`) travel in its own chunk.
const TelemetryDashboardPage = lazy(() => import('./pages/Admin/TelemetryDashboardPage'));
const DoctorPage = lazy(() => import('./pages/Admin/DoctorPage'));
// Issue #211 — the admin factory reset.
const FactoryResetPage = lazy(() => import('./pages/Admin/FactoryResetPage'));
const SetupGuidePage = lazy(() => import('./pages/Admin/SetupGuidePage'));

// Test login page (development only)
const TestLoginPage = import.meta.env.PROD
  ? null
  : lazy(() => import('./pages/TestLoginPage'));

function AppRoutes() {
  // The MUI `ThemeProvider` is mounted by `ThemeContextProvider` (in `App`,
  // below), which owns the colour scheme; this tree only adds the baseline.
  return (
    <>
      <CssBaseline />
      <ErrorBoundary>
        {/* THE CLIENT GATE (#258, epic #254), around the whole route tree and
            inside `AuthProvider`.

            Around everything, because a maintenance window is a property of the
            deployment rather than of any one page — the user's next click is
            refused wherever they are — and because swapping the subtree is what
            makes the screen's retry work: the pages unmount, and clearing the
            block remounts them so their own effects re-issue the requests that
            failed.

            Inside `AuthProvider` because the screen asks who is looking:
            `system_settings:read` decides whether it offers a link to the page
            that closes the window. That answer comes from the session already
            in memory, never from the API, which is refusing.

            An ordinary 503 with no marker never reaches it — see
            `services/maintenance.ts` for why that distinction is the feature. */}
        <MaintenanceGate>
          <Suspense fallback={<LoadingSpinner fullScreen />}>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/auth/callback" element={<AuthCallbackPage />} />

              {/* Test login (development only) */}
              {!import.meta.env.PROD && TestLoginPage && (
                <Route path="/testing/login" element={<TestLoginPage />} />
              )}

              {/* Protected routes */}
              <Route element={<ProtectedRoute />}>
                {/* Device activation page - without layout for full-screen experience */}
                <Route path="/activate" element={<ActivateDevicePage />} />

                {/* The notification centre (#127, epic #109) wraps the SHELL,
                    not the whole app, and that scoping is the point:

                      * It is INSIDE `ProtectedRoute`, so it only ever mounts for
                        an authenticated user. Every endpoint it calls is
                        `@Auth()`-guarded and every one resolves the recipient from
                        the JWT, so mounting it on `/login` would buy a burst of
                        401s and a stream that cannot connect.
                      * It is around `Layout` specifically, because `Layout`'s
                        `AppBar` is where the bell lives. `/activate` above sits
                        outside the shell on purpose (full-screen device flow) and
                        correspondingly gets no bell and opens no stream.

                    ONE MOUNT POINT, so there is exactly one SSE connection per
                    tab. A provider mounted per-page would open and close a stream
                    on every navigation, which the server sees as a connection
                    storm from a single user and the client experiences as a bell
                    that resets its state every time the route changes. */}
                {/* `AiConfigProvider` (#425, epic #419) sits beside the
                    notification centre for the same two reasons: its endpoint
                    is `@Auth()`, so it belongs inside `ProtectedRoute`, and ONE
                    mount point means ONE `GET /api/ai/config` shared by the
                    chrome (rail, bottom bar, menu, AppBar) and every routed
                    page, instead of one request per consumer.
                    `TelemetryConfigProvider` (#537, epic #528) is its twin for
                    `GET /api/telemetry/config`. `OnboardingProvider` (#203) is
                    the same shape again for `GET /api/onboarding`, shared by the
                    welcome dialog, the Today cards, the user menu and the setup
                    guide. */}
                <Route
                  element={
                    <NotificationProvider>
                      <AiConfigProvider>
                        <TelemetryConfigProvider>
                          <OnboardingProvider>
                            <Layout />
                          </OnboardingProvider>
                        </TelemetryConfigProvider>
                      </AiConfigProvider>
                    </NotificationProvider>
                  }
                >
                  <Route path="/" element={<TodayPage />} />
                  <Route path="/train" element={<TrainPage />} />
                  <Route path="/train/exercises" element={<TrainExercisesPage />} />
                  <Route path="/train/workouts/:workoutId" element={<WorkoutPage />} />
                  <Route path="/train/workouts/:workoutId/prefill" element={<WorkoutPrefillPage />} />
                  {/* Gated on `programs:read`, the string `GET /api/training/signals` enforces. */}
                  <Route
                    path="/train/plans/:programId/progress"
                    element={
                      <RequirePermission permission="programs:read" fallback={<Navigate to="/train" replace />}>
                        <PlanProgressPage />
                      </RequirePermission>
                    }
                  />
                  {/* E5.6: training plans. `programs:read` is the string
                      `/api/programs` enforces. The AI routes (the wizard and
                      the live run) add `ai:use` plus AI being on, and
                      redirect to the list with a notice otherwise; the list,
                      viewer, editor and history never need AI. Literal
                      segments (`new`, `runs/...`) are declared before
                      `:programId` for readers; React Router ranks by
                      specificity either way. */}
                  <Route
                    path="/train/plans"
                    element={
                      <RequirePermission permission="programs:read" fallback={<Navigate to="/train" replace />}>
                        <PlansPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/train/plans/new"
                    element={
                      <RequirePermission permission="ai:use" fallback={<Navigate to="/train/plans" replace state={PLANS_AI_REDIRECT} />}>
                        <RequireAiEnabled fallback={<Navigate to="/train/plans" replace state={PLANS_AI_REDIRECT} />}>
                          <PlanWizardPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/train/plans/runs/:runId"
                    element={
                      <RequirePermission permission="ai:use" fallback={<Navigate to="/train/plans" replace state={PLANS_AI_REDIRECT} />}>
                        <RequireAiEnabled fallback={<Navigate to="/train/plans" replace state={PLANS_AI_REDIRECT} />}>
                          <PlanRunPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* E6.1: a quick workout adaptation. Every route under
                      `/api/ai/training/adaptations` needs `ai:use` and AI
                      being on, so the page does too; otherwise back to Train. */}
                  <Route
                    path="/train/adapt/:adaptationId"
                    element={
                      <RequirePermission permission="ai:use" fallback={<Navigate to="/train" replace />}>
                        <RequireAiEnabled fallback={<Navigate to="/train" replace />}>
                          <AdaptationReviewPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/train/plans/:programId"
                    element={
                      <RequirePermission permission="programs:read" fallback={<Navigate to="/train" replace />}>
                        <PlanViewerPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/train/plans/:programId/history"
                    element={
                      <RequirePermission permission="programs:read" fallback={<Navigate to="/train" replace />}>
                        <PlanHistoryPage />
                      </RequirePermission>
                    }
                  />
                  {/* #268: activity goals. `goals:read` is the string `GET /api/goals` enforces. */}
                  <Route
                    path="/train/goals"
                    element={
                      <RequirePermission permission="goals:read" fallback={<Navigate to="/train" replace />}>
                        <GoalsPage />
                      </RequirePermission>
                    }
                  />
                  <Route path="/health" element={<HealthPage />} />
                  <Route path="/health/biomarkers" element={<BiomarkersPage />} />
                  <Route path="/health/biomarkers/:analyteKey" element={<BiomarkerDetailPage />} />
                  <Route
                    path="/health/progress-photos"
                    element={
                      <RequirePermission permission="health_data:read" fallback={<Navigate to="/health" replace />}>
                        <ProgressPhotosPage />
                      </RequirePermission>
                    }
                  />
                  {/* E7.8 (#248): the AI Coach timeline. Gated exactly as the
                      `coach` destination is: `ai:use` (the string the coach
                      controllers enforce) plus AI being on; with AI off it
                      redirects to Today. */}
                  <Route
                    path="/coach"
                    element={
                      <RequirePermission permission="ai:use" fallback={<Navigate to="/" replace />}>
                        <RequireAiEnabled>
                          <CoachPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  <Route path="/gyms" element={<GymsPage />} />
                  <Route path="/gyms/new" element={<GymNewPage />} />
                  <Route path="/gyms/:gymId" element={<GymDetailPage />} />
                  <Route path="/gyms/:gymId/scan" element={<GymScanPage />} />
                  {/* The per-user settings surface (#96, epic #90) — the same
                      hub component `/admin/settings` renders, over
                      `USER_SETTINGS_SECTIONS`, plus one route per card.

                      NONE OF THESE IS WRAPPED IN `RequirePermission`, and that is
                      the deliberate difference from the `/admin/settings/*` block
                      below rather than an oversight. `ProtectedRoute` above
                      establishes that someone is signed in, and that is the only
                      question these routes have: they edit the caller's OWN
                      settings, which the API grants to all three roles, and
                      `config/userSettingsSections.tsx` correspondingly declares no
                      `permission` on their cards. A gate here would deny a Viewer
                      their own display name. (The exceptions, `/settings/ai`,
                      `/settings/health-profile` and `/settings/health-documents` below, gate on grants the API
                      really does withhold — see their own comments.)

                      As above, declaration order does not matter — React Router
                      v6 ranks by specificity, so `/settings/profile` beats
                      `/settings` wherever each is written. */}
                  <Route path="/settings" element={<UserSettingsHubPage />} />
                  <Route path="/settings/profile" element={<UserProfilePage />} />
                  <Route path="/settings/appearance" element={<UserAppearancePage />} />
                  {/* Ungated like its siblings (#126): these are the caller's own
                      preferences, and the registry endpoint the page renders is
                      itself `@Auth()` with no permission for the same reason. */}
                  <Route path="/settings/notifications" element={<UserNotificationsPage />} />
                  <Route path="/settings/tokens" element={<UserTokensPage />} />
                  {/* Issue #202. Ungated like its siblings: the caller's own
                      data, behind `user_settings:write`, which every role holds. */}
                  <Route path="/settings/danger-zone" element={<UserDangerZonePage />} />
                  {/* Issue #425, epic #419. THE FIRST GATED `/settings/*` ROUTE,
                      and the exception is real: `ai:use` is a grant a
                      deployment can withhold from a role, and the
                      `/api/ai/keys` controller enforces exactly that string —
                      the same one the `AI Keys` card declares. Nested inside
                      it, `RequireAiEnabled` redirects while AI is switched
                      off, when every call the page makes would be refused. */}
                  <Route
                    path="/settings/ai"
                    element={
                      <RequirePermission
                        permission="ai:use"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireAiEnabled>
                          <UserAiKeysPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* Training agents: gated exactly like `/settings/ai` above,
                      on `ai:use` (the string `/api/ai/training/*` enforces and
                      the `Training agents` card declares) plus AI being on. */}
                  <Route
                    path="/settings/ai/agents"
                    element={
                      <RequirePermission
                        permission="ai:use"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireAiEnabled>
                          <UserAgentModelsPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* E7.3 (#243). Gated like `/settings/ai/agents`: `ai:use`
                      (the string `coach-settings.controller.ts` enforces and
                      the `Coach` card declares) plus AI being on, since every
                      coach route sits behind `AiEnabledGuard`. */}
                  <Route
                    path="/settings/coach"
                    element={
                      <RequirePermission
                        permission="ai:use"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireAiEnabled>
                          <UserCoachSettingsPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* Issue #47 (E2.1). Gated on `health_data:read`, the exact
                      string `GET /api/health-profile` enforces and the
                      `Health Profile` card declares: health data is a grant a
                      deployment can withhold from a role. */}
                  <Route
                    path="/settings/health-profile"
                    element={
                      <RequirePermission
                        permission="health_data:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <UserHealthProfilePage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #190 (H6). Gated like Health Profile, on
                      `health_data:read`: the exact string every read route of
                      `health-documents.controller.ts` enforces and the
                      `Health Documents` card declares. Rename and delete need
                      `health_data:write`, gated inside the page. */}
                  <Route
                    path="/settings/health-documents"
                    element={
                      <RequirePermission
                        permission="health_data:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <UserHealthDocumentsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #425, epic #419 — the `ai` destination. Gated
                      exactly as the destination is: `ai:use` AND
                      `ai_config:read` (#593 — the Playground is an operator
                      tool, and `ai_config:read` is the string the admin
                      `/api/admin/ai/*` controllers enforce) plus AI being on. */}
                  <Route
                    path="/ai"
                    element={
                      <RequirePermission
                        permission="ai:use"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequirePermission
                          permission="ai_config:read"
                          fallback={<Navigate to="/" replace />}
                        >
                          <RequireAiEnabled>
                            <AiPlaygroundPage />
                          </RequireAiEnabled>
                        </RequirePermission>
                      </RequirePermission>
                    }
                  />
                  {/* Route-level AUTHORIZATION, not just authentication.
                      `ProtectedRoute` above only establishes that someone is
                      logged in — before this, a Viewer typing `/admin/settings`
                      reached the page and only then watched every API call 403.
                      `RequirePermission` was already in the codebase but had zero
                      usages; wrapping these routes is what turns it into the
                      enforcement point.

                      The permission on each route is the SAME string its card
                      declares in `config/adminSections.tsx`, which is the same
                      string the API's controller enforces — so the hub card, the
                      rail row, the menu entry and the route can no longer
                      disagree about who may go where.

                      ORDER IS NOT SIGNIFICANT HERE. React Router v6 ranks routes
                      by specificity rather than by declaration order, so
                      `/admin/settings/users` beats `/admin/settings` regardless
                      of where each sits in this list. They are grouped by surface
                      for reading, not for matching. */}

                  {/* Both redirects are REAL ROUTES, not catch-all fallout.
                      Without them a bookmarked `/admin/users` matches only `*`
                      and lands silently on `/` — the user asked for a page that
                      still exists and got the home screen with no explanation.
                      `replace` keeps the dead URL out of the history stack, so
                      Back returns to wherever the user came from rather than
                      bouncing through the redirect again.

                      They sit INSIDE `ProtectedRoute` so an unauthenticated
                      bookmark goes to login and arrives here afterwards, rather
                      than being redirected first and losing the destination. */}
                  <Route path="/admin" element={<Navigate to="/admin/settings" replace />} />
                  <Route
                    path="/admin/users"
                    element={<Navigate to="/admin/settings/users" replace />}
                  />
                  {/* Issue #392. The "Deployment" page that issue asked for is
                      delivered by the About page, so this URL is a REDIRECT
                      and deliberately NOT a second `ADMIN_SECTIONS` card — one
                      question, one destination. Ungated for the same reason
                      as the two above: the TARGET route gates. */}
                  <Route
                    path="/admin/settings/deployment"
                    element={<Navigate to="/admin/settings/about" replace />}
                  />

                  {/* The Console hub (#93, epic #90) — the searchable, grouped
                      card grid that reads `ADMIN_SECTIONS`. It replaces the
                      three-tab placeholder that answered this route through #92,
                      whose tabs duplicated the four routes below. That
                      duplication is now gone: the hub NAVIGATES to those routes
                      instead of re-hosting them. */}
                  {/* ANY-OF, and the one route here that is not a single
                      permission. This gate MUST STAY IN SYNC WITH `console`'s
                      `anyPermission` in `config/destinations.ts` — the two lists
                      answer the same question ("may this user reach the admin
                      surface?") on two different surfaces, and #92 left them
                      disagreeing: the Console row appeared in the rail, bottom
                      bar and user menu for a `users:read`-only
                      user, whose click then bounced straight back to `/`. That
                      split brain is exactly what `config/destinations.ts`'s
                      header says the destination model exists to prevent, so the
                      route follows the destination rather than the reverse.

                      `requireAll` defaults to `false`, so `permissions` is an OR
                      here — matching `anyPermission`'s semantics, not
                      `hasAllPermissions`'.

                      A `users:read`-only user consequently reaches this route
                      and — since #93 — sees a hub containing exactly the one card
                      that permission unlocks, instead of the placeholder page's
                      blanket access-denied state. The hub's own gate
                      (`visibleSettingsSections`) does that per CARD, which is why
                      this route only answers the coarser question "may this user
                      reach the admin surface at all?". The five child routes
                      below keep their single-permission gates: each is one
                      specific page with one specific permission. */}
                  <Route
                    path="/admin/settings"
                    element={
                      <RequirePermission
                        permissions={['system_settings:read', 'users:read']}
                        fallback={<Navigate to="/" replace />}
                      >
                        <SettingsHubPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #124, epic #109. Same permission string the `Email`
                      card declares in `config/adminSections.tsx`, which is the
                      same string the API's email-settings controller enforces on
                      its GET — the invariant `destinations.test.ts` asserts for
                      every card. `system_settings:read` and not `:write`: saving
                      and test-sending need write, and the page disables both
                      without it, but the configuration is worth READING for
                      anyone diagnosing why mail is not arriving. */}
                  <Route
                    path="/admin/settings/email"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <EmailSettingsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #225, epic #215. `system_settings:read`, the same
                      string the `Notifications` card declares and the same one
                      `system-settings.controller.ts` enforces on its GET — the
                      invariant `destinations.test.ts` asserts for every card.
                      Saving needs `system_settings:write`, which the page gates
                      internally by disabling its controls. */}
                  <Route
                    path="/admin/settings/notifications"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <NotificationSettingsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #355. Same permission string the `Web Push` card
                      declares in `config/adminSections.tsx`, which is the
                      same string the API's push-config controller enforces on
                      its GET — the invariant `destinations.test.ts` asserts
                      for every card. `push:read` and not `:write`: generating,
                      rotating, enabling/disabling and removing all need
                      `push:write`, which the page disables without it, but
                      the configuration is worth READING for anyone diagnosing
                      why push notifications are not arriving. */}
                  <Route
                    path="/admin/settings/push"
                    element={
                      <RequirePermission
                        permission="push:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <PushConfigPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #376, epic #372. Same permission string the
                      `Storage` card declares in `config/adminSections.tsx`,
                      which is the same string the API's storage-config
                      controller enforces on its GET — the invariant
                      `destinations.test.ts` asserts for every card.
                      `storage_config:read` and not `:write`: saving, testing
                      the connection and creating the bucket all need
                      `storage_config:write`, which the page disables without
                      it, but the configuration is worth READING for anyone
                      diagnosing why an upload failed. And deliberately NOT
                      `storage:read`, which every ordinary user holds — see the
                      card's own comment. */}
                  <Route
                    path="/admin/settings/storage"
                    element={
                      <RequirePermission
                        permission="storage_config:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <StorageConfigPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #258, epic #254. Same permission string the
                      `Maintenance` card declares and the same one
                      `common/maintenance/maintenance.controller.ts` enforces on
                      its GET — the invariant `destinations.test.ts` asserts for
                      every card. Opening and closing a window needs
                      `system_settings:write`, which the page gates internally by
                      disabling its controls.

                      THIS IS ALSO THE ONE ROUTE `MaintenanceGate` NEVER COVERS,
                      mirroring `@AllowDuringMaintenance()` on the controller
                      behind it: the switch that ends a window has to be reachable
                      while the window is open, on both sides. */}
                  <Route
                    path="/admin/settings/maintenance"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <AdminMaintenancePage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #266, epic #254. `jobs:read` on both, the same
                      string the `Jobs` and `Job Insights` cards declare and the
                      same one `jobs/job-admin.controller.ts` enforces on its
                      list, stats and insights reads — the invariant
                      `destinations.test.ts` asserts for every card. Retrying,
                      deleting, sweeping and clearing the rollup all need
                      `jobs:write`, which each PAGE gates internally by omitting
                      the row actions and the sweep buttons.

                      TWO ROUTES, NOT A TAB. `/admin/settings/jobs/insights`
                      nests under the Jobs path deliberately, and React Router
                      v6 ranks by specificity, so the nested route wins wherever
                      it is declared. `settingsPageTitle`'s longest-prefix rule
                      is what keeps the compact AppBar titling it "Job Insights"
                      rather than "Jobs". */}
                  <Route
                    path="/admin/settings/jobs"
                    element={
                      <RequirePermission
                        permission="jobs:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <JobsPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/admin/settings/jobs/insights"
                    element={
                      <RequirePermission
                        permission="jobs:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <JobInsightsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #271, epic #254. Guarded EXACTLY as the two Jobs
                      routes above are, and on `nodes:read` — the literal string
                      `nodes/nodes-admin.controller.ts` enforces on its fleet
                      list, its node detail and its credential list, and the
                      same one the `Worker Nodes` card declares (the invariant
                      `settingsRegistry.test.ts` asserts against the API's own
                      constants file). Deleting a node and creating or revoking
                      a credential need `nodes:write`, which the PAGE gates
                      internally by omitting the row actions and the create
                      button — the route gate is about REACHABILITY.

                      ONE ROUTE, NOT TWO, and no tab: node credentials are
                      CONTENT of this page rather than a destination of their
                      own, because revoking a leaked worker token is an
                      incident-response action and a second card would put two
                      clicks in front of it. See `WorkersPage.tsx` and
                      `components/admin/NodeCredentials.tsx` for the full
                      argument and the alternatives rejected. */}
                  <Route
                    path="/admin/settings/workers"
                    element={
                      <RequirePermission
                        permission="nodes:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <WorkersPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #287, epic #254. Guarded EXACTLY as the Jobs and
                      Workers routes above are, and on `db_backup:read` — the
                      literal string `db-backup/db-backup.controller.ts`
                      enforces on its config read, its run list and its run
                      detail (`PERMISSIONS.DB_BACKUP_READ`), and the same one
                      the `Database Backup` card declares (the invariant
                      `destinations.test.ts` asserts for every card).

                      THREE PERMISSIONS BEHIND THIS ONE ROUTE, and only the
                      first is a reachability gate. Scheduling, cancelling and
                      deleting need `db_backup:write`; restoring and rolling
                      back need `db_backup:restore`, which the API keeps
                      SEPARATE from `write` precisely so it can be withheld from
                      someone who may schedule backups but must not be able to
                      replace the database. The PAGE gates both internally by
                      disabling its controls — widening this route gate to
                      either would make the page unreachable for the read-only
                      admin it is most useful to during an incident. */}
                  <Route
                    path="/admin/settings/db-backup"
                    element={
                      <RequirePermission
                        permission="db_backup:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <DbBackupPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #325, epic #319. Guarded EXACTLY as the Jobs and
                      Workers routes above are, and on `broadcasts:read` — the
                      literal string
                      `notifications/broadcasts/broadcasts.controller.ts`
                      enforces on its audience count, its list and its detail
                      read (`PERMISSIONS.BROADCASTS_READ`), and the same one the
                      `Broadcasts` card declares (the invariant
                      `destinations.test.ts` asserts for every card). Composing,
                      cancelling, deleting and test-sending need
                      `broadcasts:write`, which the PAGE gates internally by
                      disabling its controls with a tooltip — the route gate is
                      about REACHABILITY.

                      The `/admin/settings` hub gate is deliberately NOT widened
                      to include this permission. It mirrors `console`'s
                      `anyPermission` in `config/destinations.ts` byte for byte
                      (asserted in `destinations.test.ts`), and every holder of
                      `broadcasts:read` is an admin who also holds
                      `system_settings:read`, so nothing is unreachable.
                      Widening one side without the other is exactly the
                      disagreement that test exists to catch. */}
                  <Route
                    path="/admin/settings/broadcasts"
                    element={
                      <RequirePermission
                        permission="broadcasts:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <BroadcastsPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #401, epic #397. Guarded EXACTLY as the Jobs,
                      Workers and Broadcasts routes above are, and on
                      `system_settings:read` — the literal string
                      `about/about.controller.ts` enforces on its single GET
                      (`PERMISSIONS.SYSTEM_SETTINGS_READ`), and the same one the
                      `About` card declares (the invariant `destinations.test.ts`
                      asserts for every card).

                      NO WRITE SIDE TO GATE. Unlike every other Operations
                      route, this page has no controls: the endpoint is one GET
                      and the page renders it. So this gate is the only gate,
                      and it is still about REACHABILITY — the page's own
                      `hasPermission` check is defence in depth, exactly as on
                      its siblings.

                      The endpoint ALWAYS answers 200, including when the deploy
                      record is missing, unreadable, written by a failed run, or
                      when the database is down. None of those is a routing or
                      an authorization concern, and none of them must ever be
                      turned into one: the page is opened precisely when things
                      are wrong. */}
                  <Route
                    path="/admin/settings/about"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <AboutPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #425, epic #419. `ai_config:read` on both, the
                      same string the `AI` and `AI Models` cards declare and the
                      admin AI controller enforces on its reads — the invariant
                      `destinations.test.ts` asserts for every card. Writes need
                      `ai_config:write`, which each PAGE gates internally.
                      `/admin/settings/ai` is deliberately NOT behind
                      `RequireAiEnabled`: it is where AI is switched on, so it
                      must be reachable while AI is off. The Models page is,
                      matching its card's `feature: 'ai'`. Nested route, longest
                      prefix wins — the Job Insights precedent. */}
                  <Route
                    path="/admin/settings/ai"
                    element={
                      <RequirePermission
                        permission="ai_config:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <AiConfigPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/admin/settings/ai/models"
                    element={
                      <RequirePermission
                        permission="ai_config:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireAiEnabled>
                          <AiModelsPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/admin/settings/ai/usage"
                    element={
                      <RequirePermission
                        permission="ai_config:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireAiEnabled>
                          <AiUsagePage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/admin/settings/ai/assignments"
                    element={
                      <RequirePermission
                        permission="ai_config:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireAiEnabled>
                          <AiAssignmentsPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* E7.3 (#243). `ai_config:read`, the string the `Coach`
                      admin card declares and the coach admin controller
                      enforces on its GET; feature-gated like the other AI
                      pages. Writes are gated inside the page. */}
                  <Route
                    path="/admin/settings/coach"
                    element={
                      <RequirePermission
                        permission="ai_config:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireAiEnabled>
                          <CoachAdminPage />
                        </RequireAiEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* Issue #537, epic #528. `telemetry:read` is the string the
                      `Telemetry` card declares and `telemetry-admin.controller.ts`
                      enforces on its GETs. NOT behind `RequireTelemetryEnabled`:
                      this is where telemetry is switched on (the `AI` page's
                      precedent). Saving needs `telemetry:write`, which the
                      page gates internally. */}
                  <Route
                    path="/admin/settings/telemetry"
                    element={
                      <RequirePermission
                        permission="telemetry:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <TelemetrySettingsPage />
                      </RequirePermission>
                    }
                  />
                  {/* `telemetry:query`, the explorer controller's permission,
                      plus the feature: redirected while no store is deployed
                      or collection is off. */}
                  <Route
                    path="/admin/settings/telemetry/explorer"
                    element={
                      <RequirePermission
                        permission="telemetry:query"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireTelemetryEnabled>
                          <TelemetryExplorerPage />
                        </RequireTelemetryEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* Issue #578, epic #576. The SAME gates as the explorer:
                      `telemetry:query` (what the dashboard controller enforces)
                      plus the `telemetry` feature. */}
                  <Route
                    path="/admin/settings/telemetry/dashboard"
                    element={
                      <RequirePermission
                        permission="telemetry:query"
                        fallback={<Navigate to="/" replace />}
                      >
                        <RequireTelemetryEnabled>
                          <TelemetryDashboardPage />
                        </RequireTelemetryEnabled>
                      </RequirePermission>
                    }
                  />
                  {/* Issue #203. `system_settings:read`, the string the `Setup guide`
                      card declares; `GET /api/onboarding` returns the admin steps
                      only to holders of it. */}
                  <Route
                    path="/admin/settings/setup"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <SetupGuidePage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #634. `system_settings:read`, the string the `Doctor`
                      card declares and `doctor/doctor.controller.ts` enforces.
                      NOT behind `RequireTelemetryEnabled` or `RequireAiEnabled`:
                      the page reports on those capabilities while they are
                      off. */}
                  <Route
                    path="/admin/settings/doctor"
                    element={
                      <RequirePermission
                        permission="system_settings:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <DoctorPage />
                      </RequirePermission>
                    }
                  />
                  {/* Issue #211. `system:factory_reset`, the string the `Factory
                      reset` card declares and the factory-reset controller
                      enforces on every route; seeded to the Admin role only.
                      The route gate only hides the page — the API refuses the
                      reset itself to anyone without the permission. */}
                  <Route
                    path="/admin/settings/factory-reset"
                    element={
                      <RequirePermission
                        permission="system:factory_reset"
                        fallback={<Navigate to="/" replace />}
                      >
                        <FactoryResetPage />
                      </RequirePermission>
                    }
                  />
                  {/* `users:read` alone, even though the page also hosts the
                      allowlist. The route gate is about REACHABILITY and the page
                      is worth reaching for its Users tab; the Allowlist tab gates
                      its own content on `allowlist:read` inside the page. */}
                  <Route
                    path="/admin/settings/users"
                    element={
                      <RequirePermission
                        permission="users:read"
                        fallback={<Navigate to="/" replace />}
                      >
                        <AdminUsersPage />
                      </RequirePermission>
                    }
                  />
                </Route>
              </Route>

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </MaintenanceGate>
      </ErrorBoundary>
      {/* The PWA prompts (#219, epic #215) sit here — inside the theme
          (`ThemeContextProvider` mounts MUI's `ThemeProvider` around this
          whole tree) so they are themed, OUTSIDE both `ErrorBoundary` and
          `Routes`, and outside `Layout`.

          Outside `Routes` because they belong to the DOCUMENT, not to any
          page: `UpdatePrompt` owns the service-worker registration, which must
          happen on `/login` and `/activate` too (those sessions run on the same
          precached shell, and the worker is also what makes notifications
          possible on Android at all). Mounting them inside `Layout` would tie
          both to the authenticated shell and re-run registration on every
          route change into and out of it.

          Outside `ErrorBoundary` because a page that has crashed is precisely
          when "a new version is available" is most likely to be the fix — a
          prompt inside the boundary would be replaced by the fallback along
          with the page.

          NEITHER RENDERS ANYTHING in its default state (no waiting worker, no
          captured install event), so a normal page load is pixel-identical to
          one before this change. */}
      <UpdatePrompt />
      <InstallPrompt />
    </>
  );
}

export default function App() {
  return (
    <ThemeContextProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeContextProvider>
  );
}
