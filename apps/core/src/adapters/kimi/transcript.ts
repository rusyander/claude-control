import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homeDir } from '../../platform/os-kind.ts';
import type { SessionSpec } from '../adapter.types.ts';
import {
  ownedAnswer,
  resumeRefusal,
  resumeSourceOf,
  rootMatches,
  writeCopy,
} from '../resume-store.ts';
import type { ResumeStage, TranscriptVerdict } from '../resume-store.types.ts';

/**
 * Хранилище разговоров Kimi Code (2.4.1, `kimi acp`, проба 02.11 в контейнере): указатель
 * `<KIMI_CODE_HOME>/session_index.jsonl`, строки `{sessionId, sessionDir, workDir}`; каталог
 * разговора `sessions/wd_<имя>_<хеш>/<id>/` (id — `session_<uuid>`) (`state.json` `{id, cwd, …}`,
 * `agents/main/wire.jsonl`). Свой — строка указателя с этим id И `workDir` = корень, и `state.json`
 * каталога того же id и корня. Продолжение кладёт в дом сеанса каталог разговора на то же место и
 * указатель с одной его строкой. Каталог вне `sessions/` дома — не разговор этого дома: отказ.
 */

export const KIMI_HOME_DIR = 'kimi-home';
const INDEX = 'session_index.jsonl';
/** Id разговора Kimi — `session_<uuid>` (проба 02.11); он же имя каталога разговора. */
const KIMI_SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Указатель больше этого не читается целиком: чужой файл, не указатель разговоров. */
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

export interface KimiSession {
  verdict: TranscriptVerdict;
  /** Строка указателя, каталог разговора и его место от дома — только у `owned`. */
  row?: Record<string, unknown>;
  dir?: string;
  rel?: string;
}

/** Дом Kimi человека по пину; относительный CLI достроил бы от своего cwd — ядро не угадывает. */
export function kimiHumanHome(pin: Record<string, string>): string | null {
  const home = pin.KIMI_CODE_HOME || join(homeDir(pin), '.kimi-code');
  return isAbsolute(home) ? home : null;
}

/** Каталог строки указателя внутри `<дом>/sessions` (иначе `null`): ссылка наружу не идёт. */
function sessionDirOf(home: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const dir = resolve(home, value);
  const rel = relative(join(home, 'sessions'), dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return dir;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Разговор `id` в доме Kimi `home` (`root: null` — только наличие, суд `transcriptPresent`). */
export function findKimiSession(home: string, root: string | null, id: string): KimiSession {
  if (!KIMI_SESSION_ID.test(id)) return { verdict: 'absent' };
  let text: string;
  try {
    const index = join(home, INDEX);
    if (lstatSync(index).size > MAX_INDEX_BYTES) return { verdict: 'unreadable' };
    text = readFileSync(index, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { verdict: 'absent' }
      : { verdict: 'unreadable' };
  }
  let seen = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object' || row.sessionId !== id) continue;
    seen = true;
    const dir = sessionDirOf(home, row.sessionDir);
    if (!dir || !rootMatches(row.workDir, root)) continue;
    // Указатель — не доказательство: состояние каталога обязано назвать тот же id и корень.
    const state = readJson(join(dir, 'state.json'));
    if (state?.id !== id || !rootMatches(state.cwd, root)) continue;
    return { verdict: 'owned', row, dir, rel: relative(home, dir) };
  }
  return { verdict: seen ? 'foreign' : 'absent' };
}

/** Файлы каталога разговора (без ссылок): путь от каталога → содержимое. */
function filesOf(dir: string): { rel: string; data: Buffer }[] {
  const out: { rel: string; data: Buffer }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push({ rel: relative(dir, path), data: readFileSync(path) });
    }
  };
  walk(dir);
  return out;
}

/** Разговор Kimi, начатый не ядром, — этого корня (этап 10; `CliAdapter.ownsTranscript`). */
export function kimiOwnsTranscript(
  pin: Record<string, string>,
  root: string,
  conversationId: string,
): boolean | undefined {
  const home = kimiHumanHome(pin);
  if (!home) return undefined;
  return ownedAnswer(findKimiSession(home, root, conversationId).verdict);
}

/** Транскрипт кончившейся сессии ядра на месте — в доме Kimi её каталога (`transcriptPresent`). */
export function kimiTranscriptPresent(
  _pin: Record<string, string>,
  conversationId: string,
  sessionDir?: string,
): boolean | undefined {
  if (!sessionDir) return undefined;
  const verdict = findKimiSession(join(sessionDir, KIMI_HOME_DIR), null, conversationId).verdict;
  return verdict === 'unreadable' ? undefined : verdict === 'owned';
}

/** Перенос разговора в дом сеанса: его каталог на то же место и указатель с одной его строкой. */
export function kimiResume(spec: SessionSpec): ResumeStage {
  const id = spec.resume?.conversationId ?? '';
  const source = resumeSourceOf(spec, KIMI_HOME_DIR);
  if (typeof source === 'string') return { ok: false, reason: source };
  const home = source.kind === 'core' ? source.home : kimiHumanHome(spec.env.pin);
  if (!home) return { ok: false, reason: resumeRefusal('kimi', 'unreadable', id) };
  const found = findKimiSession(home, spec.cwd, id);
  if (found.verdict !== 'owned' || !found.row || !found.dir || !found.rel) {
    return { ok: false, reason: resumeRefusal('kimi', found.verdict, id) };
  }
  const { row, dir, rel } = found;
  const target = join(spec.dir, KIMI_HOME_DIR);
  return {
    ok: true,
    place: () => {
      for (const file of filesOf(dir)) writeCopy(join(target, rel, file.rel), file.data);
      // Абсолютный каталог в указателе — уже каталог копии; относительный остаётся как был.
      const sessionDir = isAbsolute(String(row.sessionDir)) ? join(target, rel) : row.sessionDir;
      writeCopy(join(target, INDEX), `${JSON.stringify({ ...row, sessionDir })}\n`);
    },
  };
}
