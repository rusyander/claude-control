import type { Fact } from '@agentdeck/contracts/core/facts';

/**
 * Ближайший предок-CLI процесса проверки (04:41-42, G5): проверка из сессии человека (CLI, не
 * запущенный ядром) встаёт в очередь псевдозадачей, чья личность — pid + время старта этого
 * предка. Чистая функция над цепочкой процессов: имена образов CLI приходят снаружи (реестр
 * переходников), здесь ни одного имени CLI (P108).
 *
 * Цепочка идёт по `ppid` вверх; родитель, стартовавший ПОЗЖЕ ребёнка, — чужой процесс на
 * переиспользованном pid (Windows отдаёт pid повторно), на нём цепочка обрывается, а не
 * продолжается в чужое дерево.
 */

export interface AncestorRow {
  pid: number;
  ppid: number;
  /** Личность старта ОС (строка таблицы процессов, сравнивается как есть). */
  start: string;
  /** Старт в мс эпохи; `NaN` — ОС не сказала (тогда порядок не доказан, цепочка обрывается). */
  startMs: number;
  /** Имя образа (`claude.exe`, `qwen`); нет — таблица его не читает, предок не опознаётся. */
  image?: string;
}

const MAX_DEPTH = 64;

/** Предки процесса `pid` от родителя вверх (сам процесс не входит). */
export function ancestryChain(rows: readonly AncestorRow[], pid: number): AncestorRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const chain: AncestorRow[] = [];
  const seen = new Set<number>([pid]);
  let child = byPid.get(pid);
  while (child && chain.length < MAX_DEPTH) {
    const parent = byPid.get(child.ppid);
    if (!parent || seen.has(parent.pid)) break;
    // Неизвестный старт — не «по порядку» (ревью B2r2-F04): неизвестное не становится
    // принадлежностью к дереву, цепочка на нём обрывается.
    const ordered =
      Number.isFinite(parent.startMs) &&
      Number.isFinite(child.startMs) &&
      parent.startMs <= child.startMs;
    if (!ordered) break;
    chain.push(parent);
    seen.add(parent.pid);
    child = parent;
  }
  return chain;
}

/**
 * Допуск сверки старта вызывающего: прокладка считает свой старт приближённо (`now − uptime`), а
 * таблица ОС на macOS и Linux знает его с точностью до секунды.
 */
export const CALLER_START_SLACK_MS = 3_000;

/**
 * Предки ВЫЗЫВАЮЩЕГО — только когда его строка таблицы совпала со стартом, который он назвал
 * (ревью B2r2-F04): иначе держатель токена захвата, назвав чужой pid, ставил бы проверку в очередь
 * чужой сессии, а переиспользованный pid вёл бы в чужое дерево. Нет строки — `absent`; старт не
 * сходится или неизвестен — `unknown` (проверка вне очереди, названа).
 */
export function callerAncestry(
  rows: readonly AncestorRow[],
  caller: { pid: number; pidStart: number },
  slackMs: number = CALLER_START_SLACK_MS,
): Fact<AncestorRow[]> {
  const own = rows.find((row) => row.pid === caller.pid);
  if (!own) return { absent: true };
  if (!Number.isFinite(own.startMs) || !Number.isFinite(caller.pidStart)) {
    return { unknown: `start of caller pid ${caller.pid} unknown` };
  }
  if (Math.abs(own.startMs - caller.pidStart) > slackMs) {
    return {
      unknown: `caller pid ${caller.pid} started at ${own.startMs}, the call names ${caller.pidStart}`,
    };
  }
  return { value: ancestryChain(rows, caller.pid) };
}

/** Имя образа без каталога, расширения `.exe` и регистра: `C:\x\Claude.EXE` → `claude`. */
export function imageKey(image: string): string {
  const base = image.replace(/\\/g, '/').split('/').pop() ?? image;
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/** Первый предок, чей образ — образ CLI; нет такого — `undefined` (проверка вне очереди, названа). */
export function nearestCliAncestor(
  chain: readonly AncestorRow[],
  images: readonly string[],
): AncestorRow | undefined {
  const wanted = new Set(images.map(imageKey));
  return chain.find((row) => row.image !== undefined && wanted.has(imageKey(row.image)));
}
