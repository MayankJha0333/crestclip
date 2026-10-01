import { createBrowserRouter, Navigate, useLocation } from 'react-router-dom';
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

/** Old "Publishing" page: accounts moved to Settings (keep any ?connected= / ?error= from OAuth). */
function LegacyAccounts() {
  const { search } = useLocation();
  return <Navigate to={`/app/settings${search}`} replace />;
}

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  {
    path: '/app',
    element: <AppLayout />,
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
      { path: 'accounts', element: <LegacyAccounts /> },
      { path: '*', element: <Navigate to="/app" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
