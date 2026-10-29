import { join } from 'node:path';
import { homeDir } from '../../platform/os-kind.ts';
import { isAbsolutePath, samePath } from '../../platform/paths.ts';
import { readTextFact } from '../../platform/safe-io/files.ts';
import type { CliTrustRead } from '../sdk-stream/layer-run.ts';
import { claudeConfigDir } from './user-layer.ts';

/**
 * Запись доверия Claude Code к папке (F-86): глобальный конфиг CLI, `projects[<путь>]
 * .hasTrustDialogAccepted === true` (2.1.310: ключ — путь с прямыми косыми, регистр — как пришёл
 * cwd). Конфиг — `<CLAUDE_CONFIG_DIR | дом>/.claude.json`; старый `<каталог конфигурации>/
 * .config.json` CLI берёт первым, если он есть и не пуст. Ядро запись только читает, никогда не
 * пишет. Не прочлась или не той формы — `unknown` (F25), не «нет отметки».
 */

const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';
const GLOBAL_CONFIG = '.claude.json';
const LEGACY_CONFIG = '.config.json';
/** Человек велел CLI не верить сохранённому доверию — ядро тоже не верит. */
const IGNORE_TRUST_VAR = 'CLAUDE_CODE_IGNORE_PERSISTED_TRUST';
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Файлы глобального конфига в порядке CLI: старый `.config.json`, затем `.claude.json`. */
export function claudeGlobalConfigFiles(pin: Record<string, string>): {
  legacy: string;
  main: string;
} {
  return {
    legacy: join(claudeConfigDir(pin), LEGACY_CONFIG),
    main: join(pin[CONFIG_DIR_VAR] || homeDir(pin), GLOBAL_CONFIG),
  };
}

export async function claudeTrustMark(
  sourceRepo: string,
  pin: Record<string, string>,
): Promise<CliTrustRead> {
  const ignore = pin[IGNORE_TRUST_VAR];
  if (ignore !== undefined && !FALSY.has(ignore.trim().toLowerCase())) {
    return { trusted: false, detail: `${IGNORE_TRUST_VAR} is set: persisted trust is ignored` };
  }
  const files = claudeGlobalConfigFiles(pin);
  const legacy = await readTextFact(files.legacy);
  if ('unknown' in legacy) return { unknown: `${files.legacy}: ${legacy.unknown}` };
  const useLegacy = 'value' in legacy && legacy.value.length > 0;
  const file = useLegacy ? files.legacy : files.main;
  const read = useLegacy ? legacy : await readTextFact(files.main);
  if ('unknown' in read) return { unknown: `${file}: ${read.unknown}` };
  if (!('value' in read)) return { trusted: false, detail: `${file} is absent` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch {
    return { unknown: `${file}: not JSON` };
  }
  if (!isRecord(parsed)) return { unknown: `${file}: not an object` };
  const projects = parsed.projects;
  if (projects === undefined) return { trusted: false, detail: `${file} has no projects` };
  if (!isRecord(projects)) return { unknown: `${file}: projects is not an object` };
  for (const [path, entry] of Object.entries(projects)) {
    if (!isRecord(entry) || entry.hasTrustDialogAccepted !== true) continue;
    // Ключ не абсолютный — не путь CLI; от cwd ядра его не достраиваем.
    if (isAbsolutePath(path) && samePath(path, sourceRepo)) return { trusted: true };
  }
  return { trusted: false, detail: `${file} has no accepted trust for ${sourceRepo}` };
}
