import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHistory, AgentHistorySession } from '@agentdeck/contracts/agent-history';
import type { ProgressAgent } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { historyAgentState, liveNow } from '../../model/agentHistory';
import { AgentHistorySessions } from './AgentHistorySessions';

/**
 * «Сейчас» вверху окна «История агентов»: кто работает прямо сейчас и чем
 * занят — по тем же отметкам сервера (`liveMain`, `liveAgents`), из которых
 * сложены числа «сейчас: N агент · M субагентов» у кнопки.
 */
const NOW = Date.parse('2026-10-27T12:00:00.000Z');

const agent = (id: string, over: Partial<ProgressAgent> = {}): ProgressAgent => ({
  id: `toolu_${id}`,
  agentId: id,
  kind: 'general-purpose',
  description: `Агент ${id}`,
  status: 'running',
  ...over,
});

const session = (over: Partial<AgentHistorySession>): AgentHistorySession => ({
  chatId: 's1',
  current: true,
  startedAt: '2026-10-27T11:00:00.000Z',
  endedAt: '2026-10-27T11:58:00.000Z',
  main: { toolCalls: 4, lastAction: 'Read: a.ts' },
  agents: [],
  liveMain: false,
  liveAgents: [],
  ...over,
});

const of = (sessions: AgentHistorySession[], agents = 0, subagents = 0): AgentHistory => ({
  sessions,
  agentCount: sessions.reduce((sum, s) => sum + s.agents.length, 0),
  live: { agents, subagents },
});

function render(history: AgentHistory): string {
  return renderToStaticMarkup(
    <AgentHistorySessions
      history={history}
      isLoading={false}
      isRunning
      picked={undefined}
      onPick={() => undefined}
    />,
  );
}

const text = (html: string): string => html.replace(/<[^>]+>/g, '');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await i18n.changeLanguage('ru');
});

afterAll(() => {
  vi.useRealTimers();
});

describe('AgentHistoryNow — кто работает сейчас', () => {
  it('главный работает: открытый вызов, с какого времени и сколько идёт; субагент — его вызов', () => {
    const live = session({
      liveMain: true,
      main: {
        toolCalls: 4,
        openTool: { name: 'Bash', summary: 'pnpm test', startedAt: '2026-10-27T11:57:30.000Z' },
      },
      agents: [
        agent('a1', { activity: { name: 'Grep', summary: 'liveOf' } }),
        agent('a2', { status: 'done' }),
      ],
      liveAgents: ['toolu_a1'],
    });
    const html = render(of([live], 1, 1));
    expect(html).toContain('data-agent-history-now="1:1"');
    expect(html).toContain('data-now-main="live"');
    expect(text(html)).toContain('Главный агент работает');
    expect(text(html)).toContain('Bash: pnpm test');
    expect(text(html)).toContain('идёт 2м 30с');
    expect(html).toContain('data-now-agent="a1"');
    expect(text(html)).toContain('Grep: liveOf');
    expect(html).not.toContain('data-now-agent="a2"');
    expect(html).not.toContain('data-now-no-subagents');
    expect(html).toContain('data-agent-history-session-live');
  });

  it('главный без открытого вызова — «пишет ответ» и последнее действие', () => {
    const html = render(of([session({ liveMain: true })], 1, 0));
    expect(text(html)).toContain('пишет ответ · последнее: Read: a.ts');
    expect(html).toContain('data-now-no-subagents');
    expect(text(html)).toContain('Субагентов сейчас нет');
  });

  it('никто не работает — главный «не работает», где встал, и прямо «субагентов нет»', () => {
    const html = render(of([session({})]));
    expect(html).toContain('data-agent-history-now="0:0"');
    expect(html).toContain('data-now-main="idle"');
    expect(text(html)).toContain('Главный агент не работает');
    expect(text(html)).toContain('последнее: Read: a.ts');
    expect(html).toContain('data-now-no-subagents');
    expect(html).not.toContain('data-agent-history-session-live');
  });

  it('«идёт» без отметки сервера — оборван, и в «Сейчас» его нет', () => {
    const quiet = session({ agents: [agent('q1')], liveAgents: [] });
    expect(historyAgentState(quiet.agents[0]!, quiet, true)).toBe('lost');
    const html = render(of([quiet]));
    expect(html).toContain('data-agent-history-agent="q1" data-agent-state="lost"');
    expect(html).not.toContain('data-now-agent="q1"');
  });

  it('живые из прошлых звеньев группы — тоже в «Сейчас», каждый со своей сессией', () => {
    const now = liveNow(
      of([
        session({ chatId: 'fix', liveMain: true }),
        session({
          chatId: 'work',
          current: false,
          agents: [agent('w1')],
          liveAgents: ['toolu_w1'],
        }),
      ]),
    );
    expect(now.mains.map((m) => m.session.chatId)).toEqual(['fix']);
    expect(now.agents.map((a) => `${a.session.chatId}:${a.agent.id}`)).toEqual(['work:toolu_w1']);
    expect(now.idle).toBeUndefined();
  });
});
