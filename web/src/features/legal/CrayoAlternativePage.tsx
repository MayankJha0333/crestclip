import { Link } from 'react-router-dom';
import { buttonClass } from '../../components/ui';
import { useBusiness } from './business';
import { LegalLayout, Section } from './LegalLayout';

/**
 * A fair comparison page for people searching for a Crayo alternative. Keep every line about Crayo factual (from
 * crayo.ai) — no prices or claims we can't check.
 */
export function CrayoAlternativePage() {
  const b = useBusiness();
  return (
    <LegalLayout
      title="CrestClip vs Crayo"
      wide
      intro="Both make short-form videos, but they start from different places. Crayo is built for creating new videos; CrestClip turns the long videos you already have into clips — starting from the moments viewers actually rewatch."
      business={b}
    >
      <Section title="The short answer">
        <ul>
          <li>
            <strong>Pick CrestClip</strong> if you have podcasts, streams, interviews or long YouTube videos and want the best moments cut into Shorts and Reels.
          </li>
          <li>
            <strong>Pick Crayo</strong> if you want to make videos from text — Reddit story videos, fake text videos, AI voiceovers over gameplay backgrounds.
          </li>
        </ul>
      </Section>

      <Section title="How they compare">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
            <thead>
              <tr className="border-b border-line">
                <th className="py-2 pr-4" />
                <th className="py-2 pr-4 text-ink">CrestClip</th>
                <th className="py-2 text-ink">Crayo</th>
              </tr>
            </thead>
            <tbody className="[&_td]:py-2.5 [&_td]:pr-4 [&_td]:align-top [&_tr]:border-b [&_tr]:border-line">
              <tr>
                <td className="font-bold text-ink">Built for</td>
                <td>Clipping long videos into shorts</td>
                <td>Making new short videos (stories, text videos) plus an Auto Clip tool</td>
              </tr>
              <tr>
                <td className="font-bold text-ink">How moments are picked</td>
                <td>YouTube’s “most replayed” graph, timestamped comments and audio energy, then AI</td>
                <td>AI (Auto Clip)</td>
              </tr>
              <tr>
                <td className="font-bold text-ink">Captions</td>
                <td>Word-by-word animated captions, 5 styles, AI hook headline</td>
                <td>AI subtitles in many styles</td>
              </tr>
              <tr>
                <td className="font-bold text-ink">Text-to-video, voiceovers</td>
                <td>—</td>
                <td>Reddit story and fake text videos, AI voiceover</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-ink-3">Crayo details are from crayo.ai as of October 2026 and may change. Crayo is a trademark of its owner; CrestClip isn’t affiliated with it.</p>
      </Section>

      <Section title="What CrestClip is built around">
        <ul>
          <li>
            <strong>Real audience data.</strong> Clips start from where viewers rewind and rewatch, not only from what an AI guesses is interesting.
          </li>
          <li>
            <strong>A score for every clip.</strong> Each clip is ranked on hook, payoff, emotion and shareability, with the reasons shown, so you post the winners first.
          </li>
          <li>
            <strong>Explore.</strong> Search YouTube and Twitch for long videos worth clipping and preview their replay peaks before you spend credits.
          </li>
          <li>
            <strong>Autopilot.</strong> Pick channels or a topic; CrestClip finds new videos, clips them and posts to YouTube and Instagram on your schedule.
          </li>
        </ul>
      </Section>

      <Section title="Try CrestClip free">
        <p>
          Start on the free plan — no card needed — and turn your first long video into clips. See every plan on the <Link to="/pricing">pricing page</Link>.
        </p>
        <div>
          <Link to="/signup" className={buttonClass('primary', 'md')}>
            Start free
          </Link>
        </div>
      </Section>
    </LegalLayout>
  );
}
