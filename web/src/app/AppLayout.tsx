import { useState } from 'react';
import { hideBroken } from '../lib/img';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { AlertTriangle, Bot, CalendarClock, Compass, LayoutGrid, LogOut, Plus, RefreshCw, Settings, X, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { toast } from '../lib/toast';
import { Button, Toaster } from '../components/ui';
import { Logo } from '../components/brand/Logo';
import { HealthProvider, useHealth, type HealthState } from '../features/settings/health';
import { useAuth } from '../features/auth/auth';
import { CreditMeter, CreditPill } from '../features/billing/CreditMeter';

interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  end?: boolean;
  /** extra paths that should light this item up */
  also?: RegExp;
}
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Create',
    items: [
      { to: '/app', label: 'New clips', Icon: Plus, end: true },
      { to: '/app/explore', label: 'Explore', Icon: Compass },
    ],
  },
  { group: 'Library', items: [{ to: '/app/projects', label: 'Projects', Icon: LayoutGrid, also: /^\/app\/p\// }] },
  {
    group: 'Publish',
    items: [
      { to: '/app/schedule', label: 'Schedule', Icon: CalendarClock },
      { to: '/app/autopilot', label: 'Autopilot', Icon: Bot },
    ],
  },
];
const ALL = NAV.flatMap((g) => g.items);

const DOT: Record<HealthState, string> = { checking: 'bg-ink-3', ok: 'bg-good', setup: 'bg-butter-d animate-pulse', warn: 'bg-warn', bad: 'bg-bad' };

function useActive() {
  const { pathname } = useLocation();
  return (it: NavItem) => (it.end ? pathname === it.to : pathname.startsWith(it.to)) || Boolean(it.also?.test(pathname));
}

function SideLink({ it, active }: { it: NavItem; active: boolean }) {
  return (
    <NavLink
      to={it.to}
      end={it.end}
      className={cn(
        'flex items-center gap-3 rounded-2xl px-3.5 py-2.5 font-display font-semibold no-underline transition-all duration-200',
        active ? 'bg-ink text-on-ink shadow-lift' : 'text-ink-2 hover:bg-row hover:text-ink',
      )}
    >
      <it.Icon size={18} /> {it.label}
    </NavLink>
  );
}

function Sidebar() {
  const isActive = useActive();
  const { state, health } = useHealth();
  const { pathname } = useLocation();
  const isAdmin = Boolean(useAuth().me?.user.isAdmin);
  return (
    <aside className="sticky top-6 hidden h-[calc(100vh-3rem)] w-60 shrink-0 flex-col rounded-[28px] bg-surface p-5 shadow-clay lg:flex">
      <Link to="/" aria-label="CrestClip home" className="no-underline">
        <Logo size={36} />
      </Link>
      <nav className="mt-8 flex flex-col gap-5" aria-label="Main">
        {NAV.map((g) => (
          <div key={g.group} className="flex flex-col gap-1">
            <span className="px-3.5 pb-1 text-[11px] font-black tracking-widest text-ink-3 uppercase">{g.group}</span>
            {g.items.map((it) => (
              <SideLink key={it.to} it={it} active={isActive(it)} />
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2">
        {health?.ai.fake && <span className="rounded-full bg-good-bg px-3 py-1.5 text-center text-xs font-extrabold text-good-ink">Demo AI mode</span>}
        <CreditMeter />
        <NavLink
          to="/app/settings"
          className={cn(
            'flex items-center gap-3 rounded-2xl px-3.5 py-2.5 font-display font-semibold no-underline transition-all',
            pathname.startsWith('/app/settings') ? 'bg-ink text-on-ink shadow-lift' : 'text-ink-2 hover:bg-row hover:text-ink',
          )}
        >
          <Settings size={18} /> Settings
          {isAdmin && <span className={cn('ml-auto size-2.5 rounded-full', DOT[state])} title={state === 'ok' ? 'All systems go' : 'See system status on the Admin page'} />}
        </NavLink>
        <AccountRow />
      </div>
    </aside>
  );
}

/** Who's signed in, and the way out. */
function AccountRow() {
  const { me, logOut } = useAuth();
  if (!me) return null;
  const label = me.user.name || me.user.email;
  return (
    <div className="flex items-center gap-2.5 border-t border-line px-1.5 pt-3">
      {me.user.avatar ? (
        <img src={me.user.avatar} alt="" className="size-8 shrink-0 rounded-full" referrerPolicy="no-referrer" onError={hideBroken} />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-lilac font-display text-sm font-bold text-[#2a1d63]">{label[0]?.toUpperCase()}</span>
      )}
      {/* hidden from Clarity screen recordings: name and email */}
      <span className="min-w-0 flex-1 leading-tight" data-clarity-mask="true">
        <b className="block truncate text-sm">{label}</b>
        {me.user.name && <span className="block truncate text-xs text-ink-3">{me.user.email}</span>}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Log out" title="Log out" onClick={logOut}>
        <LogOut size={16} />
      </Button>
    </div>
  );
}

/** Phone: logo + settings on top, the five main places at the bottom. */
function MobileNav() {
  const isActive = useActive();
  const { state } = useHealth();
  const isAdmin = Boolean(useAuth().me?.user.isAdmin);
  return (
    <>
      <header className="sticky top-0 z-30 -mx-4 mb-4 flex items-center justify-between bg-glass px-4 py-3 backdrop-blur-md lg:hidden">
        <Link to="/" aria-label="CrestClip home" className="no-underline">
          <Logo size={32} />
        </Link>
        <span className="flex items-center gap-2">
          <CreditPill />
          <Link to="/app/settings" aria-label="Settings" className="relative grid size-10 place-items-center rounded-full bg-surface text-ink shadow-clay-sm">
            <Settings size={18} />
            {isAdmin && <span className={cn('absolute top-1.5 right-1.5 size-2 rounded-full', DOT[state])} />}
          </Link>
        </span>
      </header>
      <nav aria-label="Main" className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-[22px] bg-glass p-1.5 shadow-float backdrop-blur-md lg:hidden">
        {ALL.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={cn('flex flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[11px] font-extrabold no-underline', isActive(it) ? 'bg-ink text-on-ink' : 'text-ink-2')}
          >
            <it.Icon size={19} />
            {it.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

/** Real problems only, in plain words, with "Try again" where it helps. Hidden for the session once dismissed. */
function IssueBanner() {
  const { issues, reload } = useHealth();
  const key = issues.map((i) => i.key).join(',');
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('crestclip:banner') ?? '';
    } catch {
      return '';
    }
  });
  const [retrying, setRetrying] = useState(false);
  if (!issues.length || dismissed === key) return null;
  const blocking = issues.some((i) => i.key === 'ai' || i.key === 'ffmpeg');
  const retry = async () => {
    setRetrying(true);
    try {
      await api.refreshTools();
      await reload();
      toast('Checked again');
    } catch {
      toast('Still not working — CrestClip keeps retrying', 'error');
    } finally {
      setRetrying(false);
    }
  };
  return (
    <section role="status" className={cn('mb-6 flex items-start gap-3.5 rounded-[22px] px-4.5 py-4', blocking ? 'bg-bad-bg' : 'bg-warn-bg')}>
      <AlertTriangle size={20} className={cn('mt-0.5 shrink-0', blocking ? 'text-bad' : 'text-warn')} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {issues.map((i) => (
          <div key={i.key} className="flex flex-wrap items-center gap-3 text-sm">
            <div className="min-w-0 flex-1">
              <b>{i.title}</b> <span className="text-ink-2">— {i.detail}</span>
            </div>
            {i.action === 'retry-tools' && (
              <Button size="sm" loading={retrying} onClick={retry}>
                {!retrying && <RefreshCw size={14} />} Try again
              </Button>
            )}
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Hide for now"
        onClick={() => {
          try {
            sessionStorage.setItem('crestclip:banner', key);
          } catch {
            /* ignore */
          }
          setDismissed(key);
        }}
      >
        <X size={16} />
      </Button>
    </section>
  );
}

export function AppLayout() {
  return (
    <HealthProvider>
      <div className="mx-auto flex min-h-screen max-w-[1520px] gap-7 px-4 pt-0 pb-28 lg:p-6">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <MobileNav />
          <div className="mx-auto max-w-[1220px] lg:pt-2">
            <IssueBanner />
            <Outlet />
          </div>
        </main>
      </div>
      <Toaster />
    </HealthProvider>
  );
}
