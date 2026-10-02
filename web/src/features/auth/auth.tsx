import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, LOGGED_OUT, type Me } from '../../lib/api';
import { Spinner } from '../../components/ui';

interface AuthState {
  /** the signed-in person with their plan and credits; null = signed out; undefined = still checking */
  me: Me | null | undefined;
  /** re-read the account (after spending credits, upgrading, …) */
  refresh: () => Promise<void>;
  logOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ me: undefined, refresh: async () => {}, logOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const out = () => setMe(null);
    // credits change in the background (videos being charged, refunds, renewals): keep the meter fresh
    const tick = () => document.visibilityState === 'visible' && refresh();
    window.addEventListener(LOGGED_OUT, out);
    window.addEventListener('focus', tick);
    const t = window.setInterval(tick, 60_000);
    return () => {
      window.removeEventListener(LOGGED_OUT, out);
      window.removeEventListener('focus', tick);
      window.clearInterval(t);
    };
  }, [refresh]);
  const logOut = useCallback(async () => {
    await api.logOut().catch(() => {});
    setMe(null);
  }, []);
  return <Ctx.Provider value={{ me, refresh, logOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** The signed-in person's plan and credits (only inside RequireAuth). */
export function useAccount() {
  const { me } = useAuth();
  return me!.account;
}

/** Pages that need an account: send anyone signed out to the login page (and back here afterwards). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const { pathname, search } = useLocation();
  if (me === undefined)
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner className="size-8" />
      </div>
    );
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <>{children}</>;
}
