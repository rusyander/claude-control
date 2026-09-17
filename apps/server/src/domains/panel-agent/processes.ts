import { killPidTree } from '../../lib/process-tree.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  resolveCliPid,
  RunLedger,
  type ResolveCliPidDeps,
} from '../chat/run-ledger.ts';

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

  constructor(appDataDir: () => string, resolveDeps?: ResolveCliPidDeps) {
    // Каталог данных читается на каждую запись: он меняется на лету (`ctx.relocate`).
    this.ledger = () => new RunLedger(appDataDir(), PANEL_AGENT_PROCESS_LEDGER);
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
      this.ledger().upsert({ key, pid: cliPid, cwd, startedAt });
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
  kill?: (pid: number) => void;
}

/**
 * Старт панели: каждый живой процесс агента из журнала — сирота прошлого
 * процесса панели, его дерево снимается. Журнал очищается целиком. Возвращает,
 * сколько процессов убито.
 */
export function reapPanelAgentOrphans(appDataDir: string, deps: ReapDeps = {}): number {
  const ledger = new RunLedger(appDataDir, PANEL_AGENT_PROCESS_LEDGER);
  const entries = ledger.read();
  const { adopt: alive } = adoptableEntries(entries, {
    isAlive: deps.isAlive ?? isPidAlive,
    looksLikeCli: deps.looksLikeCli ?? pidLooksLikeCli,
  });
  const kill = deps.kill ?? ((pid: number) => killPidTree(pid));
  for (const entry of alive) kill(entry.pid as number);
  for (const entry of entries) ledger.remove(entry.key);
  return alive.length;
}
