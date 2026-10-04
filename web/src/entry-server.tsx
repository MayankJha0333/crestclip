/**
 * Builds the public pages (home, pricing, policies…) into real HTML on the server. Visitors see the finished page
 * at once — no plain text first — and Google reads the same content people see. React then takes over the page
 * in the browser (main.tsx, "hydrate") without redrawing it.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router-dom/server';
import { routes } from './app/routes';
import { AuthProvider } from './features/auth/auth';
import { setServerData, type InitialData } from './lib/initialData';

const handler = createStaticHandler(routes);

/** The page's HTML for `path`, or null when it isn't a plain page (a redirect, say). */
export async function render(path: string, data: InitialData): Promise<string | null> {
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) return null;
  setServerData(data);
  try {
    const router = createStaticRouter(handler.dataRoutes, context);
    return renderToString(
      <StrictMode>
        <AuthProvider>
          <StaticRouterProvider router={router} context={context} hydrate={false} />
        </AuthProvider>
      </StrictMode>,
    );
  } finally {
    setServerData(null);
  }
}
