import type { ChatEvent } from './chat-events.ts';
import { killPidTree } from '../../lib/process-tree.ts';
import { isPidAlive } from './run-ledger.ts';

/**
 * Прогон, усыновлённый после перезапуска панели: процесс CLI жив, а трубы к нему
 * нет — stdout умер вместе с прежним сервером, и заново его не открыть.
 *
 * Что от прогона остаётся: место в реестре (запросы прав находят разговор и
 * рисуют карточку), «Остановить» (дерево процесса валится по pid) и конец —
 * его определяем по жизни pid, опрашивая раз в `pollMs`. Чего не остаётся:
 * текста ответа и расхода прямо в потоке — но текст лежит в транскрипте, и на
 * конце прогона реестр дочитывает оттуда последний завершённый ход
 * (`ChatRunRegistry.finish`), так что продолжение и конвейер по нему заводятся.
 * Расход не восстанавливается: панель его не видела.
 */

/** Как часто спрашивать систему, жив ли процесс. */
export const DETACHED_POLL_MS = 5_000;

/** Заметки ленте: код — для перевода на вебе, текст — для клиента без словаря. */
export const ADOPTED_NOTICE =
  'Панель перезапускалась: прогон подхвачен без потока вывода. Ответ агента читается из транскрипта, запросы прав работают.';
export const DETACHED_DONE_NOTICE =
  'Процесс прогона завершился. Ответ панель дочитывает из транскрипта — по нему и решает, продолжать ли работу.';

export interface DetachedRunDeps {
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  pollMs?: number;
}

/**
 * Совпадает с `RunLike` реестра по форме, а не по `implements`: импорт типа из
 * реестра замкнул бы цикл (реестр создаёт этот прогон при усыновлении).
 */
export class DetachedRun {
  readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly kill: (pid: number) => void;
  private readonly pollMs: number;
  private readonly startedAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private resolve: (() => void) | undefined;

  constructor(pid: number, startedAt: number, deps: DetachedRunDeps = {}) {
    this.pid = pid;
    this.startedAt = startedAt;
    this.isAlive = deps.isAlive ?? isPidAlive;
    this.kill = deps.kill ?? ((target) => killPidTree(target));
    this.pollMs = deps.pollMs ?? DETACHED_POLL_MS;
  }

  start(_options: unknown, onEvent: (event: ChatEvent) => void): Promise<void> {
    onEvent({ kind: 'notice', code: 'adopted', text: ADOPTED_NOTICE });
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
      const finish = (): void => {
        this.clear();
        onEvent({ kind: 'notice', code: 'detachedDone', text: DETACHED_DONE_NOTICE });
        // Терминальное событие — как у настоящего прогона: по нему вкладка
        // закрывает ход. Цены нет: расход этого процесса панель не видела.
        onEvent({
          kind: 'done',
          costUsd: 0,
          durationMs: Math.max(0, Date.now() - this.startedAt),
          sessionId: '',
        });
        resolve();
      };
      this.timer = setInterval(() => {
        if (!this.isAlive(this.pid)) finish();
      }, this.pollMs);
      // Сторож не должен держать процесс сервера при выходе.
      this.timer.unref?.();
    });
  }

  /** «Остановить»: валим дерево по pid и закрываем прогон, не дожидаясь опроса. */
  stop(): void {
    this.clear();
    try {
      this.kill(this.pid);
    } catch {
      // Процесс уже умер — реестр всё равно закрывает прогон.
    }
    this.resolve?.();
    this.resolve = undefined;
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
