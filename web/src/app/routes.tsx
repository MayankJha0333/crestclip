import { Navigate, type RouteObject } from 'react-router-dom';
import { LandingPage } from '../features/landing/LandingPage';
import { AuthPage } from '../features/auth/AuthPage';
import { RequireAuth } from '../features/auth/auth';
import { AboutPage, ContactPage, CrayoAlternativePage, DataDeletionPage, PricingPage, PrivacyPage, RefundsPage, ShippingPage, TermsPage } from '../features/legal';

/**
 * Every address in the app. Shared by the browser (router.tsx) and the server (entry-server.tsx), which builds the
 * public pages into real HTML so visitors and Google see the finished page straight away.
 *
 * Public pages load with the first file. Signed-in pages (/app, /receipt) are loaded only when someone opens them
 * (`lazy`), so the home page downloads much less code and shows up faster.
 */
export const routes: RouteObject[] = [
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <AuthPage mode="login" /> },
  { path: '/signup', element: <AuthPage mode="signup" /> },
  // company and policy pages (public — payment providers and Google check them)
  { path: '/about', element: <AboutPage /> },
  { path: '/pricing', element: <PricingPage /> },
  { path: '/contact', element: <ContactPage /> },
  { path: '/terms', element: <TermsPage /> },
  { path: '/privacy', element: <PrivacyPage /> },
  { path: '/data-deletion', element: <DataDeletionPage /> },
  { path: '/refunds', element: <RefundsPage /> },
  { path: '/refund-policy', element: <Navigate to="/refunds" replace /> },
  { path: '/shipping', element: <ShippingPage /> },
  // comparison page for people searching for a Crayo alternative
  { path: '/crayo-alternative', element: <CrayoAlternativePage /> },
  // a printable receipt for one payment (outside the app frame so it prints cleanly)
  {
    path: '/receipt/:id',
    lazy: async () => {
      const { ReceiptPage } = await import('../features/billing/ReceiptPage');
      return {
        element: (
          <RequireAuth>
            <ReceiptPage />
          </RequireAuth>
        ),
      };
    },
  },
  {
    path: '/app',
    lazy: async () => {
      const { AppLayout } = await import('./AppLayout');
      return {
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
      };
    },
    children: [
      { index: true, lazy: () => import('../features/create/NewClipsPage').then((m) => ({ Component: m.NewClipsPage })) },
      { path: 'explore', lazy: () => import('../features/explore/ExplorePage').then((m) => ({ Component: m.ExplorePage })) },
      { path: 'projects', lazy: () => import('../features/projects/ProjectsPage').then((m) => ({ Component: m.ProjectsPage })) },
      { path: 'p/:id', lazy: () => import('../features/projects/ProjectPage').then((m) => ({ Component: m.ProjectPage })) },
      { path: 'schedule', lazy: () => import('../features/schedule/SchedulePage').then((m) => ({ Component: m.SchedulePage })) },
      { path: 'autopilot', lazy: () => import('../features/autopilot/AutopilotListPage').then((m) => ({ Component: m.AutopilotListPage })) },
      { path: 'autopilot/new', lazy: () => import('../features/autopilot/AutopilotEditorPage').then((m) => ({ Component: m.AutopilotEditorPage })) },
      { path: 'autopilot/:id', lazy: () => import('../features/autopilot/AutopilotDetailPage').then((m) => ({ Component: m.AutopilotDetailPage })) },
      { path: 'autopilot/:id/edit', lazy: () => import('../features/autopilot/AutopilotEditorPage').then((m) => ({ Component: m.AutopilotEditorPage })) },
      { path: 'settings', lazy: () => import('../features/settings/SettingsPage').then((m) => ({ Component: m.SettingsPage })) },
      { path: 'admin', lazy: () => import('../features/settings/AdminPage').then((m) => ({ Component: m.AdminPage })) },
      { path: 'billing', lazy: () => import('../features/billing/BillingPage').then((m) => ({ Component: m.BillingPage })) },
      { path: '*', element: <Navigate to="/app" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];
