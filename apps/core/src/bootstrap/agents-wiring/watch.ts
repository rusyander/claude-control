import type { BgItem } from '@agentdeck/contracts/core/agents';
import type { ProcessIdentity } from '../../platform/process-identity.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { releaseResource, type ReleaseDeps } from '../../conductor/services/release.ts';
import { parseRef, resourceRows } from '../../conductor/services/refs.ts';
import { openBgItems, type AgentsFold, type NodeAcc } from '../../journal/reduce/agents-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import {
  BG_HANG_AFTER_MS,
  hangStep,
  orphanPlan,
  orphanVerdict,
  type BgLiveness,
  type HangMark,
  type ReapOutcome,
} from '../../observer/background/index.ts';
import { signalDef } from '../../observer/catalog.ts';
import { judgeSignal } from '../../observer/judge.ts';
import type { FiredVerdict } from '../../observer/observer.types.ts';
import type { Fact } from '../../platform/os-kind.ts';
import { outputSize } from '../../platform/output-tail.ts';
import { listenersOfTree, type Listener } from '../../platform/resource-scan.ts';
import { writeObserverDecision } from '../observer-wiring/write.ts';
import type { AgentsWiringDeps } from './agents-wiring.types.ts';

/**
 * Сторож фона (этап 11, P148) над свёртками живых задач: открытая фоновая работа, чей владелец
 * кончился (сессия в конце, хост сессии мёртв, задача кончилась), — сирота. Живой процесс
 * снимается общим сносом ресурса (P90/P40: строка `process` той же личности или новая, снос,
 * чтение назад), работа закрывается (`bg.ended reaped|lost`), сигнал `bg-orphan` называет, что
 * снято, а что нет и почему. Владелец жив, а вывод стоит — `bg-hang`, только показ; работа, чьё
 * дерево процессов слушает порт, — сервер (`server`, ждёт запросов), не зависание. Решение
 * выносится один раз на ключ (`fold.decided` + свой набор этого ядра).
 */

type Liveness = Required<AgentsWiringDeps>['liveness'];

/**
 * Сколько после начала работы (`bg.started.startedAt` — время строки CLI, без него стенное время
 * записи) её pid ещё закрепляется.
 * Позже номер мог уйти к чужому процессу (работа кончилась, ОС отдала номер другому; ядро
 * перезапускалось) — такой не закрепляется: на конце владельца он назван, но не убит (P12).
 */
export const BG_PIN_WINDOW_MS = 60_000;

