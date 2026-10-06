import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, LOGGED_OUT, type Me } from '../../lib/api';
import { Spinner } from '../../components/ui';
import { identify } from '../../lib/analytics';
import { readLocal, writeLocal } from '../../lib/storage';
import { setCacheOwner } from '../../lib/cache';

/**
 * The last account this browser saw. Signed-in pages draw straight away from it instead of waiting for the server,
 * and the fresh copy replaces it a moment later (or sends the person to log in if the session has ended).
 * Not used on the server-built public pages, so what React draws there still matches the page exactly.
 */
const ME_KEY = 'crestclip:me';
const cachedMe = (): Me | undefined => {
  if (typeof window === 'undefined' || document.getElementById('root')?.dataset.ssr === '1') return undefined;
  const m = readLocal<Me | null>(ME_KEY, null) ?? undefined;
  if (m) setCacheOwner(m.user.id);
  return m;
};
const rememberMe = (me: Me | null) => {
  setCacheOwner(me?.user.id ?? '');
  if (me) writeLocal(ME_KEY, me);
  else
    try {
      localStorage.removeItem(ME_KEY);
    } catch {
      /* ignore */
    }
};

interface AuthState {
  /** the signed-in person with their plan and credits; null = signed out; undefined = still checking */
  me: Me | null | undefined;
  /** re-read the account (after spending credits, upgrading, …) */
  refresh: () => Promise<void>;
  logOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ me: undefined, refresh: async () => {}, logOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null | undefined>(cachedMe);
  const setMe = useCallback((m: Me | null) => {
    rememberMe(m);
    setMeState(m);
  }, []);
  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      // only a real "not signed in" answer logs the person out; a server restart or a network blip keeps what we have
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) setMe(null);
      else setMeState((cur) => (cur === undefined ? null : cur));
    }
  }, [setMe]);
  // visits count per account, not per browser (random account ID only — never the email)
  const userId = me?.user.id;
  const plan = me?.account.plan.id;
  useEffect(() => {
    if (userId && plan) identify(userId, plan);
  }, [userId, plan]);
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
  }, [refresh, setMe]);
  const logOut = useCallback(async () => {
    await api.logOut().catch(() => {});
    setMe(null);
  }, [setMe]);
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
