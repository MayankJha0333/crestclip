import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { buttonClass, PageHeader } from '../../components/ui';
import { useAccount } from '../auth/auth';
import { ProjectGrid, useProjects } from './ProjectGrid';

export function ProjectsPage() {
  const { list, load } = useProjects();
  const days = useAccount().plan.storageDays;
  return (
    <>
      <PageHeader
        title="Projects"
        description={`Every video you clipped. Open one to watch, edit and post its clips.${days ? ` Projects are kept for ${days} days on your plan.` : ''}`}
        actions={
          <Link to="/app" className={buttonClass('primary')}>
            <Plus size={18} /> New clips
          </Link>
        }
      />
      <ProjectGrid list={list} onChanged={load} />
    </>
  );
}
