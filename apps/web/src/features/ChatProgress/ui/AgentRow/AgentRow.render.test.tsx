import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { AgentRow } from './AgentRow';

/**
 * Строка субагента в «Кому раздана работа» (живой прогон 14.10): фоновый агент
 * между ходами должен называть себя фоновым и время последней записи, а умерший
 * вместе с процессом — «оборван», а не «работает».
 */
describe('AgentRow', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  const agent = {
    id: 'a',
    kind: 'lane-high',
    description: 'Fetch MR !990',
    status: 'running' as const,
    background: true,
    lastActivityAt: '2026-10-14T15:45:13.000Z',
  };
  const now = Date.parse('2026-10-14T15:48:13.000Z');

  it('жив между ходами: в фоне и «писал 3м 00с назад»', () => {
    const html = renderToStaticMarkup(
      <AgentRow agent={agent} isRunning={false} processAlive now={now} />,
    );
    expect(html).toContain('data-agent-view="running"');
    expect(html).toContain('в фоне');
    expect(html).toContain('писал 3м 00с назад');
  });

  it('живое ревью 18.10: идущий называет текущий вызов, его длительность и общее время', () => {
    const busy = {
      ...agent,
      startedAt: '2026-10-14T15:36:13.000Z',
      activity: { name: 'Bash', summary: 'Mustfail', startedAt: '2026-10-14T15:44:13.000Z' },
    };
    const html = renderToStaticMarkup(<AgentRow agent={busy} isRunning processAlive now={now} />);
    expect(html).toContain('в работе 12м 00с');
    expect(html).toContain('сейчас Bash: Mustfail — 4м 00с');
    expect(html).toContain('data-agent-activity="working"');
    expect(html).not.toContain('только ждёт');
  });

  it('сон или чтение фонового вывода помечены «только ждёт»', () => {
    const idle = {
      ...agent,
      activity: { name: 'Bash', summary: 'Wait', waiting: true },
    };
    const html = renderToStaticMarkup(<AgentRow agent={idle} isRunning processAlive now={now} />);
    expect(html).toContain('data-agent-activity="waiting"');
    expect(html).toContain('только ждёт');
  });

  it('у законченного текущего вызова и общего времени нет', () => {
    const done = {
      ...agent,
      status: 'done' as const,
      startedAt: '2026-10-14T15:36:13.000Z',
      activity: { name: 'Bash', summary: 'Mustfail' },
    };
    const html = renderToStaticMarkup(<AgentRow agent={done} isRunning processAlive now={now} />);
    expect(html).not.toContain('data-agent-activity');
    expect(html).not.toContain('в работе');
  });

  it('процесс закрылся: «оборван», без «писал»', () => {
    const html = renderToStaticMarkup(
      <AgentRow agent={agent} isRunning={false} processAlive={false} now={now} />,
    );
    expect(html).toContain('data-agent-view="lost"');
    expect(html).toContain('оборван: процесс разговора закрылся');
    expect(html).not.toContain('писал');
  });

  const tree = {
    level: 2,
    isTabStop: true,
    isSelected: false,
    onToggle: () => undefined,
    onOpen: () => undefined,
  };

  it('узел дерева: ARIA-уровень, остановка Tab, модель, вызовы, расход и время (факты ядра)', () => {
    const done = {
      ...agent,
      status: 'done' as const,
      model: 'claude-haiku-4-5-20251001',
      toolCalls: 3,
      spendTokens: 10_500,
      startedAt: '2026-10-14T15:36:13.000Z',
      endedAt: '2026-10-14T15:39:43.000Z',
    };
    const html = renderToStaticMarkup(
      <AgentRow agent={done} isRunning={false} processAlive now={now} tree={tree} />,
    );
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="2"');
    expect(html).toContain('tabindex="0"');
    // Адрес узла — id вызова Agent (узел ядра), не id субагента у CLI.
    expect(html).toContain('data-agent-node="a"');
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('haiku-4-5 · 3 вызова · 10.5k ток. · за 3м 30с');
  });

  it('расход ядру неизвестен — числа нет, ноль не рисуется', () => {
    const html = renderToStaticMarkup(
      <AgentRow
        agent={{ ...agent, status: 'done', model: 'claude-haiku-4-5', toolCalls: 0 }}
        isRunning={false}
        now={now}
        tree={tree}
      />,
    );
    expect(html).toContain('haiku-4-5 · 0 вызовов');
    expect(html).not.toContain('ток.');
  });

  it('идущий раскрытый: без кнопки остановки; остановленный — «остановлен»', () => {
    const running = { ...agent, toolCalls: 1 };
    const html = renderToStaticMarkup(
      <AgentRow
        agent={running}
        isRunning={false}
        processAlive
        now={now}
        tree={{ ...tree, expanded: true }}
      />,
    );
    expect(html).not.toContain('data-agent-stop');
    expect(html).toContain('aria-expanded="true"');
    const stopped = renderToStaticMarkup(
      <AgentRow
        agent={{ ...running, status: 'failed', stopped: true }}
        isRunning={false}
        processAlive
        now={now}
      />,
    );
    expect(stopped).toContain('data-agent-view="stopped"');
    expect(stopped).toContain('остановлен');
    expect(stopped).not.toContain('упал');
  });

  // Строка, которую знает только ядро (чат чужого CLI, вложенный субагент): имени агента из
  // транскрипта у неё нет, `kind` — код ядра. Прежде строка и чтение с экрана говорили сырое
  // «subagent», а без брифа подпись была «subagent:  — готово».
  it('строка только из ядра подписана словом языка интерфейса; без брифа подпись без пустого места', () => {
    const coreOnly = {
      id: 'q1',
      kind: 'subagent',
      coreKind: 'subagent' as const,
      description: '',
      status: 'done' as const,
    };
    const ru = renderToStaticMarkup(
      <AgentRow agent={coreOnly} isRunning={false} now={now} tree={tree} />,
    );
    expect(ru).toContain('aria-label="субагент — готово"');
    expect(ru).toMatch(/class="[^"]*kind[^"]*">субагент</);
    expect(ru).not.toContain('subagent');
    const briefed = renderToStaticMarkup(
      <AgentRow
        agent={{ ...coreOnly, description: 'Сверь подписи' }}
        isRunning={false}
        now={now}
        tree={tree}
      />,
    );
    expect(briefed).toContain('aria-label="субагент: Сверь подписи — готово"');
    // Строка транскрипта называет агента его именем — словарь её не трогает.
    const named = renderToStaticMarkup(
      <AgentRow agent={{ ...agent, status: 'done' }} isRunning={false} now={now} tree={tree} />,
    );
    expect(named).toContain('aria-label="lane-high: Fetch MR !990 — готово"');
  });

  it('en: строка только из ядра — «subagent» словарём английского интерфейса', async () => {
    await i18n.changeLanguage('en');
    try {
      const html = renderToStaticMarkup(
        <AgentRow
          agent={{
            id: 'q1',
            kind: 'background-shell',
            coreKind: 'background-shell' as const,
            description: '',
            status: 'done' as const,
          }}
          isRunning={false}
          now={now}
          tree={tree}
        />,
      );
      expect(html).toContain('aria-label="background command — done"');
    } finally {
      await i18n.changeLanguage('ru');
    }
  });
});
