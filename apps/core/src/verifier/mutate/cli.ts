import { isAbsolute, resolve } from 'node:path';
import type { MutantOutcome } from '@agentdeck/contracts/core/records';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { MutateRefusal, type RunPlanOptions } from './mutate.types.ts';
import { parsePlan } from './plan.ts';
import { restoreActive, runPlan } from './run.ts';

/**
 * `index.ts mutate <plan.json> [--root <dir>] [--wait <сек>]` — мутанты ядра для всех зон (P07,
 * G6). Пути плана — от `--root` (по умолчанию cwd). Выход: 0 — все убиты; 1 — хоть один выжил,
 * не применился или без зелёной базы; 2 — отказ всего прогона (план, занятое дерево, файл не
 * вернулся). Ядро не грузится.
 */

export const MUTATE_USAGE =
  'usage: node --experimental-strip-types apps/core/src/index.ts mutate <plan.json> [--root <dir>] [--wait <sec>]';

export interface MutateCommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface MutateCommandDeps {
  /** Подмена опций прогона — только для тестов (раннер, ввод-вывод). */
  options?: Partial<RunPlanOptions>;
  cwd?: string;
}

interface ParsedArgs {
  plan: string;
  root: string;
  waitMs: number;
}

function parseArgs(argv: readonly string[], cwd: string): ParsedArgs | string {
  let plan: string | undefined;
  let root = cwd;
  let waitMs = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--root') {
      const next = argv[(i += 1)];
      if (!next) return '--root без каталога';
      root = isAbsolute(next) ? next : resolve(cwd, next);
    } else if (arg === '--wait') {
      const seconds = Number(argv[(i += 1)]);
      if (!Number.isFinite(seconds) || seconds < 0) return '--wait ждёт число секунд';
      waitMs = seconds * 1000;
    } else if (arg.startsWith('--')) return `неизвестный флаг ${arg}`;
    else if (plan === undefined) plan = isAbsolute(arg) ? arg : resolve(cwd, arg);
    else return `лишний аргумент ${arg}`;
  }
  if (plan === undefined) return 'нет файла плана';
  return { plan, root, waitMs };
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export async function runMutateCommand(
  argv: readonly string[],
  io: MutateCommandIo,
  deps: MutateCommandDeps = {},
): Promise<number> {
  const args = parseArgs(argv, deps.cwd ?? process.cwd());
  if (typeof args === 'string') {
    io.err(`mutate: ${args}`);
    io.err(MUTATE_USAGE);
    return 2;
  }
  // Сигнал посреди мутанта: файлы — назад синхронно, до выхода; невернувшиеся названы, журнал остаётся.
  const onSignal = (signal: string): void => {
    const stuck = restoreActive();
    if (stuck.length > 0) io.err(`mutate: ${signal}: НЕ ВЕРНУЛИСЬ ${stuck.join(', ')}`);
    process.exit(130);
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    const text = readBytesSync(args.plan);
    if (!('value' in text)) {
      io.err(
        `mutate: план ${args.plan} не читается: ${'unknown' in text ? text.unknown : 'нет файла'}`,
      );
      return 2;
    }
    const rows = parsePlan(text.value.toString('utf8'), args.plan);
    const results = await runPlan(rows, {
      root: args.root,
      waitMs: args.waitMs,
      progress: io.out,
      cmd: `agentdeck core mutate ${args.plan}`,
      // Команду запустил сам человек или агент в своём шелле: его окружение у него и так есть
      // (проход-одиночка ядра, например, — `AGENTDECK_CORE_ALONE=1` перед командой).
      env: process.env,
      ...deps.options,
    });
    const count = (o: MutantOutcome): number => results.filter((r) => r.outcome === o).length;
    io.out(
      `[mutate] ${results.length} planned · killed ${count('killed')} · survived ${count('survived')} · not-applied ${count('not-applied')} · baseline-red ${count('baseline-red')}`,
    );
    return count('killed') === results.length ? 0 : 1;
  } catch (error) {
    if (error instanceof MutateRefusal) {
      io.err(error.message);
      return 2;
    }
    throw error;
  } finally {
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}
