import { readFileSync } from 'node:fs';
import { currentOs, reasonOf, type Fact, type NotApplicable, type OsKind } from './os-kind.ts';
import { runTool, type ToolRun } from './run-tool.ts';

/**
 * Предел открытых файлов (09 §limits): читается при старте ядра, ниже 4096 — предупреждение
 * в журнал. Ядро держит журналы, наблюдателей и каналы сессий разом; на macOS мягкий предел
 * по умолчанию 256 — десяток сессий упирается в EMFILE, а ошибка всплывает далеко от причины.
 * Linux — `/proc/self/limits` (свой процесс, без оболочки). macOS — `launchctl limit maxfiles`
 * (предел, который launchd даёт запущенным им процессам; свой процесс без оболочки не
 * прочитать — остаток назван). Windows: мягкого предела дескрипторов у процесса нет.
 */

export const LOW_OPEN_FILES = 4096;

export interface OpenFilesLimit {
  soft: number | 'unlimited';
  hard: number | 'unlimited';
  /** Мягкий предел ниже `LOW_OPEN_FILES` — предупредить. */
  low: boolean;
  source: 'proc-self-limits' | 'launchctl';
}

function limitValue(raw: string | undefined): number | 'unlimited' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'unlimited') return 'unlimited';
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function build(
  softRaw: string | undefined,
  hardRaw: string | undefined,
  source: OpenFilesLimit['source'],
): OpenFilesLimit | undefined {
  const soft = limitValue(softRaw);
  const hard = limitValue(hardRaw);
  if (soft === undefined || hard === undefined) return undefined;
  return { soft, hard, low: soft !== 'unlimited' && soft < LOW_OPEN_FILES, source };
}

/** `Max open files            1024                 1048576              files`. */
export function parseProcLimits(text: string): OpenFilesLimit | undefined {
  const match = /^Max open files\s+(\S+)\s+(\S+)/m.exec(text);
  return build(match?.[1], match?.[2], 'proc-self-limits');
}

/** `\tmaxfiles    256            unlimited      `. */
export function parseLaunchctlMaxfiles(text: string): OpenFilesLimit | undefined {
  const match = /^\s*maxfiles\s+(\S+)\s+(\S+)/m.exec(text);
  return build(match?.[1], match?.[2], 'launchctl');
}

export async function openFilesLimit(
  os: OsKind = currentOs(),
  run: (file: string, args: string[]) => Promise<ToolRun> = (file, args) =>
    runTool(file, args, { timeoutMs: 5_000 }),
): Promise<Fact<OpenFilesLimit> | NotApplicable> {
  if (os === 'win32') return { notApplicable: 'Windows: no per-process soft open-file limit' };
  if (os === 'linux') {
    try {
      const parsed = parseProcLimits(readFileSync('/proc/self/limits', 'utf8'));
      return parsed
        ? { value: parsed }
        : { unknown: 'no «Max open files» line in /proc/self/limits' };
    } catch (error) {
      return { unknown: reasonOf(error) };
    }
  }
  const result = await run('/bin/launchctl', ['limit', 'maxfiles']);
  if (!result.ok) return { unknown: `launchctl: ${result.reason}` };
  const parsed = parseLaunchctlMaxfiles(result.stdout);
  return parsed ? { value: parsed } : { unknown: 'no maxfiles line in launchctl output' };
}
