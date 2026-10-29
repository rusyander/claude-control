import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { nearestCliAncestor, type AncestorRow } from '../../adapters/cli-ancestry.ts';
import { openAppendLog } from '../../platform/safe-io/append-log.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import type { PseudoAnswer, PseudoRecord, PseudoTasks } from './pseudo-tasks.types.ts';

export type { PseudoAnswer, PseudoRecord, PseudoTasks } from './pseudo-tasks.types.ts';

/**
 * Псевдозадачи (04:41-42, G5): проверка из сессии CLI, которую запустил человек, а не ядро,
 * приходит с доступом захвата и встаёт в очередь под задачей, чья личность — ближайший предок-CLI
 * (pid + старт). Первый вопрос неизвестного предка выпускает UUIDv7; следующие вопросы того же
 * предка — та же задача, и после перезапуска ядра тоже (`pseudo.json` читается с диска).
 *
 * Каталог — `tasks/session-<id>/`: реестр задач берёт только каталоги-UUID, поэтому псевдозадача
 * не открывается как задача ядра. Внутри — `pseudo.json` и `capture.log` (строка на вопрос).
 * Это ПРОСТОЙ журнал дописыванием, не цепочка хешей журнала задачи — назван так в отчёте.
 * Нет предка-CLI или цепочка не прочитана — проверка идёт вне очереди, причина названа.
 */

export const PSEUDO_PREFIX = 'session-';
export const PSEUDO_FILE = 'pseudo.json';
export const PSEUDO_LOG = 'capture.log';

export interface PseudoTaskDeps {
  tasksDir: string;
  /** Цепочка предков процесса-звонящего (без него самого); непрочитанная — `unknown`. */
  ancestry(caller: { pid: number; pidStart: number }): Promise<Fact<AncestorRow[]>>;
  /** Образы CLI, чьи сессии становятся псевдозадачами (реестр переходников). */
  images(): readonly string[];
  newId(): string;
  now(): number;
}

function readRecord(dir: string): PseudoRecord | undefined {
  const bytes = readBytesSync(join(dir, PSEUDO_FILE));
  if (!('value' in bytes)) return undefined;
  try {
    const doc = JSON.parse(bytes.value.toString('utf8')) as PseudoRecord;
    return doc.v === 1 && typeof doc.taskId === 'string' ? doc : undefined;
  } catch {
    return undefined;
  }
}

export function createPseudoTasks(deps: PseudoTaskDeps): PseudoTasks {
  let known: Map<string, string> | undefined;
  const keyOf = (row: { pid: number; start: string }): string => `${row.pid}:${row.start}`;

  const load = (): Map<string, string> => {
    if (known) return known;
    known = new Map();
    const listed = listDir(deps.tasksDir);
    for (const name of 'value' in listed ? listed.value : []) {
      if (!name.startsWith(PSEUDO_PREFIX)) continue;
      const rec = readRecord(join(deps.tasksDir, name));
      if (rec) known.set(keyOf(rec.ancestor), rec.taskId);
    }
    return known;
  };

  const dirOf = (taskId: string): string => join(deps.tasksDir, `${PSEUDO_PREFIX}${taskId}`);

  return {
    async resolve(caller): Promise<PseudoAnswer> {
      const chain = await deps.ancestry(caller);
      if (!('value' in chain)) {
        const why = 'unknown' in chain ? chain.unknown : 'caller process not in the table';
        return { outside: `process ancestry unread (${why}): check runs outside the queue` };
      }
      const cli = nearestCliAncestor(chain.value, deps.images());
      if (!cli) return { outside: 'no CLI ancestor: check runs outside the queue' };
      const map = load();
      const found = map.get(keyOf(cli));
      if (found) return { taskId: found, created: false };
      const taskId = deps.newId();
      const record: PseudoRecord = {
        v: 1,
        taskId,
        ancestor: { pid: cli.pid, start: cli.start, ...(cli.image ? { image: cli.image } : {}) },
        createdAt: deps.now(),
      };
      writeFileAtomic(join(dirOf(taskId), PSEUDO_FILE), JSON.stringify(record));
      map.set(keyOf(cli), taskId);
      return { taskId, created: true };
    },
    note(taskId, data) {
      const log = openAppendLog(join(dirOf(taskId), PSEUDO_LOG));
      try {
        log.append(Buffer.from(`${JSON.stringify({ at: deps.now(), ...data })}\n`, 'utf8'));
      } finally {
        log.close();
      }
    },
    dirOf,
  };
}
