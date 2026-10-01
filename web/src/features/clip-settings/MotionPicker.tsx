import type { Motion } from '../../lib/api';
import { Segmented } from '../../components/ui';
import { MOTIONS } from './options';

export function MotionPicker({ value, onChange }: { value: Motion; onChange: (m: Motion) => void }) {
  return (
    <div>
      <Segmented label="Edit motion" value={value} onChange={onChange} options={MOTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      <p className="mt-2 text-[13px] text-ink-3">{MOTIONS.find((o) => o.value === value)?.hint}</p>
    </div>
  );
}
