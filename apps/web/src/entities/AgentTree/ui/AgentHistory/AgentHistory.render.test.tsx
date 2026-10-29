import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHistory } from '@agentdeck/contracts/agent-history';
import type { ProgressAgent } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { historyPollMs } from '../../api/agentTreeApi';
import { AgentHistorySessions } from './AgentHistorySessions';

/**
 * Левая колонка окна «История агентов»: что видит человек — все сессии новыми
 * первыми с номером от первой, стадию звена, главного агента и субагентов
 * каждой сессии; «идёт» прошлой сессии — оборван, а не работает.
 */
const agent = (agentId: string | undefined, over: Partial<ProgressAgent> = {}): ProgressAgent => ({
  id: `toolu_${agentId ?? 'x'}`,
  kind: 'general-purpose',
  description: `Агент ${agentId ?? 'без файла'}`,
  status: 'done',
  ...(agentId ? { agentId } : {}),
  ...over,
});

const history: AgentHistory = {
  agentCount: 3,
  live: { agents: 0, subagents: 0 },
  sessions: [
    {
      chatId: 's-fix',
      stage: 'fix',
      current: true,
      startedAt: '2026-10-26T10:00:00.000Z',
      endedAt: '2026-10-26T10:20:00.000Z',
      main: { toolCalls: 5, tokens: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 } },
      agents: [agent('f1', { status: 'running' })],
    },
    {
      chatId: 's-work',
      stage: 'work',
      startedAt: '2026-10-26T08:00:00.000Z',
      endedAt: '2026-10-26T09:30:00.000Z',
      main: {
        toolCalls: 12,
        model: 'claude-opus-4-1-20250805',
        anomalies: {
          denials: 2,
          errors: 1,
          repeatedReads: [{ path: '/a.ts', count: 3 }],
          largeResults: 1,
        },
      },
      anomalies: {
        w1: { denials: 0, errors: 4, repeatedReads: [], largeResults: 0 },
      },
      agents: [
        agent('w1', {
          status: 'running',
          model: 'claude-sonnet-4-6',
          toolCalls: 7,
          result: 'Выгрузка готова',
        }),
        agent(undefined),
      ],
    },
  ],
};

function render(over: Partial<Parameters<typeof AgentHistorySessions>[0]> = {}): string {
  return renderToStaticMarkup(
    <AgentHistorySessions
      history={history}
      isLoading={false}
      isRunning
      picked={undefined}
      onPick={() => undefined}
      {...over}
    />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('AgentHistorySessions — сессии разговора в окне «История агентов»', () => {
  it('новые первыми, номер от первой, стадия звена; «текущая» — только у текущей', () => {
    const html = render();
    const fix = html.indexOf('Сессия 2 · правки');
    const work = html.indexOf('Сессия 1 · работа');
    expect(fix).toBeGreaterThanOrEqual(0);
    expect(work).toBeGreaterThan(fix);
    expect(html.match(/текущая/g)).toHaveLength(1);
    expect(html.indexOf('текущая')).toBeLessThan(work);
  });

  it('главный агент одной строкой: вызовы, расход, модель без даты сборки', () => {
    const html = render();
    expect(html).toContain('Главный агент: 5 вызовов · 1.5k ток.');
    expect(html).toContain('Главный агент: 12 вызовов · opus-4-1');
  });

  it('субагенты прошлой сессии: модель, вызовы, итог; «идёт» там — оборван', () => {
    const html = render();
    expect(html).toContain('data-agent-history-agent="w1" data-agent-state="lost"');
    expect(html).toContain('general-purpose · sonnet-4-6 · 7 вызовов');
    expect(html).toContain('Выгрузка готова');
    expect(html).toContain('data-agent-history-agent="f1" data-agent-state="running"');
  });

  it('ход текущей сессии кончился — её фоновый субагент всё ещё «идёт», прошлой — оборван', () => {
    const html = render({ isRunning: false });
    expect(html).toContain('data-agent-history-agent="f1" data-agent-state="running"');
    expect(html).toContain('data-agent-history-agent="w1" data-agent-state="lost"');
  });

  it('выбранный субагент отмечен; без файла хода — кнопка выключена', () => {
    const html = render({ picked: { chatId: 's-work', agentId: 'w1' } });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-agent-history-agent="w1"/);
    expect(html).toMatch(/disabled=""[^>]*data-agent-history-agent="toolu_x"/);
  });

  it('главный агент каждой сессии — кнопка, открывающая его ход; выбранный отмечен', () => {
    const picks: Array<{ chatId: string; agentId: string }> = [];
    const html = render({
      picked: { chatId: 's-fix', agentId: 'main' },
      onPick: (p) => picks.push(p),
    });
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*data-agent-history-main="s-fix"/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*data-agent-history-main="s-work"/);
    expect(html).toContain('title="Открыть ход главного агента этой сессии"');
  });

  it('странности агента — строкой под ним: только ненулевые, повторные чтения с файлами в подсказке', () => {
    const html = render();
    expect(html).toContain(
      'отказов хуков 2 · ошибок 1 · повторных чтений 1 · результатов длиннее 10 000 символов 1',
    );
    expect(html).toContain('title="Прочитаны больше одного раза: /a.ts ×3"');
    expect(html).toContain('>ошибок 4<');
    expect(html.match(/data-agent-history-anomalies/g)).toHaveLength(2);
  });

  it('опрос истории: идёт разговор или кто-то работает — каждые 5 с; никого — молчим', () => {
    const idle = { ...history, live: { agents: 0, subagents: 0 } };
    expect(historyPollMs(false, idle)).toBe(false);
    expect(historyPollMs(false, undefined)).toBe(false);
    expect(historyPollMs(true, idle)).toBe(5000);
    // Фоновый субагент между ходами: прогона нет, а работающий есть.
    expect(historyPollMs(false, { ...history, live: { agents: 0, subagents: 1 } })).toBe(5000);
  });

  it('оборванные паузой — своей строкой «прервано паузой», не в «ошибок»', () => {
    const cut: AgentHistory = {
      ...history,
      sessions: [
        {
          ...history.sessions[0]!,
          main: {
            toolCalls: 3,
            anomalies: {
              denials: 0,
              errors: 0,
              interrupted: 2,
              repeatedReads: [],
              largeResults: 0,
            },
          },
        },
      ],
    };
    const html = render({ history: cut });
    expect(html).toContain('data-agent-history-interrupted');
    expect(html).toContain('прервано паузой 2');
    expect(html).not.toContain('ошибок');
  });

  it('старый сервер без отметок «сейчас» — окна «Сейчас» нет, «идёт» как раньше', () => {
    const html = render();
    expect(html).not.toContain('data-agent-history-now');
    expect(html).not.toContain('data-agent-history-session-live');
  });

  it('пустая история и чтение — свои строки', () => {
    expect(
      render({ history: { sessions: [], agentCount: 0, live: { agents: 0, subagents: 0 } } }),
    ).toContain('Сессий у этого чата пока нет');
    expect(render({ history: undefined, isLoading: true })).toContain('Читаю транскрипты сессий');
  });
});
