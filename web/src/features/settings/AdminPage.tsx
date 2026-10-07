import { Link, Navigate } from 'react-router-dom';
import { ChevronRight, Inbox } from 'lucide-react';
import { PageHeader } from '../../components/ui';
import { useAuth } from '../auth/auth';
import { AdminSection } from './AdminSection';
import { SystemSection } from './SettingsPage';

/** Admins only: the server's tools and every account. Regular people never see this (they land on Settings). */
export function AdminPage() {
  const { me } = useAuth();
  if (!me?.user.isAdmin) return <Navigate to="/app/settings" replace />;
  return (
    <>
      <PageHeader title="Admin" description="System status and every account. Only admins can open this page." />
      <div className="flex flex-col gap-6">
        <Link to="/app/admin/support" className="group flex items-center gap-4 rounded-[28px] bg-surface p-5 text-ink no-underline shadow-clay transition-transform hover:-translate-y-0.5">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-orange-bg text-orange-ink" aria-hidden>
            <Inbox size={22} />
          </span>
          <span className="min-w-0 flex-1">
            <b className="block font-display text-xl">Support</b>
            <span className="text-sm text-ink-2">
              {me.support?.adminUnread ? `${me.support.adminUnread} request${me.support.adminUnread === 1 ? '' : 's'} with something new` : 'Help requests from everyone — answer, resolve, follow up'}
            </span>
          </span>
          <ChevronRight size={20} className="shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </Link>
        <SystemSection />
        <AdminSection />
      </div>
    </>
  );
}
