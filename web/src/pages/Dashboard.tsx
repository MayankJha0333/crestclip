import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Clock, Compass, Film, Trash2 } from 'lucide-react';
import { api, fmtTime, timeAgo, type Project } from '../lib/api';
import { NewProject } from '../components/NewProject';
import { ScoreRing } from '../components/bits';

export function Dashboard() {
  const [params] = useSearchParams();
  return (
    <div className="page">
      <NewProject initialUrl={params.get('url') ?? ''} />
      <Link to="/app/explore" className="explore-promo clay-sm">
        <span className="tint-butter explore-promo-ico">
          <Compass size={22} />
        </span>
        <span className="grow">
          <b>No video in mind?</b> <span className="muted">Browse trending podcasts, interviews and Twitch streams — and see where viewers rewatch before you clip.</span>
        </span>
        <span className="btn btn-sm">
          Explore <ArrowRight size={15} />
        </span>
      </Link>
      <ProjectList limit={6} title="Recent projects" />
    </div>
  );
}

export function ProjectsPage() {
  return (
    <div className="page">
      <ProjectList title="All projects" />
    </div>
  );
}

function ProjectList({ limit, title }: { limit?: number; title: string }) {
  const [list, setList] = useState<Project[] | null>(null);
  const load = () => api.projects().then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const items = limit ? list?.slice(0, limit) : list;
  return (
    <section style={{ marginTop: 44 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <h2 style={{ fontSize: 26 }}>{title}</h2>
        {limit && list && list.length > limit && (
          <Link to="/app/projects" className="btn btn-sm">
            See all {list.length}
          </Link>
        )}
      </div>
      {list == null ? (
        <p className="faint">Loading…</p>
      ) : !items?.length ? (
        <div className="clay empty">
          <span className="tint-butter empty-blob" aria-hidden>
            <Film size={30} />
          </span>
          <div>
            <b>No projects yet</b>
            <p className="muted">Your first clips will show up here.</p>
          </div>
        </div>
      ) : (
        <div className="proj-grid">
          {items.map((p) => (
            <div key={p.id} className="proj-card clay">
              <Link to={`/app/p/${p.id}`} className="proj-link" aria-label={p.title ?? 'Project'}>
                <div className="proj-thumb well">
                  {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : <Film size={30} className="faint" />}
                  {p.duration ? (
                    <span className="badge proj-dur">
                      <Clock size={13} /> {fmtTime(p.duration)}
                    </span>
                  ) : null}
                </div>
                <div className="row" style={{ gap: 12, marginTop: 14, alignItems: 'flex-start' }}>
                  <div className="grow">
                    <h3 className="clamp2" style={{ fontSize: 17 }}>{p.title || p.sourceUrl || 'Untitled'}</h3>
                    <p className="faint" style={{ fontSize: 13, marginTop: 4 }}>
                      {p.status === 'done'
                        ? `${p.readyCount ?? 0} clips ready`
                        : p.status === 'failed'
                          ? 'Failed'
                          : `${Math.round(p.progress)}% · ${p.stageDetail || 'Working…'}`}{' '}
                      · {timeAgo(p.createdAt)}
                    </p>
                  </div>
                  {p.bestScore != null && <ScoreRing value={p.bestScore} size={46} label="Best peak score" />}
                </div>
                {p.status === 'processing' || p.status === 'queued' ? (
                  <div className="progress well" style={{ marginTop: 12 }}>
                    <span style={{ width: `${Math.max(4, p.progress)}%` }} />
                  </div>
                ) : null}
              </Link>
              {p.status !== 'processing' && (
                <button
                  className="btn btn-icon btn-sm proj-del"
                  aria-label="Delete project"
                  onClick={async () => {
                    if (!confirmDelete()) return;
                    await api.remove(p.id).catch(() => {});
                    load();
                  }}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function confirmDelete() {
  // eslint-disable-next-line no-alert
  return window.confirm('Delete this project and all its clips?');
}
