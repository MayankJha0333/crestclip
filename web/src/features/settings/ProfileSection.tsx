import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KeyRound, LogOut, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Badge, Button, buttonClass, Card, CardHeader, Field, Input } from '../../components/ui';
import { useAuth } from '../auth/auth';

/** Who you're signed in as, your plan, password and log out. */
export function ProfileSection() {
  const { me, logOut, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const navigate = useNavigate();
  if (!me) return null;
  const removeAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.deleteAccount(confirmEmail);
      await logOut();
      toast('Your account and its data were deleted');
      navigate('/', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword({ current, next });
      toast('Password changed');
      setOpen(false);
      setCurrent('');
      setNext('');
      await refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5 sm:p-6">
      <CardHeader
        title="Your account"
        actions={
          <Button size="sm" variant="ghost" onClick={logOut}>
            <LogOut size={15} /> Log out
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <b className="block truncate" data-clarity-mask="true">
            {me.user.name || me.user.email}
          </b>
          <span className="block truncate text-sm text-ink-3" data-clarity-mask="true">
            {me.user.email}
          </span>
          <span className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="orange">{me.account.plan.name} plan</Badge>
            {me.user.google && <Badge>Google sign-in</Badge>}
            {me.user.isAdmin && <Badge tone="lilac">Admin</Badge>}
          </span>
        </div>
        <span className="flex flex-wrap gap-2">
          <Link to="/app/billing" className={buttonClass('secondary', 'sm')}>
            Plan & credits
          </Link>
          {/* only accounts the owner gave a password (app-review test account) — everyone else signs in with Google */}
          {me.user.hasPassword && (
            <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <KeyRound size={15} /> Change password
            </Button>
          )}
        </span>
      </div>
      {open && me.user.hasPassword && (
        <form onSubmit={save} className="mt-5 grid gap-4 rounded-[22px] bg-row p-4 shadow-flat sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Current password">
            <Input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <Input type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </form>
      )}
      <div className="mt-6 border-t border-line pt-4">
        {!deleting ? (
          <button type="button" className="text-sm text-ink-3 underline-offset-2 hover:underline" onClick={() => setDeleting(true)}>
            Delete my account…
          </button>
        ) : (
          <form onSubmit={removeAccount} className="grid gap-3 rounded-[22px] bg-row p-4 shadow-flat">
            <p className="text-sm">
              <b>This can’t be undone.</b> Your projects, clips, scheduled posts, Autopilots, credits and connected YouTube / Instagram accounts are deleted, and CrestClip’s access to those accounts
              is removed. Payment records are kept because tax law requires it. <Link to="/data-deletion">More about deleting your data</Link>
            </p>
            <Field label={`Type ${me.user.email} to confirm`}>
              <Input required value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} autoComplete="off" data-clarity-mask="true" />
            </Field>
            <span className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" loading={busy} disabled={confirmEmail.trim().toLowerCase() !== me.user.email.toLowerCase()}>
                <Trash2 size={15} /> Delete my account
              </Button>
              <Button type="button" variant="ghost" onClick={() => (setDeleting(false), setConfirmEmail(''))}>
                Keep my account
              </Button>
            </span>
          </form>
        )}
      </div>
    </Card>
  );
}
