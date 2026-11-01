import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HealthReply, TrustedHopsHealth } from '@agentdeck/contracts/core/panel-api';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { CoreHopsNotice } from './CoreHopsNotice';

/**
 * Плашка P131: здоровье ядра без записанных звеньев — панель говорит словами, что команды пройдут
 * только с подписью телефона; звено записано или ядра нет — плашки нет.
 */

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const health = (trustedHops: TrustedHopsHealth | null): HealthReply => ({
  ok: true,
  build: 'b',
  bootId: 'boot',
  pid: 1,
  startedAt: 0,
  home: '/h',
  uptimeMs: 1,
  liveTasks: 0,
  queue: { commandsInFlight: 0, commandsPending: 0 },
  window: { routes: [] },
  journalLagMs: 0,
  trustedHops,
});

function render(reply: HealthReply | undefined): string {
  const client = new QueryClient();
  if (reply) client.setQueryData(queryKeys.core.health, reply);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CoreHopsNotice />
    </QueryClientProvider>,
  );
}

describe('core hops notice (P131)', () => {
  it('no hop recorded → the notice in words; a recorded hop or no health → nothing', () => {
    for (const hops of [null, { count: 0, recordedAt: 5 }, { count: 2, recordedAt: null }]) {
      const html = render(health(hops));
      expect(html).toContain('data-core-hops="unrecorded"');
      expect(html).toContain('Ядро ещё не знает эту панель');
    }
    expect(render(health({ count: 1, recordedAt: 5 }))).toBe('');
    expect(render(undefined)).toBe('');
  });
});