export interface BgWatch {
  /** Один проход по задаче (свёртка уже догнана). */
  sweepTask(task: LiveTask, fold: AgentsFold): Promise<void>;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createBgWatch(deps: {
  liveness: Liveness;
  note: AgentsWiringDeps['note'];
  now: () => number;
  hangAfterMs?: number;
  release?: ReleaseDeps;
  /** Слушающие порты дерева процесса; по умолчанию — снимок ОС (`listenersOfTree`). */
  listeners?: (root: ProcessIdentity) => Promise<Fact<Listener[]>>;
}): BgWatch {
  const pins = new Map<string, ProcessIdentity>();
  /** Работы, чей процесс закрепить уже нельзя: первый взгляд не нашёл номера или пришёл поздно. */
  const unpinnable = new Set<string>();
  const marks = new Map<string, HangMark>();
  const told = new Set<string>();
  /** Работы, чьё дерево процессов слушает порт: вид `server`, тишина вывода — не зависание. */
  const servers = new Set<string>();
  const hangAfter = deps.hangAfterMs ?? BG_HANG_AFTER_MS;
  const listeners = deps.listeners ?? ((root: ProcessIdentity) => listenersOfTree(root));

  /**
   * Слушает ли дерево процесса работы порт. Корень — закреплённая личность, без неё — нынешняя
   * личность номера: здесь только показ сигнала, не снос, поэтому чужой номер стоит лишь
   * пропущенного `bg-hang`. ОС не ответила — не сервер: сигнал показать, а не спрятать.
   */
  async function listensOnPort(item: BgItem): Promise<boolean> {
    if (item.pid === undefined) return false;
    let root = pins.get(item.itemId);
    if (!root) {
      const now = await deps.liveness.identityOf(item.pid);
      if (!('value' in now)) return false;
      root = now.value;
    }
    const ports = await listeners(root);
    return 'value' in ports && ports.value.length > 0;
  }

  /** Конец владельца работы; `null` — владелец жив. */
  async function ownerEnd(fold: AgentsFold, n: NodeAcc): Promise<string | null> {
    if (fold.taskEnded) return 'task ended';
    const sessionId = n.bg?.ownerChain.sessionId;
    const session = sessionId ? fold.sessions.get(sessionId) : undefined;
    if (!session) return null;
    if (session.ended) return `owner session ${session.sessionId} ended`;
    if (!session.host) return null;
    const host = await deps.liveness.isAlive(session.host);
    return host === 'dead' ? `session host ${session.host.pid} is dead` : null;
  }

  /**
   * Личность процесса работы: закреплена при живом владельце или взята из строки ресурса,
   * записанной ПОСЛЕ начала работы (снос этого сторожа до перезапуска ядра). Строка раньше начала
   * описывает другой процесс, которому ОС когда-то дала тот же номер.
   */
  function pinOf(task: LiveTask, n: NodeAcc, pid: number): ProcessIdentity | undefined {
    const itemId = n.nodeId;
    const pinned = pins.get(itemId);
    if (pinned) return pinned;
    for (const row of resourceRows(task)) {
      if (row.kind !== 'process' || row.seq <= n.startSeq) continue;
      const ref = parseRef(row.ref);
      if (ref?.pid === pid && typeof ref.start === 'string') {
        const id = { pid, start: ref.start };
        pins.set(itemId, id);
        return id;
      }
    }
    return undefined;
  }

  async function livenessOf(task: LiveTask, n: NodeAcc): Promise<BgLiveness> {
    const pid = n.bg?.pid;
    if (pid === undefined) return 'gone';
    const id = pinOf(task, n, pid);
    if (!id) {
      // Не закреплена: нет такого pid вовсе — ушёл; есть — чужой ли он, не знать.
      const now = await deps.liveness.identityOf(pid);
      return 'absent' in now ? 'gone' : 'unknown';
    }
    const live = await deps.liveness.isAlive(id);
    return live === 'alive' ? 'alive' : live === 'dead' ? 'gone' : 'unknown';
  }

  function judge(task: LiveTask, fold: AgentsFold, verdict: FiredVerdict, input: number): void {
    if (fold.decided.has(verdict.key) || told.has(`${task.taskId}:${verdict.key}`)) return;
    const def = signalDef(verdict.signal);
    if (!def) return;
    const decision = judgeSignal(verdict, def);
    if (!decision.fired) return;
    told.add(`${task.taskId}:${verdict.key}`);
    writeObserverDecision(task, verdict, decision, { inputs: [input] });
  }

  /** Строка процесса той же личности или новая — снос идёт общим путём ресурса. */
  function processRid(task: LiveTask, id: ProcessIdentity): string {
    for (const row of resourceRows(task)) {
      if (row.kind !== 'process') continue;
      const ref = parseRef(row.ref);
      if (ref?.pid === id.pid && ref.start === id.start) return row.rid;
    }
    const rid = newId();
    task.append({
      kind: 'resource.created',
      actor: 'core',
      data: {
        rid,
        kind: 'process',
        owner: 'session',
        release: 'step-end',
        ref: JSON.stringify({ pid: id.pid, start: id.start }),
      },
    });
    return rid;
  }

  async function reap(task: LiveTask, id: ProcessIdentity): Promise<ReapOutcome> {
    const rid = processRid(task, id);
    const out = await releaseResource(task, rid, deps.release);
    if ('verified' in out) return { reaped: true, rid };
    if ('leak' in out) return { reaped: false, why: `resource ${rid}: ${out.leak}` };
    return { reaped: false, why: `resource ${rid}: ${out.reason}` };
  }

  async function orphan(task: LiveTask, fold: AgentsFold, n: NodeAcc, end: string) {
    const item = n.bg;
    if (!item) return;
    const plan = orphanPlan(item, end, await livenessOf(task, n));
    if (plan.do === 'none') return;
    const close = (how: 'reaped' | 'lost', summary: string): void => {
      task.append({
        kind: 'bg.ended',
        actor: 'core',
        ...(item.ownerChain.sessionId ? { sessionId: item.ownerChain.sessionId } : {}),
        data: { itemId: item.itemId, how, endedAt: Date.now(), summary: summary.slice(0, 2000) },
      });
    };
    if (plan.do === 'close-lost') {
      close('lost', plan.reason);
      return;
    }
    const outcome: ReapOutcome =
      plan.do === 'reap'
        ? await reap(task, pins.get(item.itemId) as ProcessIdentity)
        : { reaped: false, why: plan.reason };
    judge(task, fold, orphanVerdict(item, plan.reason, outcome), n.startSeq);
    close(
      outcome.reaped ? 'reaped' : 'lost',
      outcome.reaped ? `reaped: ${plan.reason}` : `not reaped: ${outcome.why}`,
    );
  }

  return {
    async sweepTask(task, fold) {
      for (const n of openBgItems(fold)) {
        const item = n.bg;
        if (!item) continue;
        try {
          const end = await ownerEnd(fold, n);
          if (end !== null) {
            await orphan(task, fold, n, end);
            marks.delete(item.itemId);
            continue;
          }
          // Владелец жив: закрепить личность процесса, пока pid ещё точно его, — только при
          // первом взгляде на молодую работу. Номера не было — работа ушла, и позже под ним
          // может оказаться только чужой процесс; взгляд поздний — то же.
          if (item.pid !== undefined && !pins.has(item.itemId) && !unpinnable.has(item.itemId)) {
            if (Date.now() - item.startedAt > BG_PIN_WINDOW_MS) unpinnable.add(item.itemId);
            else {
              const id = await deps.liveness.identityOf(item.pid);
              if ('value' in id) pins.set(item.itemId, id.value);
              else if ('absent' in id) unpinnable.add(item.itemId);
            }
          }
          if (!item.outputFile) continue;
          const kind = servers.has(item.itemId) ? 'server' : item.kind;
          const step = hangStep(
            { ...item, kind },
            marks.get(item.itemId),
            outputSize(item.outputFile),
            deps.now(),
            hangAfter,
          );
          if (step.mark) marks.set(item.itemId, step.mark);
          if (!step.verdict) continue;
          // Тишина дошла до предела: работа, чьё дерево слушает порт, — сервер (ждёт запросов,
          // молчит по природе), не зависание. Порты читаются только здесь — не на каждом обходе.
          if (await listensOnPort(item)) servers.add(item.itemId);
          else judge(task, fold, step.verdict, n.startSeq);
        } catch (error) {
          deps.note('agents.bg.failed', {
            taskId: task.taskId,
            itemId: item.itemId,
            reason: reasonOf(error),
          });
        }
      }
    },
  };
}
