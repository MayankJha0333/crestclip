import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { LandingPage } from '../features/landing/LandingPage';
import { NewClipsPage } from '../features/create/NewClipsPage';
import { ExplorePage } from '../features/explore/ExplorePage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { ProjectPage } from '../features/projects/ProjectPage';
import { SchedulePage } from '../features/schedule/SchedulePage';
import { AutopilotListPage } from '../features/autopilot/AutopilotListPage';
import { AutopilotEditorPage } from '../features/autopilot/AutopilotEditorPage';
import { AutopilotDetailPage } from '../features/autopilot/AutopilotDetailPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AuthPage } from '../features/auth/AuthPage';
import { RequireAuth } from '../features/auth/auth';
import { BillingPage } from '../features/billing/BillingPage';
import { AboutPage, ContactPage, CrayoAlternativePage, PricingPage, PrivacyPage, RefundsPage, ShippingPage, TermsPage } from '../features/legal';
import { ReceiptPage } from '../features/billing/ReceiptPage';

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <AuthPage mode="login" /> },
  { path: '/signup', element: <AuthPage mode="signup" /> },
  // company and policy pages (public — Razorpay and Google check them)
  { path: '/about', element: <AboutPage /> },
  { path: '/pricing', element: <PricingPage /> },
  { path: '/contact', element: <ContactPage /> },
  { path: '/terms', element: <TermsPage /> },
  { path: '/privacy', element: <PrivacyPage /> },
  { path: '/refunds', element: <RefundsPage /> },
  { path: '/refund-policy', element: <Navigate to="/refunds" replace /> },
  { path: '/shipping', element: <ShippingPage /> },
  // comparison page for people searching for a Crayo alternative
  { path: '/crayo-alternative', element: <CrayoAlternativePage /> },
  // a printable receipt for one payment (outside the app frame so it prints cleanly)
  {
    path: '/receipt/:id',
    element: (
      <RequireAuth>
        <ReceiptPage />
      </RequireAuth>
    ),
  },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <NewClipsPage /> },
      { path: 'explore', element: <ExplorePage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'p/:id', element: <ProjectPage /> },
      { path: 'schedule', element: <SchedulePage /> },
      { path: 'autopilot', element: <AutopilotListPage /> },
      { path: 'autopilot/new', element: <AutopilotEditorPage /> },
      { path: 'autopilot/:id', element: <AutopilotDetailPage /> },
      { path: 'autopilot/:id/edit', element: <AutopilotEditorPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'billing', element: <BillingPage /> },
      { path: '*', element: <Navigate to="/app" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
