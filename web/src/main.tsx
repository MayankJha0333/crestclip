import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/fredoka';
import '@fontsource-variable/nunito';
import '@fontsource/anton';
import '@fontsource/bangers';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/800.css';
import './styles/clay.css';
import './styles/app.css';
import './styles/landing.css';
import './styles/explore.css';
import { Landing } from './pages/Landing';
import { AppShell } from './pages/AppShell';
import { Dashboard, ProjectsPage } from './pages/Dashboard';
import { ProjectPage } from './pages/ProjectPage';
import { Explore } from './pages/Explore';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="explore" element={<Explore />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="p/:id" element={<ProjectPage />} />
          <Route path="settings" element={<Navigate to="/app" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
