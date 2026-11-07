import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import { i18n } from '@shared/config/i18n';
import { agentTreeKeys, NO_FILTERS } from '@entities/AgentTree';
import { ChatProgressSheet } from './ChatProgressSheet';
import type { ChatProgressSheetProps } from '../ChatProgressSheet.types';

const CHAT = 'chat-1';
const SESSION = '019a0000-0000-7000-8000-000000000003';

/** Полоса в клиенте запросов; `nodes` — ответ ядра «Агенты» этого разговора уже в кэше. */
function renderSheet(props: ChatProgressSheetProps, nodes?: AgentNode[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (nodes) client.setQueryData(agentTreeKeys.list(CHAT, NO_FILTERS), { nodes, truncated: false });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatProgressSheet {...props} />
    </QueryClientProvider>,
  );
}

/**
 * Живой прогон 29.09: ход кончился вопросом человеку, а полоса «План агента»
 * показывала «В фоне» с таймером — ожидание ответа читалось как «работает».
 */
describe('ChatProgressSheet — ждёт ответа', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  const progress = {
    tasks: [{ text: 'C2', status: 'in_progress' as const }],
    agents: [],
    shells: [{ id: 'v', command: 'npx vite --port 9123', status: 'running' as const }],
    processAlive: true,
  };

  it('ход кончился вопросом — «Ждёт вашего ответа» первым значком', () => {
    const html = renderSheet({ progress, awaiting: true });
    const awaitingAt = html.indexOf('Ждёт вашего ответа');
    expect(awaitingAt).toBeGreaterThan(-1);
    expect(awaitingAt).toBeLessThan(html.indexOf('Сделано'));
  });

  it('пока ход идёт — значка нет: вопроса ещё не задали', () => {
    const html = renderSheet({ progress, awaiting: true, isRunning: true });
    expect(html).not.toContain('Ждёт вашего ответа');
  });

  it('плана нет, а вопрос есть — полоса всё равно видна', () => {
    const html = renderSheet({ progress: { tasks: [], agents: [] }, awaiting: true });
    expect(html).toContain('Ждёт вашего ответа');
  });
});

/**
 * Чат чужого CLI (F-07): транскрипта Claude у него нет, прогресс из транскрипта пуст, и полоса
 * пряталась целиком — субагент qwen не был виден нигде, кроме карточки «Агенты». Дерево ядра —
 * единственное дерево такого чата, полоса считает его субагентов.
 */
describe('ChatProgressSheet — субагенты чата чужого CLI', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  const node = (nodeId: string, over: Partial<AgentNode> = {}): AgentNode => ({
    nodeId,
    parentId: SESSION,
    taskId: '019a0000-0000-7000-8000-000000000001',
    kind: 'subagent',
    status: 'running',
    stepId: null,
    unitId: null,
    sessionId: SESSION,
    model: null,
    background: true,
    startedAt: 1_000,
    endedAt: null,
    spend: { tokens: null, windowShare: null },
    counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
    signals: [],
    briefExcerpt: 'проверка субагента',
    returnExcerpt: null,
    ...over,
  });

  it('транскрипта нет, у ядра субагент — полоса видна и считает его', () => {
    const html = renderSheet({ chatId: CHAT, progress: { tasks: [], agents: [] } }, [
      node('call_q1'),
      node(SESSION, { kind: 'unit-session', parentId: null, briefExcerpt: null }),
    ]);
    expect(html).toContain('План агента');
    expect(html).toContain('Субагентов: 1');
  });

  it('ни плана, ни субагентов у ядра — полосы нет', () => {
    const html = renderSheet({ chatId: CHAT, progress: { tasks: [], agents: [] } }, [
      node(SESSION, { kind: 'unit-session', parentId: null, briefExcerpt: null }),
    ]);
    expect(html).toBe('');
  });
});
