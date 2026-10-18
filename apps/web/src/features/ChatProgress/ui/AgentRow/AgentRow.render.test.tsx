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
});
