import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentNode, AgentsListReply } from '@agentdeck/contracts/core/agents';
import { agentTreeKeys, NO_FILTERS } from '@entities/AgentTree';
import { i18n } from '@shared/config/i18n';
import { GroupAgents } from './GroupAgents';

/**
 * Карточка группы в хабе — по журналу ядра: счёт «идёт · закончено» без сеансов единиц, переходы
 * к субагентам и фоновым работам (идущие первыми) и кнопка «Агенты» с «фоном: N». Данные — в кэше
 * запросов, как их кладёт `useCoreAgents`.
 */
const TASK = '019a0000-0000-7000-8000-000000000001';

const node = (nodeId: string, over: Partial<AgentNode> = {}): AgentNode => ({
  nodeId,
  parentId: 'sess',
  taskId: TASK,
  kind: 'subagent',
  status: 'completed',
  stepId: null,
  unitId: null,
  sessionId: null,
  model: null,
  background: false,
  startedAt: 1_000,
  endedAt: 2_000,
  spend: { tokens: null, windowShare: null },
  counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
  signals: [],
  briefExcerpt: `задание ${nodeId}`,
  returnExcerpt: null,
  ...over,
});

function render(nodes: AgentNode[]): string {
  const client = new QueryClient();
  const reply: AgentsListReply = { nodes, truncated: false };
  client.setQueryData(agentTreeKeys.list('g1', NO_FILTERS), reply);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GroupAgents chatId="g1" group={{ isRunning: false }} onOpen={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('GroupAgents — агенты группы по журналу ядра', () => {
  it('узлов у чата нет — карточки нет', () => {
    expect(render([])).toBe('');
  });

  it('сеанс не в счёт; идущий фоновый — первым, счёт и «фоном: 1» на кнопке', () => {
    const html = render([
      node('sess', { kind: 'unit-session', parentId: null, status: 'running', endedAt: null }),
      node('toolu_sub', { startedAt: 3_000 }),
      node('bash_1', {
        kind: 'background-shell',
        background: true,
        status: 'running',
        endedAt: null,
        briefExcerpt: 'npm run watch',
      }),
    ]);
    expect(html).toContain('data-group-agents="2"');
    expect(html).toContain('Агенты: 1 идёт · 1 закончено');
    expect(html.indexOf('data-group-agent-jump="bash_1"')).toBeLessThan(
      html.indexOf('data-group-agent-jump="toolu_sub"'),
    );
    expect(html).not.toContain('data-group-agent-jump="sess"');
    expect(html).toContain('data-agent-history-bg="1"');
    expect(html).toContain('фоном: 1');
  });
});
