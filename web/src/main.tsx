import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import '@fontsource-variable/fredoka';
import '@fontsource-variable/nunito';
// caption preview fonts (same as the renderer)
import '@fontsource/anton';
import '@fontsource/bangers';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/800.css';
import './styles/index.css';
import { router } from './app/router';
import { AuthProvider } from './features/auth/auth';
import { ConsentBanner } from './components/ConsentBanner';
import { initAnalytics } from './lib/analytics';
import { pageMeta } from './lib/initialData';

initAnalytics();

const root = document.getElementById('root')!;
const app = (
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>
);
// Public pages arrive already built by the server (entry-server.tsx): React takes them over without redrawing.
// Signed-in pages arrive empty and are drawn here.
if (root.dataset.ssr === '1') ReactDOM.hydrateRoot(root, app);
else ReactDOM.createRoot(root).render(app);

// Moving between pages inside the app: show the new page's title and description (the same ones Google gets).
const DEFAULT_TITLE = 'CrestClip — clip the moment everyone rewatches';
router.subscribe(({ location }) => {
  const meta = pageMeta(location.pathname);
  if (location.pathname.startsWith('/receipt/')) return; // the receipt names itself
  document.title = meta?.title ?? DEFAULT_TITLE;
  if (meta) document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description);
});

// the cookie question lives in its own spot, so it never changes the server-built page above
const consent = document.createElement('div');
document.body.appendChild(consent);
ReactDOM.createRoot(consent).render(<ConsentBanner />);
