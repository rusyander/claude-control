import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProgressAgent } from '@agentdeck/contracts';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import { i18n } from '@shared/config/i18n';
import { agentTreeKeys, NO_FILTERS } from '@entities/AgentTree';
import { AgentTree } from './AgentTree';

/**
 * Дерево «Плана агента» после того, как читатели транскриптов субагентов ушли в архив (W3-17):
 * сервер шлёт только вызовы `Agent` главного разговора, а модель, вызовы, расход, время и
 * вложенных субагентов дерево берёт у ядра — из того же списка, что кнопка «Агенты». Ревью
 * волны 3: без этого строки стояли голыми, а вложенный субагент пропадал из полосы.
 */
const CHAT = 'chat-1';
const TASK = '019a0000-0000-7000-8000-000000000001';
const SESSION = '019a0000-0000-7000-8000-000000000003';

const node = (nodeId: string, over: Partial<AgentNode> = {}): AgentNode => ({
  nodeId,
  parentId: SESSION,
  taskId: TASK,
  kind: 'subagent',
  status: 'completed',
  stepId: null,
  unitId: null,
  sessionId: SESSION,
  model: null,
  background: false,
  startedAt: 1_000,
  endedAt: 61_000,
  spend: { tokens: null, windowShare: null },
  counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
  signals: [],
  briefExcerpt: null,
  returnExcerpt: null,
  ...over,
});

const agent = (id: string, over: Partial<ProgressAgent> = {}): ProgressAgent => ({
  id,
  kind: 'Explore',
  description: `задача ${id}`,
  status: 'done',
  startedAt: new Date(1_000).toISOString(),
  ...over,
});

function render(agents: ProgressAgent[], nodes: AgentNode[] | undefined): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (nodes) client.setQueryData(agentTreeKeys.list(CHAT, NO_FILTERS), { nodes, truncated: false });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AgentTree chatId={CHAT} agents={agents} isRunning={false} now={200_000} />
    </QueryClientProvider>,
  );
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('AgentTree «Плана агента» — факты узла у ядра', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('строка субагента — модель, число вызовов, расход и время из узла ядра', () => {
    const html = render(
      [agent('toolu_a')],
      [
        node('toolu_a', {
          model: 'claude-sonnet-4-5-20250929',
          counts: { toolCalls: 3, files: 0, refusals: 0, escalations: 0, children: 0 },
          spend: { tokens: 12_345, windowShare: null },
        }),
      ],
    );
    const metrics = /data-agent-metrics[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
    expect(metrics).toContain('sonnet-4-5');
    expect(metrics).toContain('3 вызова');
    expect(metrics).toContain('ток.');
    expect(metrics).toContain('за 1м 00с');
  });

  it('расход неизвестен ядру — счёта нет, ноль не рисуется', () => {
    const html = render([agent('toolu_a')], [node('toolu_a', { model: 'claude-haiku-4-5' })]);
    const metrics = /data-agent-metrics[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
    expect(metrics).toContain('haiku-4-5');
    expect(metrics).not.toContain('ток.');
  });

  it('вложенный субагент (его вызова нет в главном разговоре) — веткой под родителем', () => {
    const html = render(
      [agent('toolu_a', { status: 'running' })],
      [
        node('toolu_a', { status: 'running', endedAt: null }),
        node('toolu_n', {
          parentId: 'toolu_a',
          status: 'running',
          endedAt: null,
          startedAt: 5_000,
          briefExcerpt: 'Вложенная проверка\nдальше',
        }),
      ],
    );
    expect(html).toMatch(/data-agent-node="toolu_n"/);
    expect(html).toMatch(/aria-level="2"[^>]*data-agent-node="toolu_n"/);
    expect(text(html)).toContain('Вложенная проверка');
    expect(text(html)).not.toContain('дальше');
  });

  it('фоновая работа и сеанс ядра в «План агента» не попадают — только субагенты', () => {
    const html = render(
      [agent('toolu_a')],
      [
        node('toolu_a'),
        node(SESSION, { kind: 'unit-session', parentId: null }),
        node('bg-1', { kind: 'background-shell', background: true, parentId: 'toolu_a' }),
      ],
    );
    expect(html).not.toContain('data-agent-node="bg-1"');
    expect(html).not.toContain(`data-agent-node="${SESSION}"`);
  });

  // Чат чужого CLI (F-07): строк из транскрипта нет вовсе — узлом дерева встаёт субагент ядра.
  it('строк транскрипта нет (чужой CLI) — субагент ядра узлом дерева', () => {
    const html = render(
      [],
      [
        node('call_q1', { briefExcerpt: 'проверка субагента', status: 'running', endedAt: null }),
        node(SESSION, { kind: 'unit-session', parentId: null }),
      ],
    );
    expect(html).toMatch(/aria-level="1"[^>]*data-agent-node="call_q1"/);
    expect(text(html)).toContain('проверка субагента');
    expect(html).not.toContain(`data-agent-node="${SESSION}"`);
  });

  it('ядро ещё не ответило — строки из транскрипта как есть', () => {
    const html = render([agent('toolu_a')], undefined);
    expect(html).toContain('data-agent-node="toolu_a"');
    expect(html).not.toContain('data-agent-metrics');
  });
});
