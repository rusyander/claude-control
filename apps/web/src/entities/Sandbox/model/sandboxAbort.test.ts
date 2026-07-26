import { describe, it, expect } from 'vitest';
import { createRunAbort } from './sandboxAbort';

/**
 * Регрессия: прогон песочницы не прерывался при уходе со страницы — соединение
 * оставалось открытым, сервер не получал `close` и не убивал временный Claude.
 * Плюс сопутствующая ошибка учёта: завершение прерванного прогона обнуляло
 * запись уже НОВОГО, после чего прервать живой прогон было нечем.
 */
describe('createRunAbort', () => {
  it('прерывает текущий прогон — уход со страницы закрывает соединение', () => {
    const aborter = createRunAbort();
    const run = aborter.start();

    aborter.abort();

    expect(run.signal.aborted).toBe(true);
  });

  it('новый запуск прерывает предыдущий', () => {
    const aborter = createRunAbort();
    const first = aborter.start();
    const second = aborter.start();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('завершение прерванного прогона не снимает учёт живого', () => {
    const aborter = createRunAbort();
    const first = aborter.start();
    const second = aborter.start();

    // `finally` прерванного выполняется уже после старта нового.
    aborter.finish(first);
    aborter.abort();

    expect(second.signal.aborted).toBe(true);
  });

  it('после завершения своего прогона прерывать нечего', () => {
    const aborter = createRunAbort();
    const run = aborter.start();

    aborter.finish(run);
    aborter.abort();

    // Прогон закончился сам — «остановить» его задним числом нельзя.
    expect(run.signal.aborted).toBe(false);
  });

  it('прерывание без прогона ничего не ломает', () => {
    const aborter = createRunAbort();
    expect(() => aborter.abort()).not.toThrow();
  });
});
