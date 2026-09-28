import { describe, it, expect } from 'vitest';
import { LiveSession, type LiveLaunch } from './live-session.ts';
import type { LiveTransport, TransportHandlers, TransportOpener } from './live-transport.ts';

/**
 * Ревью 28.09 (F-145a, пробел теста): «Остановить», которое процесс не сняло
 * (`kill` транспорта вернул `'unconfirmed'` — номер нечем сверить), не должно
 * считать процесс отпущенным панелью. Он работает дальше, и если потом уйдёт
 * сам, держа фоновые задачи, — это обрыв фона (`lostBackground`), а не закрытие
 * панелью. Восстановление флага `released` в `LiveSession.kill` ни один тест не
 * держал: снятое, оно оставляло набор зелёным.
 *
 * Подменён только транспорт — граница процесса: строки CLI и его выход приходят
 * через те же обработчики, что у посредника.
 */
const LAUNCH: LiveLaunch = {
  command: 'claude',
  args: [],
  cwd: '.',
  env: {},
  shell: false,
  signature: 'sig',
};

function sessionOver(killResult: 'unconfirmed' | void): {
  session: LiveSession;
  cli: TransportHandlers;
} {
  const wires: { cli?: TransportHandlers } = {};
  const open: TransportOpener = (_launch, handlers) => {
    wires.cli = handlers;
    const transport: LiveTransport = {
      pid: 4242,
      write: () => {},
      end: () => {},
      kill: () => killResult,
      detach: () => {},
    };
    return transport;
  };
  const session = new LiveSession(LAUNCH, Date.now, open);
  // Агент держит одну фоновую задачу — ради неё процесс и живёт между ходами.
  const cli = wires.cli!;
  cli.line(
    JSON.stringify({
      type: 'system',
      subtype: 'background_tasks_changed',
      session_id: 's-1',
      tasks: [{ id: 'bg-1' }],
    }),
  );
  return { session, cli };
}

describe('LiveSession.kill без подтверждения и потерянный фон (F-145a)', () => {
  it('kill не подтверждён, затем процесс ушёл сам с фоном — это обрыв фона', () => {
    const { session, cli } = sessionOver('unconfirmed');
    expect(session.hasBackgroundWork).toBe(true);
    expect(session.kill()).toBe('unconfirmed');
    expect(session.alive).toBe(true);

    cli.close(1);
    expect(session.alive).toBe(false);
    expect(session.lostBackground).toBe(true);
  });

  it('kill подтверждён — процесс снят панелью, фон не числится потерянным', () => {
    const { session, cli } = sessionOver(undefined);
    expect(session.kill()).toBeUndefined();
    cli.close(1);
    expect(session.lostBackground).toBe(false);
  });
});
