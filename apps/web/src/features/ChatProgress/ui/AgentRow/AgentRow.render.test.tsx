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

  it('узел дерева: ARIA-уровень, остановка Tab, модель, вызовы, токены, время, последнее', () => {
    const done = {
      ...agent,
      agentId: 'a1e0',
      status: 'done' as const,
      model: 'claude-haiku-4-5-20251001',
      toolCalls: 3,
      tokens: { input: 1200, output: 300, cacheRead: 9000, cacheCreation: 0 },
      startedAt: '2026-10-14T15:36:13.000Z',
      endedAt: '2026-10-14T15:39:43.000Z',
      lastAction: 'Отчёты в src/reports/build.ts',
    };
    const html = renderToStaticMarkup(
      <AgentRow agent={done} isRunning={false} processAlive now={now} tree={tree} />,
    );
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="2"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-agent-node="a1e0"');
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('haiku-4-5 · 3 вызова · 10.5k ток. · за 3м 30с');
    expect(html).toContain('последнее: Отчёты в src/reports/build.ts');
  });

  it('идущий раскрытый: без кнопки остановки; остановленный — «остановлен»', () => {
    const running = { ...agent, agentId: 'a2e0', toolCalls: 1 };
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

  it('скиллы, хуки и MCP под метриками; с onExtensions — кнопка окна этого агента', () => {
    const used = {
      ...agent,
      status: 'done' as const,
      extensions: [
        { kind: 'skill' as const, name: 'deep-review', count: 1 },
        { kind: 'hook' as const, name: 'git-guard', count: 2 },
      ],
    };
    const plain = renderToStaticMarkup(
      <AgentRow agent={used} isRunning={false} processAlive now={now} tree={tree} />,
    );
    expect(plain).toContain('data-agent-extensions');
    expect(plain).toContain('deep-review');
    expect(plain).not.toContain('aria-label="Скиллы, хуки и MCP агента');
    const openable = renderToStaticMarkup(
      <AgentRow
        agent={used}
        isRunning={false}
        processAlive
        now={now}
        tree={{ ...tree, onExtensions: () => undefined }}
      />,
    );
    expect(openable).toContain('aria-label="Скиллы, хуки и MCP агента «Fetch MR !990»"');
    const none = renderToStaticMarkup(
      <AgentRow agent={{ ...agent, status: 'done' }} isRunning={false} now={now} />,
    );
    expect(none).not.toContain('data-agent-extensions');
  });
});
