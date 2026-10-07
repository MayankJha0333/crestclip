import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, type AdminUser, type PlanId } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardHeader, Input, Select } from '../../components/ui';
import { useAuth } from '../auth/auth';

/** Admins: every account, its plan and credits; give a plan or credits (e.g. testers, refunds by hand). */
export function AdminSection() {
  const { me, refresh } = useAuth();
  const [list, setList] = useState<AdminUser[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (me?.user.isAdmin)
      api
        .adminUsers()
        .then(setList)
        .catch(() => setList([]));
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

  return (
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
  );
}
