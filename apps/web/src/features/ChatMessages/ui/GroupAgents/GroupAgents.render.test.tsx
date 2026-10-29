import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentHistory } from '@agentdeck/contracts/agent-history';
import type { ChatProgress } from '@agentdeck/contracts';
import { chatKeys } from '@entities/Chat';
import { agentTreeKeys } from '@entities/AgentTree';
import { i18n } from '@shared/config/i18n';
import { GroupAgents } from './GroupAgents';

/**
 * Карточка группы в хабе: кнопка «История агентов» видна всегда, когда у чата
 * есть хоть одна сессия, — и тогда, когда в текущей сессии субагентов нет
 * (строка «Агенты» знает только текущую). Данные — в кэше запросов, как их
 * кладут хуки.
 */
/** Текст без разметки: числа в «сейчас: …» — отдельные span со своим цветом. */
const text = (html: string): string => html.replace(/<[^>]+>/g, '');

function render(progress: ChatProgress, history: AgentHistory | undefined): string {
  const client = new QueryClient();
  client.setQueryData(chatKeys.progress('g1'), progress);
  if (history) client.setQueryData(agentTreeKeys.history('g1'), history);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GroupAgents chatId="g1" group={{ isRunning: false }} onOpen={() => undefined} />
    </QueryClientProvider>,
  );
}

const session = (chatId: string, agents: number): AgentHistory['sessions'][number] => ({
  chatId,
  main: { toolCalls: 1 },
  agents: Array.from({ length: agents }, (_, index) => ({
    id: `t${chatId}${index}`,
    agentId: `a${chatId}${index}`,
    kind: 'general-purpose',
    description: `агент ${index}`,
    status: 'done' as const,
  })),
});

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('GroupAgents — кнопка истории агентов', () => {
  it('в текущей сессии субагентов нет, в прошлых есть — карточка показывает кнопку с общим числом', () => {
    const html = render(
      { tasks: [], agents: [] },
      {
        sessions: [session('g1', 0), session('old', 4)],
        agentCount: 4,
        live: { agents: 0, subagents: 0 },
      },
    );
    expect(html).toContain('data-agent-history-open="4"');
    expect(html).toContain('История агентов · 4');
    expect(html).not.toContain('Агенты:');
  });

  it('одна сессия без субагентов — кнопка всё равно есть', () => {
    const html = render(
      { tasks: [], agents: [] },
      { sessions: [session('g1', 0)], agentCount: 0, live: { agents: 0, subagents: 0 } },
    );
    expect(html).toContain('История агентов · 0');
  });

  it('сессий нет и агентов нет — карточка без строки агентов', () => {
    expect(
      render(
        { tasks: [], agents: [] },
        { sessions: [], agentCount: 0, live: { agents: 0, subagents: 0 } },
      ),
    ).toBe('');
    expect(render({ tasks: [], agents: [] }, undefined)).toBe('');
  });

  it('живая строка текущей сессии остаётся рядом с кнопкой', () => {
    const current = session('g1', 2).agents;
    const html = render(
      { tasks: [], agents: current },
      {
        sessions: [session('g1', 2), session('old', 3)],
        agentCount: 5,
        live: { agents: 1, subagents: 2 },
      },
    );
    expect(html).toContain('Агенты:');
    expect(html).toContain('data-group-agent-jump="ag10"');
    expect(html).toContain('История агентов · 5');
    expect(html).toContain('data-agent-history-live="1:2"');
    expect(text(html)).toContain('сейчас: 1 агент · 2 субагента');
    // Числа выделены: агенты — цветом «идёт», субагенты — акцентом.
    expect(html).toMatch(/class="[^"]*liveCountAgents[^"]*" data-live-count="agents">1</);
    expect(html).toMatch(/class="[^"]*liveCountSubagents[^"]*" data-live-count="subagents">2</);
  });

  it('никто не работает — приглушённое «никто не работает», а не пустота', () => {
    const html = render(
      { tasks: [], agents: [] },
      { sessions: [session('g1', 0)], agentCount: 0, live: { agents: 0, subagents: 0 } },
    );
    expect(html).toContain('data-agent-history-live="0:0"');
    expect(html).toContain('никто не работает');
    expect(html).not.toContain('сейчас:');
  });

  it('склонение: 5 агентов · 1 субагент, 0 агентов · 3 субагента', () => {
    const many = render(
      { tasks: [], agents: [] },
      { sessions: [session('g1', 0)], agentCount: 0, live: { agents: 5, subagents: 1 } },
    );
    expect(text(many)).toContain('сейчас: 5 агентов · 1 субагент');
    const subs = render(
      { tasks: [], agents: [] },
      { sessions: [session('g1', 0)], agentCount: 0, live: { agents: 0, subagents: 3 } },
    );
    expect(text(subs)).toContain('сейчас: 0 агентов · 3 субагента');
    // Ноль — приглушённо, без выделения; ненулевое рядом — выделено.
    expect(subs).toMatch(/class="[^"]*liveCount_[^"]*" data-live-count="agents">0</);
    expect(subs).not.toMatch(/liveCountAgents[^"]*" data-live-count="agents"/);
    expect(subs).toMatch(/liveCountSubagents[^"]*" data-live-count="subagents">3</);
  });
});
