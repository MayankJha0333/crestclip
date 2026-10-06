import { Navigate } from 'react-router-dom';
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
        <SystemSection />
        <AdminSection />
      </div>
    </>
  );
}
