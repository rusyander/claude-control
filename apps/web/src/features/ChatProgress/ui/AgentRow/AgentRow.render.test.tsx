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

  it('процесс закрылся: «оборван», без «писал»', () => {
    const html = renderToStaticMarkup(
      <AgentRow agent={agent} isRunning={false} processAlive={false} now={now} />,
    );
    expect(html).toContain('data-agent-view="lost"');
    expect(html).toContain('оборван: процесс разговора закрылся');
    expect(html).not.toContain('писал');
  });
});
