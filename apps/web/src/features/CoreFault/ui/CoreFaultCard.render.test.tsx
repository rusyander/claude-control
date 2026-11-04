import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CoreProxyCode, CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { i18n } from '@shared/config/i18n';

/**
 * Карточка отказа ядра (этап 10): «не запущено» больше не просит набрать команду — при надзоре
 * это «поднимается», а сдавшийся надзор показывает выход, хвост журнала и «Перезапустить».
 * Запросы подменены: карточка судит по тому, что вернул надзор.
 */

let status: CoreSupervisorStatus | null | undefined;
vi.mock('../api/coreSupervisorApi', () => ({
  useCoreSupervisor: () => ({ data: status }),
  useRestartCore: () => ({ mutate: () => {}, isPending: false, isError: false }),
  useCoreAutostart: () => ({ mutate: () => {}, isPending: false, isError: false }),
}));

const { CoreFaultCard } = await import('./CoreFaultCard');

const supervised = (patch: Partial<CoreSupervisorStatus>): CoreSupervisorStatus => ({
  state: 'starting',
  pid: null,
  restarts: 0,
  lastExit: null,
  nextRetryAt: null,
  logTail: [],
  autostart: 'off',
  ...patch,
});

const render = (refusal: CoreProxyCode, next: CoreSupervisorStatus | null | undefined) => {
  status = next;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CoreFaultCard refusal={refusal} />
    </QueryClientProvider>,
  );
};

describe('core fault card', () => {
  it('supervised and no core: «starting», never a command to type', () => {
    const html = render('core-absent', supervised({ state: 'starting' }));
    expect(html).toContain('data-core-fault-view="starting"');
    expect(html).toContain(i18n.t('coreTimeline.refusal.core-starting.title'));
    expect(html).not.toContain('pnpm core');
    expect(html).not.toContain('data-core-fault-restart');
  });

  it('fault: exit code, masked log tail, «Restart» and the autostart switch', () => {
    const html = render(
      'core-fault',
      supervised({
        state: 'fault',
        restarts: 5,
        lastExit: { code: 3, signal: null, at: '2026-11-02T10:00:00.000Z' },
        logTail: ['Error: config.json is broken', 'key ••••••'],
      }),
    );
    expect(html).toContain('data-core-fault-view="fault"');
    expect(html).toContain(i18n.t('coreTimeline.fault.exitCode', { code: 3 }));
    expect(html).toContain('Error: config.json is broken\nkey ••••••');
    expect(html).toContain('data-core-fault-restart');
    expect(html).toContain(i18n.t('coreTimeline.fault.restart'));
    expect(html).toContain('data-core-autostart="off"');
  });

  it('exit unknown (Windows: the core is not the panel child) → no exit line, never «signal ?»', () => {
    const html = render(
      'core-fault',
      supervised({
        state: 'fault',
        lastExit: { code: null, signal: null, at: '2026-11-02T10:00:00.000Z' },
      }),
    );
    expect(html).not.toContain('data-core-fault-exit');
    expect(html).not.toContain('?');
  });

  it('killed by a signal → the signal is named', () => {
    const html = render(
      'core-fault',
      supervised({
        state: 'fault',
        lastExit: { code: null, signal: 'SIGKILL', at: '2026-11-02T10:00:00.000Z' },
      }),
    );
    expect(html).toContain(i18n.t('coreTimeline.fault.exitSignal', { signal: 'SIGKILL' }));
  });

  it('fault on an OS without autostart: no switch promised', () => {
    const html = render('core-fault', supervised({ state: 'fault', autostart: 'unsupported' }));
    expect(html).toContain('data-core-fault-restart');
    expect(html).not.toContain('data-core-autostart');
    expect(html).toContain(i18n.t('coreTimeline.fault.logEmpty'));
  });

  it('supervisor switched off and no core: the «not running» card, named by the switch', () => {
    const html = render('core-absent', null);
    expect(html).toContain('data-core-refusal="core-absent"');
    expect(html).toContain(i18n.t('coreTimeline.refusal.core-absent.text'));
    expect(html).not.toContain('pnpm core');
  });

  it('unproven core keeps its own card even under the supervisor', () => {
    const html = render('core-unverified', supervised({ state: 'up', pid: 7 }));
    expect(html).toContain('data-core-refusal="core-unverified"');
  });
});
