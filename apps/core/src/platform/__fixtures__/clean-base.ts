import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Чистая база живого стенда. CLI в слое `on` ищет инструкции вверх от cwd до корня диска
 * (`CLAUDE.md`, `.claude/skills|agents`, `QWEN.md`, `AGENTS.md`…). Temp Windows лежит в профиле
 * человека (`C:\Users\<он>\AppData\Local\Temp`), и стенд под ним отдавал модели настоящий
 * `~/.claude/CLAUDE.md`, навыки и агентов человека как «проект» (ревью core-s2, F2): живой прогон
 * шёл со слоем человека, а не с тем, что положил тест. Стенд ставится туда, где над ним пусто.
 */

/** Что CLI подхватывает с предков cwd: Claude, Qwen, Gemini и общий `AGENTS.md`. */
export const INSTRUCTION_MARKERS = [
  '.claude',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.qwen',
  'QWEN.md',
  '.gemini',
  'GEMINI.md',
  'AGENTS.md',
  '.agents',
] as const;

/** Первый найденный файл инструкций в `dir` или над ним; `undefined` — над стендом пусто. */
export function humanAncestor(dir: string): string | undefined {
  // Настоящий путь: короткое имя 8.3 (`RUSYAN~1`) и ссылка ведут в тот же профиль.
  let at = existsSync(dir) ? realpathSync.native(dir) : dir;
  for (;;) {
    for (const name of INSTRUCTION_MARKERS) {
      const path = join(at, name);
      if (existsSync(path)) return path;
    }
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/**
 * Кандидаты по порядку: `AGENTDECK_LIVE_BASE`, заданный человеком, temp процесса, затем на
 * Windows общий `%ProgramData%\agentdeck-live` (вне профилей; создать каталог там может любой
 * пользователь). Первый чистый — база, иначе `undefined`: живой стенд откажет (`liveBase`), а не
 * пойдёт со слоем человека.
 */
export function cleanLiveParent(): string | undefined {
  const chosen = process.env.AGENTDECK_LIVE_BASE;
  const candidates = chosen ? [chosen, tmpdir()] : [tmpdir()];
  const programData = process.env.ProgramData;
  if (process.platform === 'win32' && programData)
    candidates.push(join(programData, 'agentdeck-live'));
  for (const candidate of candidates) {
    if (humanAncestor(candidate) !== undefined) continue;
    mkdirSync(candidate, { recursive: true });
    return candidate;
  }
  return undefined;
}

/**
 * База живого стенда: `preferred` (стенд для разбора красного), иначе `AGENTDECK_LIVE_BASE` (её
 * ставит `vitest.temp-sandbox.ts` в чистом месте и сносит в конце прогона), иначе temp. Над базой
 * нашёлся файл инструкций человека — отказ: CLI в слое `on` поднял бы его как «проект», и прогон
 * проверял бы не то.
 */
export function liveBase(preferred?: string): string {
  const base = preferred ?? process.env.AGENTDECK_LIVE_BASE ?? tmpdir();
  const found = humanAncestor(base);
  if (found !== undefined)
    throw new Error(
      `live stand base ${base} sits under ${found}: the CLI would load it as project instructions; ` +
        'set AGENTDECK_LIVE_BASE to a directory with no CLAUDE.md/.claude/AGENTS.md above it',
    );
  mkdirSync(base, { recursive: true });
  return base;
}
