import { join } from 'node:path';
import { CAPTURE_TOOLS, captureWrapperArgv } from '../../mcp/capture-wrap.ts';
import { CONTAINER_MODE, HOOK_MODE, MCP_RUN } from '../../mcp/main.ts';
import { windowsShortPath, writePathWrapper, writeShellWrapper } from '../../platform/exec-bit.ts';
import { resolveExecutable } from '../../platform/exec-resolve.ts';
import type { OsKind } from '../../platform/os-kind.ts';

/**
 * Файлы, которые дорога сессии ставит CLI (03 §Launcher, P105): хук ядра и обёртки PATH.
 * Каждый — через `writeExecutable`: 0755 явным `chmod` после записи и чтение режима назад, иначе
 * umask 077 или копия без бита дают файл, который CLI молча не запускает (хук не зовётся —
 * решения ядра нет). Отказ записи — отказ запуска, не сессия без хука.
 */

export const CORE_HOOK_FILE = 'core-hook';
export const WRAPPER_DIR = 'bin';
/**
 * Движки контейнеров, чьи `run`/`create` получают метку задачи (поиск в конце шага, P58);
 * `docker-compose` (v1) — проект задачи, как `docker compose` (G18).
 */
export const CONTAINER_ENGINES = ['docker', 'podman', 'docker-compose'] as const;

const dq = (value: string): string => `"${value}"`;

/**
 * Команда хука ядра. POSIX: обёртка `<dir>/core-hook` (путь без пробелов в доме ядра, кавычки
 * двойные — их берут и Claude, и Qwen). Windows: прямой вызов node в двойных кавычках — Git Bash
 * Claude и cmd понимают его одинаково, а исполняемость там задаёт расширение. Слово с пробелом
 * (node в `C:\Program Files\nodejs`, репозиторий в каталоге с пробелом) идёт коротким именем 8.3:
 * Qwen исполняет `cmd /d /s /c` без кавычек и слово с пробелом не берёт вовсе — сеанс отказан.
 */
export function coreHookCommand(
  dir: string,
  nodeArgv: readonly string[],
  os: OsKind,
  shorten: (path: string) => string | null = windowsShortPath,
): { ok: true; command: string } | { ok: false; reason: string } {
  const argv = [...nodeArgv, MCP_RUN, HOOK_MODE];
  if (os === 'win32') {
    const words = argv.map((word) => (/\s/.test(word) ? (shorten(word) ?? word) : word));
    return {
      ok: true,
      command: words.map((word, i) => (i === words.length - 1 ? word : dq(word))).join(' '),
    };
  }
  const file = join(dir, CORE_HOOK_FILE);
  const written = writeShellWrapper(file, argv, os);
  if (!written.ok) return { ok: false, reason: `core hook not installed: ${written.reason}` };
  return { ok: true, command: dq(file) };
}

/**
 * argv обёртки движка: node ядра исполняет `run.ts container` — разбор глобальных опций, метка
 * `run`/`create`, проект compose (`mcp/container-wrap.ts`). Настоящий argv движка и каталог
 * сессии (журнал вызовов без метки, G18) — одним словом base64url (ни пробелов, ни кавычек для
 * sh и cmd). Без каталога — прежний вид (массив argv).
 */
export function containerWrapperArgv(
  nodeArgv: readonly string[],
  engine: string,
  real: readonly string[],
  taskId: string,
  dir?: string,
): string[] {
  const spec = dir === undefined ? real : { real, dir };
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
  return [...nodeArgv, MCP_RUN, CONTAINER_MODE, engine, taskId, encoded];
}

export interface WrapperOutcome {
  /** Движки, получившие обёртку: их контейнеры ищутся в конце сессии. */
  engines: string[];
  /** Движок есть, обёртка не встала — его контейнеры не помечены (назван, не спрятан). */
  failed: { engine: string; reason: string }[];
}

/**
 * Обёртки движков в `<dir>/bin` — только для найденных в PATH сессии (без самой `bin`):
 * обёртка над отсутствующим движком ничего не пометит. Обёртка sh (POSIX, Git Bash) и на
 * Windows ещё `.cmd`; обе зовут один разбор в node ядра.
 */
export function installContainerWrappers(input: {
  dir: string;
  taskId: string;
  env: Record<string, string>;
  os: OsKind;
  nodeArgv: readonly string[];
}): WrapperOutcome {
  const out: WrapperOutcome = { engines: [], failed: [] };
  for (const engine of CONTAINER_ENGINES) {
    const found = resolveExecutable(engine, { env: input.env, os: input.os });
    if (!found.ok) continue;
    const argv = containerWrapperArgv(
      input.nodeArgv,
      engine,
      [found.file, ...found.prefix],
      input.taskId,
      input.dir,
    );
    const written = writePathWrapper(
      join(input.dir, WRAPPER_DIR, engine),
      argv,
      input.os,
      'containers of this session carry the task label (found and removed at task end)',
    );
    if (written.every((w) => w.ok)) out.engines.push(engine);
    else
      out.failed.push({
        engine,
        reason: written
          .map((w) => ('reason' in w ? w.reason : ''))
          .join(' ')
          .trim(),
      });
  }
  return out;
}

export interface CaptureWrapperOutcome {
  /** Инструменты проверок, получившие обёртку захвата (дорога `path-wrapper`). */
  tools: string[];
  /** Инструмент есть, обёртка не встала — его проверки идут мимо очереди (назван, не спрятан). */
  failed: { tool: string; reason: string }[];
}

/**
 * Обёртки захвата над инструментами проверок не на node (03:119) — только для найденных в PATH
 * сессии без самой `bin`: обёртка над отсутствующим инструментом сделала бы из «команды нет»
 * вопрос к ядру. Node прокладки — первое слово `nodeArgv` (флаги TS ей не нужны).
 */
export function installCaptureWrappers(input: {
  dir: string;
  env: Record<string, string>;
  os: OsKind;
  nodeArgv: readonly string[];
}): CaptureWrapperOutcome {
  const out: CaptureWrapperOutcome = { tools: [], failed: [] };
  const node = input.nodeArgv[0] ?? process.execPath;
  for (const entry of CAPTURE_TOOLS) {
    const found = resolveExecutable(entry.tool, { env: input.env, os: input.os });
    if (!found.ok) continue;
    const argv = captureWrapperArgv(node, {
      tool: entry.tool,
      real: [found.file, ...found.prefix],
      ask: entry.ask,
    });
    const written = writePathWrapper(
      join(input.dir, WRAPPER_DIR, entry.tool),
      argv,
      input.os,
      'check subcommands of this tool ask the core queue first (capture road path-wrapper)',
    );
    if (written.every((w) => w.ok)) out.tools.push(entry.tool);
    else
      out.failed.push({
        tool: entry.tool,
        reason: written
          .map((w) => ('reason' in w ? w.reason : ''))
          .join(' ')
          .trim(),
      });
  }
  return out;
}
