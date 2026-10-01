import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import { api, type Health } from '../lib/api';

export function Settings() {
  const [h, setH] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);
  const load = (refresh = false) => {
    setLoading(true);
    api
      .health(refresh)
      .then(setH)
      .catch(() => setH(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), []);

  const rows = h
    ? [
        {
          ok: h.gemini.ok,
          title: 'Gemini on Vertex AI',
          detail: h.gemini.ok
            ? `${h.gemini.detail} · main model ${h.gemini.model} · fast model ${h.gemini.fastModel}`
            : h.gemini.detail,
          fix: 'gcloud auth application-default login\ngcloud services enable aiplatform.googleapis.com\n# then set GOOGLE_CLOUD_PROJECT in .env and restart',
        },
        { ok: Boolean(h.ffmpeg), title: 'ffmpeg (cutting, captions, reframing)', detail: h.ffmpeg ?? 'Not found', fix: 'brew install ffmpeg' },
        { ok: Boolean(h.ytdlp), title: 'yt-dlp (links + “Most replayed” data)', detail: h.ytdlp ? `Version ${h.ytdlp}` : 'Not found — uploads still work', fix: 'brew install yt-dlp deno' },
        {
          ok: Boolean(h.gcsBucket),
          optional: true,
          title: 'Cloud Storage bucket (optional)',
          detail: h.gcsBucket ? `gs://${h.gcsBucket} — Gemini also watches uploaded videos` : 'Not set — uploaded files are judged from transcript + audio only',
          fix: 'gcloud storage buckets create gs://YOUR-BUCKET --location=us\n# then set GCS_BUCKET=YOUR-BUCKET in .env',
        },
      ]
    : [];

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 34 }}>Setup & status</h1>
        <button className="btn btn-sm" onClick={() => load(true)} disabled={loading}>
          {loading ? <span className="spinner" /> : <RefreshCw size={16} />} Re-check
        </button>
      </div>
      {!h && !loading && <div className="clay empty">Can't reach the PeakClip server. Start it with <code>npm run dev</code>.</div>}
      <div className="stack" style={{ gap: 16 }}>
        {rows.map((r) => (
          <div key={r.title} className="clay" style={{ padding: 22 }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
              {r.ok ? <CheckCircle2 color="var(--good)" /> : <CircleAlert color={r.optional ? 'var(--warn)' : 'var(--bad)'} />}
              <div className="grow">
                <b style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>{r.title}</b>
                <p className="muted" style={{ fontSize: 14, wordBreak: 'break-word' }}>{r.detail}</p>
                {!r.ok && <pre className="code well">{r.fix}</pre>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
