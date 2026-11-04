import { readFileSync } from 'node:fs';
import type { FolderTrust } from '@agentdeck/contracts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';

/**
 * Доверяет ли Claude Code папке проекта (F-86) — для карточки «Локальный слой» ДО хода (s10 G14
 * p7): слой — содержимое репозитория, и ядро везёт его только в доверенную папку, иначе отказ
 * `session-carry-local-layer-needs-layer-on`. Решает ядро (`adapters/claude/trust.ts`); здесь та же
 * запись тем же порядком, только чтобы человек узнал заранее, а не после отказанного хода:
 * `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` → не доверяет; непустой `<каталог конфигурации>/.config.json`
 * CLI берёт первым, иначе `.claude.json`; `projects[<путь>].hasTrustDialogAccepted === true`.
 * Не прочлось или не той формы — `unknown`: карточка тогда молчит, отказ скажет ядро.
 */

const IGNORE_TRUST_VAR = 'CLAUDE_CODE_IGNORE_PERSISTED_TRUST';
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Read = { text: string } | { absent: true } | { unknown: true };

function readText(file: string): Read {
  try {
    return { text: readFileSync(file, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { absent: true } : { unknown: true };
  }
}

export function claudeFolderTrust(
  dir: string,
  files: { legacy: string; main: string },
  env: NodeJS.ProcessEnv = process.env,
): FolderTrust {
  const ignore = env[IGNORE_TRUST_VAR];
  if (ignore !== undefined && !FALSY.has(ignore.trim().toLowerCase())) return 'untrusted';
  const legacy = readText(files.legacy);
  if ('unknown' in legacy) return 'unknown';
  const read = 'text' in legacy && legacy.text.length > 0 ? legacy : readText(files.main);
  if ('unknown' in read) return 'unknown';
  if ('absent' in read) return 'untrusted';
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return 'unknown';
  }
  if (!isRecord(parsed)) return 'unknown';
  const projects = parsed.projects;
  if (projects === undefined) return 'untrusted';
  if (!isRecord(projects)) return 'unknown';
  const wanted = normalizeProjectPath(dir);
  for (const [path, entry] of Object.entries(projects)) {
    if (!isRecord(entry) || entry.hasTrustDialogAccepted !== true) continue;
    if (normalizeProjectPath(path) === wanted) return 'trusted';
  }
  return 'untrusted';
}
