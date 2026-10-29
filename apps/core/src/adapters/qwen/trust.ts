import { dirname, join } from 'node:path';
import { isAbsolutePath, isInside, pathKey } from '../../platform/paths.ts';
import { readTextFact } from '../../platform/safe-io/files.ts';
import type { CliTrustRead } from '../sdk-stream/layer-run.ts';
import { qwenHome } from './read-layer.ts';

/**
 * Запись доверия Qwen Code к папкам (F-86; 0.24.3, `config/trustedFolders.ts`): JSON-объект
 * «путь → уровень» в `QWEN_CODE_TRUSTED_FOLDERS_PATH` или `<QWEN_HOME | ~/.qwen>/trustedFolders.json`.
 * `TRUST_FOLDER` доверяет папке и всему внутри, `TRUST_PARENT` — родителю записанного пути,
 * `DO_NOT_TRUST` — недоверие; решает самое глубокое совпавшее правило, при равной глубине —
 * недоверие. Ядро запись только читает. Не прочлась или не той формы — `unknown` (F25).
 */

const FILE_VAR = 'QWEN_CODE_TRUSTED_FOLDERS_PATH';
const HOME_VAR = 'QWEN_HOME';
const FILE = 'trustedFolders.json';

export const QWEN_TRUST_LEVELS = {
  folder: 'TRUST_FOLDER',
  parent: 'TRUST_PARENT',
  never: 'DO_NOT_TRUST',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Файл записи доверия, как его найдёт CLI с этим окружением; `null` — не определить. */
export function qwenTrustFile(pin: Record<string, string>): string | null {
  const direct = pin[FILE_VAR];
  if (direct) return isAbsolutePath(direct) ? direct : null;
  // Относительный дом CLI достроит от своего cwd — ядру он неизвестен.
  const home = qwenHome(pin);
  return home.absolute ? join(home.path, FILE) : null;
}

const depth = (path: string): number =>
  pathKey(path)
    .split(/[\\/]+/)
    .filter(Boolean).length;

/** Решение CLI по правилам записи для пути: `true`/`false` или `undefined` — правила нет. */
export function qwenTrustDecision(
  rules: Record<string, unknown>,
  location: string,
): boolean | undefined {
  let winner: { trusted: boolean; depth: number } | undefined;
  for (const [path, level] of Object.entries(rules)) {
    if (!isAbsolutePath(path)) continue;
    let root = path;
    let trusted: boolean;
    if (level === QWEN_TRUST_LEVELS.folder) trusted = true;
    else if (level === QWEN_TRUST_LEVELS.parent) {
      trusted = true;
      root = dirname(path);
    } else if (level === QWEN_TRUST_LEVELS.never) trusted = false;
    else continue;
    if (!isInside(root, location)) continue;
    const at = depth(root);
    if (!winner || at > winner.depth || (at === winner.depth && !trusted)) {
      winner = { trusted, depth: at };
    }
  }
  return winner?.trusted;
}

export async function qwenTrustMark(
  sourceRepo: string,
  pin: Record<string, string>,
): Promise<CliTrustRead> {
  const file = qwenTrustFile(pin);
  if (!file) return { unknown: `${FILE_VAR} or ${HOME_VAR} is not an absolute path` };
  const read = await readTextFact(file);
  if ('unknown' in read) return { unknown: `${file}: ${read.unknown}` };
  if (!('value' in read)) return { trusted: false, detail: `${file} is absent` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch {
    // CLI терпит комментарии JSONC; ядро их не разбирает — неизвестно, не «нет».
    return { unknown: `${file}: not plain JSON` };
  }
  if (!isRecord(parsed)) return { unknown: `${file}: not an object` };
  const decision = qwenTrustDecision(parsed, sourceRepo);
  if (decision === true) return { trusted: true };
  return {
    trusted: false,
    detail:
      decision === false
        ? `${file} marks ${sourceRepo} untrusted`
        : `${file} has no rule for ${sourceRepo}`,
  };
}
