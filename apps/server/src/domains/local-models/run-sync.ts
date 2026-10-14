/**
 * Что панель делает с состоянием «идёт локальный прогон» (L4b), раз в несколько секунд:
 *   - запрет сна ОС держится, пока прогон идёт и выключатель включён, и снимается, когда нет;
 *   - перезапуск сервера, ждавший конца прогона (смена устройства, окна, «держать
 *     загруженной»), выполняется, когда прогонов не осталось.
 * Опрос, а не слушатели на каждый путь завершения (конец, стоп, обрыв, усыновление после
 * перезапуска): путей много, итог один — «сейчас идёт или нет».
 */

export interface RunSyncDeps {
  /** Идёт ли хоть один локальный прогон (Claude или чужой CLI). */
  active: () => boolean;
  /** Выключатель «не давать системе уснуть». */
  keepAwakeOn: () => boolean;
  awake: { sync: (wanted: boolean) => void };
  restart: { pending: () => boolean; apply: () => Promise<boolean> };
  log: (message: string, error?: unknown) => void;
}

export function createRunSync(deps: RunSyncDeps): () => void {
  let applying = false;
  return () => {
    const active = deps.active();
    deps.awake.sync(active && deps.keepAwakeOn());
    // Один перезапуск за раз: опрос не ждёт подъёма сервера и не должен запустить второй.
    if (active || applying || !deps.restart.pending()) return;
    applying = true;
    void deps.restart
      .apply()
      .catch((error: unknown) => deps.log('local models: deferred restart failed', error))
      .finally(() => {
        applying = false;
      });
  };
}
