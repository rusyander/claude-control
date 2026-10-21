import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DevRestartStatus } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';

/**
 * Плашка отложенного перезапуска (Ф11): ожидание автотестов и проверок
 * поломкой названо своим текстом, а не «ходами чатов». Хуки подменены.
 */

let status: DevRestartStatus = { pending: false };
vi.mock('@entities/DevRestart', () => ({
  useDevRestart: () => ({ data: status }),
  useRequestDevRestart: () => ({ mutate: () => {}, isPending: false }),
}));

const { DevRestartBanner } = await import('./DevRestartBanner');

const render = (next: DevRestartStatus): string => {
  status = next;
  return renderToStaticMarkup(<DevRestartBanner />);
};

describe('плашка отложенного перезапуска', () => {
  it('ждёт проверок проекта — свой текст', () => {
    const html = render({ pending: true, waitingFor: 'checks', files: ['apps/server/src/a.ts'] });
    expect(html).toContain('data-dev-restart="checks"');
    expect(html).toContain(i18n.t('devRestart.waitingChecks'));
    expect(html).not.toContain(i18n.t('devRestart.waitingRuns'));
  });

  it('несколько поводов — общий текст', () => {
    expect(render({ pending: true, waitingFor: 'both' })).toContain(
      i18n.t('devRestart.waitingBoth'),
    );
  });

  // D1 (21.10): ходы ждут до предела, плашка заранее называет время и ходы.
  it('предел ожидания ходов — время и ходы, которых перезапуск не дождётся', () => {
    const html = render({
      pending: true,
      waitingFor: 'runs',
      since: '2026-10-21T10:00:00.000Z',
      capAt: '2026-10-21T10:30:00.000Z',
      runs: ['feat-export-1a2b3c', 'fix-login-9f8e7d'],
    });
    expect(html).toContain('data-dev-restart-cap');
    expect(html).toContain('feat-export-1a2b3c, fix-login-9f8e7d');
    expect(html).toMatch(/\d{1,2}:30/);
  });

  it('без предела строки о нём нет', () => {
    expect(render({ pending: true, waitingFor: 'setup' })).not.toContain('data-dev-restart-cap');
  });
});
