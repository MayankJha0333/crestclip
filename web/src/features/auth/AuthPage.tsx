import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Mail } from 'lucide-react';
import { api } from '../../lib/api';
import { Logo } from '../../components/brand/Logo';
import { Button, Card, Field, Input } from '../../components/ui';
import { useAuth } from './auth';
import { LEGAL_LINKS } from '../../components/SiteFooter';

/** Only go back to a page inside the app. */
const safeNext = (n: string | null) => (n && /^\/app(\/|$|\?)/.test(n) ? n : '/app');

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Log in / sign up (one page, two modes). */
export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [cfg, setCfg] = useState<{ google: boolean; signups: boolean; firstAccount: boolean } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get('error'));
  useEffect(() => {
    api
      .authConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  if (me) return <Navigate to={next} replace />;
  const signup = mode === 'signup' || Boolean(cfg?.firstAccount);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (signup) await api.signUp({ email, password, name: name || undefined });
      else await api.logIn({ email, password });
      await refresh();
      nav(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const other = `${signup ? '/login' : '/signup'}${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`;

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" aria-label="CrestClip home" className="mx-auto mb-8 block w-fit no-underline">
          <Logo size={40} />
        </Link>
        <Card className="p-6 sm:p-8">
          <h1 className="text-3xl">{cfg?.firstAccount ? 'Create the owner account' : signup ? 'Start clipping free' : 'Welcome back'}</h1>
          <p className="mt-1.5 text-ink-2">
            {cfg?.firstAccount
              ? 'This is the first account on this CrestClip — it becomes the admin, on the Pro plan.'
              : signup
                ? '12 free clips every month (60 credits). No card needed.'
                : 'Log in to your clips, plan and credits.'}
          </p>

          {cfg?.google && (
            <>
              <a
                href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}
                className="mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-full bg-surface font-display font-semibold text-ink no-underline shadow-clay-sm transition-transform hover:-translate-y-0.5"
              >
                <GoogleMark /> Continue with Google
              </a>
              <div className="my-5 flex items-center gap-3 text-xs font-bold text-ink-3 uppercase">
                <span className="h-px flex-1 bg-line" /> or with email <span className="h-px flex-1 bg-line" />
              </div>
            </>
          )}

          {signup && cfg && !cfg.signups ? (
            <p className="mt-6 rounded-2xl bg-warn-bg p-4 text-sm font-semibold text-warn-ink">Sign-ups are closed right now. If you already have an account, log in.</p>
          ) : (
            <form onSubmit={submit} className={cfg?.google ? 'flex flex-col gap-4' : 'mt-6 flex flex-col gap-4'}>
              {signup && (
                <Field label="Your name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} placeholder="Optional" />
                </Field>
              )}
              <Field label="Email">
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
              </Field>
              <Field label="Password" hint={signup ? 'At least 8 characters.' : undefined}>
                <Input type="password" required minLength={signup ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} />
              </Field>
              {error && (
                <p role="alert" className="rounded-2xl bg-bad-bg px-4 py-3 text-sm font-semibold text-bad-ink">
                  {error}
                </p>
              )}
              <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
                {!busy && <Mail size={18} />} {signup ? 'Create account' : 'Log in'}
              </Button>
            </form>
          )}

          {signup && !cfg?.firstAccount && (
            <ul className="mt-6 grid gap-1.5 text-sm text-ink-2">
              {['12 free clips every month', 'Clips with captions, hooks and music', 'Upgrade any time — cancel any time'].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check size={15} className="text-good" /> {t}
                </li>
              ))}
            </ul>
          )}
          {signup && (
            <p className="mt-5 text-center text-xs text-ink-3">
              By creating an account you agree to our{' '}
              <Link to="/terms" className="font-bold text-ink-2">
                Terms
              </Link>{' '}
              and{' '}
              <Link to="/privacy" className="font-bold text-ink-2">
                Privacy policy
              </Link>
              .
            </p>
          )}
        </Card>
        {!cfg?.firstAccount && (
          <p className="mt-6 text-center text-sm text-ink-2">
            {signup ? 'Already have an account? ' : 'New to CrestClip? '}
            <Link to={other} className="font-bold text-accent">
              {signup ? 'Log in' : 'Create a free account'}
            </Link>
          </p>
        )}
        <nav aria-label="Policies" className="mt-8 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs font-bold text-ink-3">
          {LEGAL_LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="text-ink-3 no-underline hover:text-ink">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
