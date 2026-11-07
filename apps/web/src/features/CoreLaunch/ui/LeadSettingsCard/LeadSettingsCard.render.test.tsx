import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { effectiveWith, withProfile } from '../../model/leadSettings';
import { EstimateLead } from '../EstimateCard/EstimateLead';
import { LeadBlock } from '../LeadBlock/LeadBlock';
import { LeadAdvanced } from './LeadAdvanced';

/**
 * Блок «Ведение задачи» настоящей разметкой (этап 11, W3-16): обе карточки в блоке, профиль из
 * записанной области, подробности без усилия `max` и с пределом машины, ведение на оценке —
 * профиль, класс, ожидание и семь строк ролей.
 */

const VIEW: ConfigView = {
  doc: { lead: { projects: { 'repo-1a2b3c4d': { profile: 'economy' } } } },
  digest: 'd'.repeat(64),
  drift: null,
  issues: [],
};

function client(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.core.config, VIEW);
  qc.setQueryData(queryKeys.core.mcpOffers, { kinds: [], clis: [], noReader: [] });
  return qc;
}

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={client()}>{node}</QueryClientProvider>);

const options = (html: string, marker: string): string[][] =>
  [...html.matchAll(new RegExp(`<select[^>]*${marker}[^>]*>(.*?)</select>`, 'g'))].map((m) =>
    [...(m[1] ?? '').matchAll(/value="([^"]*)"/g)].map((v) => v[1] ?? ''),
  );

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('lead block render (W3-16)', () => {
  it('holds the lead settings card and the MCP picks card', () => {
    const html = wrap(<LeadBlock scope="" onScope={() => {}} seen={[]} />);
    expect(html).toContain('data-lead-block');
    expect(html).toContain('data-lead-settings');
    expect(html).toContain('data-launch-section="mcp-picks"');
    expect(html).toContain('Ведение задачи');
  });

  it('the project scope shows its written profile; the machine scope the default', () => {
    const project = wrap(<LeadBlock scope="repo-1a2b3c4d" onScope={() => {}} seen={[]} />);
    const checked = (html: string) =>
      [...html.matchAll(/<input type="radio"[^>]*>/g)]
        .filter((m) => m[0].includes('checked=""'))
        .map((m) => /data-lead-profile="([^"]+)"/.exec(m[0])?.[1]);
    expect(checked(project)).toEqual(['economy']);
    expect(project).toContain('Проект repo-1a2b3c4d');
    const machine = wrap(<LeadBlock scope="" onScope={() => {}} seen={[]} />);
    expect(checked(machine)).toEqual(['balanced']);
  });

  it('details: seven role rows, no max effort, parallelism and the machine cap named', () => {
    const patch = withProfile({}, 'max-quality');
    const html = wrap(
      <LeadAdvanced
        patch={patch}
        effective={effectiveWith(VIEW, '', patch)}
        cap={6}
        scope=""
        disabled={false}
        onPatch={() => {}}
      />,
    );
    expect(html.match(/data-lead-role="/g)).toHaveLength(7);
    const efforts = options(html, 'data-lead-role-effort');
    expect(efforts).toHaveLength(7);
    for (const list of efforts) {
      expect(list).not.toContain('max');
      expect(list).toContain('xhigh');
    }
    expect(html).toMatch(/data-lead-parallelism=""[\s\S]*?value="6"/);
    expect(html).toContain('Предел машины: 6');
  });
});

describe('estimate lead render (W3-16)', () => {
  const lead: NonNullable<EstimateReply['lead']> = {
    profile: 'economy',
    class: null,
    parallelism: 2,
    warnings: [],
    sessionWaitMs: null,
  };

  it('names profile, class pending, wait not estimated and seven role rungs', () => {
    const html = wrap(<EstimateLead lead={lead} repoKey="repo-1a2b3c4d" onScope={() => {}} />);
    expect(html).toContain('data-lead-profile="economy"');
    expect(html).toContain('data-lead-parallelism="2"');
    expect(html).toContain('Экономно');
    expect(html).toContain('решится после разведки');
    expect(html).toContain('не оценено');
    expect(html.match(/data-estimate-lead-role="/g)).toHaveLength(7);
    expect(html).toMatch(/data-lead-scope-this/);
  });

  it.each([
    [0, 'сразу — место свободно'],
    [40_000, '≈ 40 с'],
    [240_000, '≈ 4 мин'],
  ])('a core wait of %i ms reads «%s»', (sessionWaitMs, text) => {
    const html = wrap(<EstimateLead lead={{ ...lead, sessionWaitMs }} repoKey={null} />);
    expect(html).toContain(text);
    expect(html).not.toContain('не оценено');
  });

  it('the scope button waits for the project key', () => {
    const html = wrap(<EstimateLead lead={lead} repoKey={null} onScope={() => {}} />);
    expect(html).toMatch(
      /disabled=""[^>]*data-lead-scope-this|data-lead-scope-this[^>]*disabled=""/,
    );
    expect(html).toContain('Ключ проекта придёт из ленты задачи.');
  });
});
