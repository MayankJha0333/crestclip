import { useEffect, useState } from 'react';
import { Gift, ShieldCheck } from 'lucide-react';
import { api, type AdminUser, type FoundingCreatorOfferInfo, type PlanId } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Toggle } from '../../components/ui';
import { useAuth } from '../auth/auth';

type OfferDraft = Pick<FoundingCreatorOfferInfo, 'enabled' | 'limit' | 'endsAt'>;

const toLocalInput = (timestamp: number | null) => {
  if (timestamp === null) return '';
  const local = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

/** Admins: every account, its plan and credits; give a plan or credits (e.g. testers, refunds by hand). */
export function AdminSection() {
  const { me, refresh } = useAuth();
  const [list, setList] = useState<AdminUser[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [offer, setOffer] = useState<FoundingCreatorOfferInfo | null>(null);
  const [offerDraft, setOfferDraft] = useState<OfferDraft | null>(null);
  const [endsAtInput, setEndsAtInput] = useState('');
  const [savingOffer, setSavingOffer] = useState(false);
  useEffect(() => {
    if (me?.user.isAdmin) {
      api
        .adminUsers()
        .then(setList)
        .catch(() => setList([]));
      api
        .adminFoundingCreatorOffer()
        .then((settings) => {
          setOffer(settings);
          setOfferDraft({ enabled: settings.enabled, limit: settings.limit, endsAt: settings.endsAt });
          setEndsAtInput(toLocalInput(settings.endsAt));
        })
        .catch((e) => toast((e as Error).message, 'error'));
    }
  }, [me?.user.isAdmin]);
  if (!me?.user.isAdmin) return null;

  const replace = (u: AdminUser) => setList((l) => l?.map((x) => (x.id === u.id ? u : x)) ?? null);
  const setPlan = async (u: AdminUser, plan: PlanId) => {
    try {
      replace(await api.adminSetPlan(u.id, plan));
      toast(`${u.email} is now on ${plan}`);
      if (u.id === me.user.id) await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const addCredits = async (u: AdminUser) => {
    const delta = Math.trunc(Number(amounts[u.id]));
    if (!delta) return toast('Enter a number of credits (use − to remove)', 'error');
    try {
      replace(await api.adminCredits(u.id, delta, ''));
      setAmounts((a) => ({ ...a, [u.id]: '' }));
      toast(`${delta > 0 ? 'Added' : 'Removed'} ${Math.abs(delta)} credits`);
      if (u.id === me.user.id) await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const saveOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!offerDraft) return;
    const endsAt = endsAtInput ? new Date(endsAtInput).getTime() : null;
    if (endsAtInput && !Number.isFinite(endsAt)) return toast('Choose a valid end date and time.', 'error');
    setSavingOffer(true);
    try {
      const saved = await api.saveAdminFoundingCreatorOffer({ ...offerDraft, endsAt });
      setOffer(saved);
      setOfferDraft({ enabled: saved.enabled, limit: saved.limit, endsAt: saved.endsAt });
      setEndsAtInput(toLocalInput(saved.endsAt));
      toast('Founding offer settings saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSavingOffer(false);
    }
  };

  const offerState = !offer
    ? 'Loading offer settings…'
    : offer.available
      ? 'Accepting sign-ups'
      : !offer.enabled
        ? 'Paused by admin'
        : offer.endsAt !== null && Date.now() >= offer.endsAt
          ? 'Ended by date'
          : 'All spots claimed';

  return (
    <>
      <Card className="p-5 sm:p-6">
        <CardHeader
          title="Admin · founding Creator offer"
          icon={<Gift size={18} />}
          description="Control who can claim the free Creator month. Changes apply to new sign-ups; current offer holders keep their month."
          actions={offer && <Badge tone={offer.available ? 'good' : 'neutral'}>{offerState}</Badge>}
        />
        {!offerDraft ? (
          <p className="text-ink-3">Loading…</p>
        ) : (
          <form onSubmit={saveOffer} className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-row p-4">
              <Toggle checked={offerDraft.enabled} onChange={(enabled) => setOfferDraft((draft) => (draft ? { ...draft, enabled } : draft))}>
                Offer enabled
              </Toggle>
              <p className="text-sm font-semibold text-ink-2">
                {offer ? `${offer.claimed.toLocaleString()} claimed · ${offer.remaining.toLocaleString()} remaining` : 'Loading claim count…'}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Maximum number of sign-ups" hint="This is the total campaign capacity, not the number of spots left. Use 0 to close the offer immediately.">
                <Input
                  type="number"
                  min={0}
                  max={100_000}
                  step={1}
                  required
                  value={offerDraft.limit}
                  onChange={(e) => setOfferDraft((draft) => (draft ? { ...draft, limit: Number(e.target.value) } : draft))}
                />
              </Field>
              <Field label="Switch off at (your local time)" hint="Leave blank for no scheduled end. The offer automatically stops accepting claims after this time.">
                <Input type="datetime-local" value={endsAtInput} onChange={(e) => setEndsAtInput(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-xs text-ink-3">Lowering the limit below the number already claimed closes the remaining spots. Disabling this offer never revokes Creator months already granted.</p>
              <Button type="submit" variant="primary" loading={savingOffer}>Save offer settings</Button>
            </div>
          </form>
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        <CardHeader
          title="Admin · accounts"
          icon={<ShieldCheck size={18} />}
          description="Give someone a plan without payment, or add / remove credits. People with a paid subscription are changed in the Dodo Payments dashboard."
        />
        {!list ? (
          <p className="text-ink-3">Loading…</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-sm">{u.email}</b>
                  <span className="text-xs text-ink-3">
                    {u.balance.toLocaleString()} credits · joined {new Date(u.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {u.isAdmin && <Badge tone="lilac">Admin</Badge>}
                  {u.paying ? (
                    <Badge tone="good">Paying · {u.plan}</Badge>
                  ) : (
                    <Select aria-label={`Plan for ${u.email}`} value={u.plan} onChange={(e) => setPlan(u, e.target.value as PlanId)} className="h-10 w-32 py-0 text-sm">
                      <option value="free">Free</option>
                      <option value="creator">Creator</option>
                      <option value="pro">Pro</option>
                    </Select>
                  )}
                  <Input
                    aria-label={`Credits to add for ${u.email}`}
                    inputMode="numeric"
                    placeholder="± credits"
                    value={amounts[u.id] ?? ''}
                    onChange={(e) => setAmounts((a) => ({ ...a, [u.id]: e.target.value }))}
                    className="h-10 w-28 py-0 text-sm"
                  />
                  <Button size="sm" onClick={() => addCredits(u)}>
                    Apply
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
