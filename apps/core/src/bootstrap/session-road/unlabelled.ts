import { join } from 'node:path';
import { z } from 'zod';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { CONTAINER_CALLS_FILE, type ContainerCall } from '../../mcp/container-wrap.ts';
import { factReason, hasValue } from '../../platform/os-kind.ts';
import { TASK_LABEL } from '../../platform/resource-scan.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Журнал вызовов движка (`container-calls.jsonl`, G18) пишет обёртка ВНУТРИ дерева сессии — его
 * может дописать и сама сессия (P04). Поэтому строка — заявка, а не факт (ревью B2r4-F02,
 * B2r2-F01): движок — только тот, над которым ядро само поставило обёртку (из снимка ядра, не
 * из файла); id — слово id движка, не путь и не опция; id, существовавший до сессии (полный
 * список снимка ядра), — не ресурс задачи; id с меткой ДРУГОЙ задачи — не ресурс; метку не
 * прочитать — не взят, назван непрочитанным: утечка с причиной лучше снятого чужого.
 */

const ID = z.string().regex(/^[0-9a-f]{12,64}$/i);
const ENGINE = z.enum(['docker', 'podman']);
const CALL = z.discriminatedUnion('kind', [
  z.strictObject({
    v: z.literal(1),
    at: z.number(),
    engine: ENGINE,
    kind: z.literal('compose-project'),
    // Имя проекта compose: строчные, цифры, `_`/`-` (так его нормализует сам compose).
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    before: z.array(ID).nullable(),
  }),
  z.strictObject({
    v: z.literal(1),
    at: z.number(),
    engine: ENGINE,
    kind: z.literal('created-during'),
    containers: z.array(ID).nullable(),
    pods: z.array(ID).nullable(),
  }),
]);

/**
 * Строки журнала вызовов; непрочитанный файл — причина, отсутствующий — пусто. Строка не той
 * формы или с движком вне `engines` ядра — пропущена с причиной.
 */
export function readCalls(
  dir: string,
  engines: readonly string[],
  unread: string[],
): ContainerCall[] {
  const bytes = readBytesSync(join(dir, CONTAINER_CALLS_FILE));
  if ('absent' in bytes) return [];
  if (!hasValue(bytes)) {
    unread.push(`container calls: ${factReason(bytes)}`);
    return [];
  }
  const calls: ContainerCall[] = [];
  for (const line of bytes.value.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      unread.push('container calls: a torn line skipped');
      continue;
    }
    const engine = (doc as { engine?: unknown } | null)?.engine;
    if (typeof engine === 'string' && !engines.includes(engine)) {
      unread.push(`container calls: engine ${engine} not wrapped by the core`);
      continue;
    }
    const parsed = CALL.safeParse(doc);
    if (!parsed.success) {
      unread.push('container calls: a line of a foreign shape skipped');
      continue;
    }
    calls.push(parsed.data);
  }
  return calls;
}

/** Метка задачи на контейнере/поде: `null` — метки нет; не прочиталась — `unknown`. */
export type TaskLabelReader = (
  engine: string,
  id: string,
  pod: boolean,
) => Promise<Fact<string | null>>;

/**
 * Можно ли взять id из журнала вызовов как ресурс задачи `taskId`: не был до сессии и не помечен
 * другой задачей. Ответ — причина отказа или `undefined` (взять).
 */
export async function refusalOf(
  input: {
    engine: string;
    id: string;
    pod: boolean;
    taskId: string;
    /** Полный список движка до сессии (снимок ядра); `null`/нет — сравнить не с чем. */
    existed: readonly string[] | null | undefined;
  },
  labelOf: TaskLabelReader | undefined,
): Promise<string | undefined> {
  const what = `${input.engine} ${input.pod ? 'pod' : 'container'} ${input.id}`;
  if (!input.existed) return `${what}: list before the session unread — not taken`;
  // `ps -q` даёт короткий id, заявка может прийти полным: один и тот же контейнер — по префиксу.
  const id = input.id.toLowerCase();
  if (input.existed.some((e) => id.startsWith(e.toLowerCase()) || e.toLowerCase().startsWith(id))) {
    return `${what}: existed before the session — not taken`;
  }
  if (!labelOf) return `${what}: no label reader — not taken`;
  const label = await labelOf(input.engine, input.id, input.pod);
  if (!hasValue(label)) return `${what}: label unread (${factReason(label)}) — not taken`;
  if (label.value !== null && label.value !== input.taskId) {
    return `${what}: labelled ${TASK_LABEL}=${label.value} — another task's, not taken`;
  }
  return undefined;
}
