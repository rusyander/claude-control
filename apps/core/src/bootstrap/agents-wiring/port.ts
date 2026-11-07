import { join } from 'node:path';
import type { AgentNode, AgentNodeDetail } from '@agentdeck/contracts/core/agents';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AgentsPort } from '../../api/agents.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { MaskFn } from '../../journal/journal.types.ts';
import { maskData } from '../../journal/line.ts';
import { linesAfter } from '../../journal/read-view.ts';
import {
  AGENT_SLICE_KINDS,
  agentDetailOf,
  agentNodeOf,
  agentTreeOf,
  initAgentsFold,
  stepAgents,
  type AgentsFold,
} from '../../journal/reduce/agents-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { OUTPUT_TAIL_BYTES, readOutputTail } from '../../platform/output-tail.ts';
import type { FoldBook } from './folds.ts';

/** Узлов в ответе списка всех задач; больше — самые новые и `truncated`. */
export const AGENTS_LIST_MAX = 500;

/**
 * Порт API истории агентов (этап 11, P146-P147) над свёртками журнала. Хвост вывода фоновой
 * работы читается при показе через `platform` и маскируется той же маской, что журнал (P61), —
 * в журнал он не пишется. Выгрузка — строки среза журнала, замаскированные ещё раз при выдаче:
 * строка, легшая на диск до маски (старое ядро, правка руками), секрет наружу не несёт.
 */
export function createAgentsPort(deps: {
  registry: TaskRegistry;
  folds: FoldBook;
  mask: MaskFn;
}): AgentsPort {
  const { registry, folds, mask } = deps;
  const dirOf = (taskId: string): string => join(registry.tasksDir, taskId);

  const tailOf = (fold: AgentsFold, nodeId: string): AgentNodeDetail['outputTail'] => {
    const bg = fold.nodes.get(nodeId)?.bg;
    if (!bg?.outputFile) return null;
    // Работа кончилась (или вся задача) — последняя строка больше не допишется: отдаётся целой.
    const ended = bg.how !== undefined || fold.taskEnded;
    const tail = readOutputTail(bg.outputFile, OUTPUT_TAIL_BYTES, ended);
    if (!('text' in tail)) return null;
    return { text: mask(tail.text).text, truncated: tail.truncated };
  };

  const follow: AgentsPort['follow'] = (taskId, after, send) => {
    if (!registry.view(taskId)) return undefined;
    // Своя свёртка потока: кадр узла — его вид на строке кадра, а не на конце журнала.
    const fold = initAgentsFold(taskId);
    let done = false;
    let off: (() => void) | undefined;
    let unwatch: (() => void) | undefined;
    const stop = (): void => {
      done = true;
      off?.();
      off = undefined;
      unwatch?.();
      unwatch = undefined;
    };
    const push = (line: JournalLine): void => {
      if (done || line.seq <= fold.seq) return;
      for (const id of stepAgents(fold, line)) {
        const node = agentNodeOf(fold, id);
        if (node) send({ type: 'node', seq: line.seq, node });
      }
      if (line.kind === 'task.ended') {
        send({ type: 'end', seq: line.seq });
        stop();
      }
    };
    const fromFile = (beforeSeq = Number.POSITIVE_INFINITY): void => {
      for (const line of linesAfter(dirOf(taskId), taskId, fold.seq)) {
        if (done || line.seq >= beforeSeq) break;
        push(line);
      }
    };
    const lines = linesAfter(dirOf(taskId), taskId, 0);
    // Без курсора — снимок на конце файла; с курсором — строки до него молча, после — кадрами.
    const quietUpTo = after ?? Number.POSITIVE_INFINITY;
    for (const line of lines) {
      if (line.seq > quietUpTo) break;
      stepAgents(fold, line);
    }
    if (after === null) send({ type: 'snapshot', view: agentTreeOf(fold) });
    if (fold.taskEnded) {
      send({ type: 'end', seq: fold.seq });
      stop();
      return stop;
    }
    for (const line of lines) if (line.seq > fold.seq) push(line);
    if (done) return stop;
    const attach = (task: LiveTask): void => {
      off?.();
      off = task.subscribe((line) => {
        if (line.seq > fold.seq + 1) fromFile(line.seq);
        push(line);
      });
      fromFile();
    };
    unwatch = registry.watch(taskId, {
      live: attach,
      gone: () => {
        off?.();
        off = undefined;
      },
    });
    const live = registry.live(taskId);
    if (live) attach(live);
    return stop;
  };

  return {
    tree: (taskId, query) => {
      const fold = folds.of(taskId);
      return fold ? agentTreeOf(fold, query) : undefined;
    },
    node: (taskId, nodeId, page) => {
      const fold = folds.of(taskId);
      if (!fold) return undefined;
      return agentDetailOf(fold, nodeId, page, tailOf(fold, nodeId));
    },
    list: (query) => {
      const nodes: AgentNode[] = [];
      for (const summary of registry.list()) {
        const fold = folds.of(summary.taskId);
        if (!fold) continue;
        if (query.groupId && fold.groupId !== query.groupId) continue;
        // Новый чат зовётся первым сеансом ядра (`--session-id`): разговор — и id сеанса задачи.
        if (
          query.conversationId &&
          fold.conversationId !== query.conversationId &&
          !fold.sessions.has(query.conversationId)
        )
          continue;
        nodes.push(...agentTreeOf(fold, query).nodes);
      }
      nodes.sort((a, b) => b.startedAt - a.startedAt);
      return { nodes: nodes.slice(0, AGENTS_LIST_MAX), truncated: nodes.length > AGENTS_LIST_MAX };
    },
    exportSlice: (taskId) => {
      if (!registry.view(taskId)) return undefined;
      const out: string[] = [];
      for (const line of linesAfter(dirOf(taskId), taskId, 0)) {
        if (!AGENT_SLICE_KINDS.includes(line.kind)) continue;
        out.push(JSON.stringify(maskData(line, mask).data));
      }
      return out.length > 0 ? `${out.join('\n')}\n` : '';
    },
    follow,
  };
}
