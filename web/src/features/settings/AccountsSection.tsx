import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Copy, Link2, LogOut, ShieldCheck, UserPlus } from 'lucide-react';
import { api, type Account, type Connections } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, buttonClass, ConfirmDialog, Skeleton } from '../../components/ui';
import { SOCIAL, type SocialPlatform } from '../schedule/postStatus';

const INFO: Record<SocialPlatform, { blurb: string; perks: string[]; note: React.ReactNode; provider: string }> = {
  youtube: {
    blurb: 'Post Shorts straight to your channel.',
    perks: ['Title, description and privacy per post', 'Scheduled with YouTube’s own clock — goes out even if CrestClip is off'],
    note: (
      <>
        Until your Google app passes YouTube’s free API audit, uploads stay <b>private</b>. Fine for testing — request the audit before launch.
      </>
    ),
    provider: 'Google',
  },
  instagram: {
    blurb: 'Post Reels with your caption and hashtags.',
    perks: ['Caption and hashtags from your clip', 'Scheduled by CrestClip — keep it running at post time'],
    note: (
      <>
        Needs an Instagram <b>Business or Creator</b> account (Instagram app → Settings → Account type).
      </>
    ),
    provider: 'Instagram',
  },
};

function SetupSteps({ platform, redirectUri, needsHttps }: { platform: SocialPlatform; redirectUri: string; needsHttps: boolean }) {
  const [open, setOpen] = useState(true);
  const copy = () => navigator.clipboard.writeText(redirectUri).then(() => toast('Copied'));
  const link = (href: string, text: string) => (
    <a className="font-bold text-ink underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
  const code = (t: string) => <code className="rounded-md bg-muted-bg px-1.5 py-px text-xs">{t}</code>;
  const steps =
    platform === 'youtube'
      ? [
          <>
            In {link('https://console.cloud.google.com/apis/library/youtube.googleapis.com', 'Google Cloud')} (same project as Gemini), turn on <b>YouTube Data API v3</b>.
          </>,
          <>
            Set up the {link('https://console.cloud.google.com/auth/overview', 'OAuth consent screen')} (External) and add your Google account as a <b>test user</b>.
          </>,
          <>
            Create an {link('https://console.cloud.google.com/apis/credentials', 'OAuth client ID')} → type <b>Web application</b> → add this redirect URI:
          </>,
          <>
            Put the keys in {code('.env')}: {code('YOUTUBE_CLIENT_ID=…')} and {code('YOUTUBE_CLIENT_SECRET=…')}, then restart CrestClip.
          </>,
        ]
      : [
          <>
            Make sure the Instagram account is a <b>Business or Creator</b> account.
          </>,
          <>
            In {link('https://developers.facebook.com/apps', 'Meta for Developers')}, create an app → add <b>Instagram</b> → “API setup with Instagram login”, and add your account as a tester (then
            accept the invite in Instagram).
          </>,
          <>
            Under <b>Business login settings</b>, add this redirect URL
            {needsHttps
              ? ' (Instagram needs https — use your live domain and set PUBLIC_URL in .env)'
              : redirectUri.startsWith('https://localhost')
                ? ' (local https: the first time your browser warns “not private” — click Advanced → Proceed)'
                : ''}
            :
          </>,
          <>
            Put the keys in {code('.env')}: {code('INSTAGRAM_APP_ID=…')} and {code('INSTAGRAM_APP_SECRET=…')}, then restart CrestClip.
          </>,
        ];
  return (
    <div className="mt-4 rounded-[18px] bg-sunken p-4 text-sm shadow-well">
      <button type="button" className="inline-flex items-center gap-1 font-extrabold text-ink-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        One-time setup (about 10 min) <ChevronDown size={14} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 leading-snug text-ink-2">
          {steps.map((s, i) => (
            <li key={i}>
              {s}
              {i === 2 && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 rounded-lg bg-muted-bg px-2 py-1.5 text-xs break-all">{redirectUri}</code>
                  <Button size="icon-sm" onClick={copy} aria-label="Copy redirect URI">
                    <Copy size={13} />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PlatformCard({
  pf,
  accounts,
  setup,
  needsHttps,
  onRemove,
}: {
  pf: SocialPlatform;
  accounts: Account[];
  setup: { configured: boolean; redirectUri: string };
  needsHttps: boolean;
  onRemove: (a: Account) => void;
}) {
  const P = SOCIAL[pf];
  const I = INFO[pf];
  const connected = accounts.length > 0;
  return (
    <section className="flex flex-col rounded-[24px] bg-row p-5 shadow-flat">
      <div className="flex items-center gap-3.5">
        <span className={cn('grid size-12 shrink-0 place-items-center rounded-2xl text-white shadow-lift', P.color)}>
          <P.Icon size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-xl">{P.name}</h3>
          <p className="text-[13.5px] text-ink-2">{I.blurb}</p>
        </div>
        <Badge tone={connected ? 'good' : setup.configured ? 'neutral' : 'warn'}>
          <i className={cn('size-2 rounded-full bg-current', connected && 'animate-ping-soft')} aria-hidden />
          {connected ? `${accounts.length} connected` : setup.configured ? 'Not connected' : 'Setup needed'}
        </Badge>
      </div>

      <ul className="mt-4 flex flex-col gap-1.5 text-[13.5px] text-ink-2">
        {I.perks.map((t) => (
          <li key={t} className="flex items-start gap-2">
            <Check size={14} className="mt-0.5 shrink-0 text-mint-d" /> {t}
          </li>
        ))}
      </ul>

      {connected ? (
        <div className="mt-4 flex flex-col gap-2">
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-2xl bg-surface py-2.5 pr-2.5 pl-3 shadow-flat">
              {a.avatar ? (
                <img src={a.avatar} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" />
              ) : (
                <span className="grid size-10 place-items-center rounded-full bg-muted-bg font-black">{(a.name ?? '?')[0]}</span>
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <b className="truncate">{a.name}</b>
                <span className="text-xs text-ink-3">
                  {a.handle ? `${a.handle} · ` : ''}connected {timeAgo(a.connectedAt)}
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onRemove(a)} title={`Disconnect ${a.name ?? ''}`}>
                <LogOut size={14} /> <span className="hidden sm:inline">Disconnect</span>
              </Button>
            </div>
          ))}
          {setup.configured && (
            <a
              href={api.connectUrl(pf)}
              className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong p-2.5 text-[13.5px] font-extrabold text-ink-2 no-underline hover:border-tangerine hover:text-accent"
            >
              <UserPlus size={15} /> Add another {P.name} account
            </a>
          )}
        </div>
      ) : setup.configured ? (
        <div className="mt-5 flex flex-col gap-3">
          <a className={buttonClass('primary')} href={api.connectUrl(pf)}>
            <Link2 size={16} /> Connect {P.name}
          </a>
          <p className="flex items-start justify-center gap-1.5 text-center text-xs text-ink-3">
            <ShieldCheck size={13} className="mt-px shrink-0 text-mint-d" /> You sign in on {I.provider}. CrestClip only asks to upload {P.what} — never your password.
          </p>
        </div>
      ) : (
        <SetupSteps platform={pf} redirectUri={setup.redirectUri} needsHttps={needsHttps} />
      )}

      <p className="mt-5 flex items-start gap-2 border-t border-dashed border-line-strong pt-4 text-xs leading-snug text-ink-3">
        <AlertTriangle size={13} className="mt-px shrink-0 text-warn" />
        <span>{I.note}</span>
      </p>
    </section>
  );
}

/** Connect / disconnect the YouTube and Instagram accounts clips are posted to. */
export function AccountsSection({ data, onChange }: { data: Connections | null; onChange: () => void }) {
  const [removing, setRemoving] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const name = removing ? SOCIAL[removing.platform].name : '';
  return (
    <>
      {data ? (
        <div className="grid gap-4 md:grid-cols-2">
          {(['youtube', 'instagram'] as const).map((pf) => (
            <PlatformCard
              key={pf}
              pf={pf}
              accounts={data.accounts.filter((a) => a.platform === pf)}
              setup={data.platforms[pf]}
              needsHttps={pf === 'instagram' && data.platforms.instagram.needsHttps}
              onRemove={setRemoving}
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title={`Disconnect ${name}?`}
        confirmLabel="Disconnect"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          try {
            await api.disconnect(removing.id);
            toast('Disconnected');
            setRemoving(null);
            onChange();
          } catch (e) {
            toast((e as Error).message, 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          CrestClip will forget <b>{removing?.name}</b> and drop its post history here. Posts waiting in CrestClip won’t go out. Anything already on {name} (including YouTube’s own schedule) stays
          there.
        </p>
      </ConfirmDialog>
    </>
  );
}
