import { killPidTree } from '../../../lib/process-tree/process-tree.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  resolveCliPid,
  RunLedger,
  type ResolveCliPidDeps,
} from '../../chat/run-ledger/run-ledger.ts';

/**
 * Процессы агента панели на диске — чтобы перезапуск панели не оставлял их жить.
 *
 * `node --watch` на Windows убивает сервер без обработчиков, а `claude` агента
 * с переходником живёт дальше сиротой: поднимает карточки на новом процессе
 * панели для разговора, чей поток уже закрыт, и тратит лимит впустую. Прогон
 * чата в такой ситуации усыновляется (`run-ledger.ts`), а ходу агента
 * усыновляться некуда — ответ читает только закрытый поток. Поэтому здесь
 * тот же журнал, но на старте живое УБИВАЕТСЯ, а не подхватывается.
 *
 * Свой файл, а не `runs.json`: иначе реестр чата принял бы ход агента за прогон
 * чата и показал бы его в списке идущих.
 */

export const PANEL_AGENT_PROCESS_LEDGER = 'panel-agent-runs.json';

export class PanelAgentProcesses {
  private readonly ledger: () => RunLedger;
  private readonly resolve: (pid: number) => Promise<number>;
  private readonly gone = new Set<string>();

  /**
   * `file` — свой журнал у каждого владельца процессов: тем же приёмом убираются
   * сироты агентского прогона тестов (`project-tests/runs.ts`).
   */
  constructor(
    appDataDir: () => string,
    resolveDeps?: ResolveCliPidDeps,
    file: string = PANEL_AGENT_PROCESS_LEDGER,
  ) {
    // Каталог данных читается на каждую запись: он меняется на лету (`ctx.relocate`).
    this.ledger = () => new RunLedger(appDataDir(), file);
    this.resolve = (pid) => resolveCliPid(pid, resolveDeps);
  }

  /**
   * Ход запущен. На Windows в журнал идёт pid самого CLI под оболочкой: оболочка
   * умирает вместе с сервером, и по её номеру сироту уже не найти.
   */
  started(key: string, pid: number, cwd: string): void {
    this.gone.delete(key);
    const startedAt = Date.now();
    this.ledger().upsert({ key, pid, cwd, startedAt });
    void this.resolve(pid).then((cliPid) => {
      // Процесс кончился, пока искали его номер, — запись уже снята, не воскрешаем.
      if (this.gone.has(key) || cliPid === pid) return;
      // Время — момента, когда CLI только что нашёлся живым: оно служит проверкой
      // «номер всё ещё наш» при уборке, а сам CLI создан позже `startedAt` оболочки.
      this.ledger().upsert({ key, pid: cliPid, cwd, startedAt: Date.now() });
    });
  }

  exited(key: string): void {
    this.gone.add(key);
    this.ledger().remove(key);
  }
}

export interface ReapDeps {
  isAlive?: (pid: number) => boolean;
  looksLikeCli?: (pid: number) => boolean;
  /**
   * Снять дерево. Список снятых номеров (`killPidTree`): пустой у живого номера
   * — «не снят». Замена, не вернувшая списка, считается снявшей.
   */
  kill?: (pid: number, startedAt: number) => unknown;
}

/**
 * Старт панели: каждый живой процесс агента из журнала — сирота прошлого
 * процесса панели, его дерево снимается. Журнал очищается — кроме живых
 * сирот, которых снять не вышло. Возвращает, сколько процессов снято.
 */
export function reapPanelAgentOrphans(
  appDataDir: string,
  deps: ReapDeps = {},
  file: string = PANEL_AGENT_PROCESS_LEDGER,
): number {
  const ledger = new RunLedger(appDataDir, file);
  const entries = ledger.read();
  const isAlive = deps.isAlive ?? isPidAlive;
  const { adopt: alive } = adoptableEntries(entries, {
    isAlive,
    looksLikeCli: deps.looksLikeCli ?? pidLooksLikeCli,
  });
  // `startedAt` записи — момент, когда номер точно был нашим: чужой процесс,
  // занявший номер позже, дерево не снимает.
  const kill =
    deps.kill ?? ((pid: number, startedAt: number) => killPidTree(pid, { spawnedAt: startedAt }));
  const kept = new Set<string>();
  for (const entry of alive) {
    const pid = entry.pid as number;
    const killed = kill(pid, entry.startedAt);
    // Ничего не снято, а номер жив: сверить его нечем (нет снимка процессов,
    // F-205) — вслепую не снимаем, но и запись не стираем: иначе сирота жила бы
    // дальше без присмотра, и следующий старт о ней уже не знал бы (F-145).
    // Номер, занятый чужим процессом, держит запись лишь пока тот жив и похож
    // на CLI — дальше её уберёт та же проверка `adoptableEntries`.
    if (Array.isArray(killed) && killed.length === 0 && isAlive(pid)) kept.add(entry.key);
  }
  for (const entry of entries) if (!kept.has(entry.key)) ledger.remove(entry.key);
  return alive.length - kept.size;
}
