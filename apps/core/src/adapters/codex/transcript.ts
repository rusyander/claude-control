import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { homeDir } from '../../platform/os-kind.ts';
import type { SessionSpec } from '../adapter.types.ts';
import {
  firstJsonLine,
  ownedAnswer,
  readHeadBytes,
  resumeRefusal,
  resumeSourceOf,
  rootMatches,
  UUID_SHAPE,
  writeCopy,
} from '../resume-store.ts';
import type { ResumeStage, TranscriptVerdict } from '../resume-store.types.ts';

/**
 * Хранилище разговоров Codex (codex-cli 0.155.1, проба 02.11 на stub-model): файл разговора —
 * `<CODEX_HOME>/sessions/<ГГГГ>/<ММ>/<ДД>/rollout-<время>-<id нити>.jsonl`, первая строка —
 * `{type:"session_meta", payload:{id, cwd, …}}`. `thread/resume` в СВЕЖЕМ доме находит нить по одному
 * этому файлу (базы `state_*.sqlite` для этого не нужны — проба), поэтому продолжение кладёт в дом
 * сеанса только его. Id нити — UUID; иная форма — не имя файла, а попытка его подобрать.
 */

export const CODEX_HOME_DIR = 'codex-home';
/** Первая строка несёт и базовую инструкцию модели (десятки КБ): голова с запасом. */
const META_HEAD_BYTES = 1024 * 1024;
/** Глубина `sessions/ГГГГ/ММ/ДД`: глубже Codex не пишет, обход дальше не идёт. */
const MAX_DEPTH = 3;

export interface CodexRollout {
  verdict: TranscriptVerdict;
  /** Путь файла и его место от `sessions/` — только у `owned`. */
  file?: string;
  rel?: string;
}

/** Дом Codex человека по пину; относительный CLI достроил бы от своего cwd — ядро не угадывает. */
export function codexHumanHome(pin: Record<string, string>): string | null {
  const home = pin.CODEX_HOME || join(homeDir(pin), '.codex');
  return isAbsolute(home) ? home : null;
}

/** Файлы `rollout-*-<id>.jsonl` под `sessions/` (без ссылок, не глубже `ГГГГ/ММ/ДД`). */
function rolloutsOf(sessions: string, id: string): string[] {
  const suffix = `-${id}.jsonl`;
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
        found.push(path);
      }
    }
  };
  walk(sessions, 0);
  return found;
}

/**
 * Нить `id` в доме Codex `home`: свой — первая строка `session_meta` с этим же id и папкой `root`
 * (`root: null` — только наличие: суд `transcriptPresent` кончившейся сессии ядра).
 */
export function findCodexRollout(home: string, root: string | null, id: string): CodexRollout {
  if (!UUID_SHAPE.test(id)) return { verdict: 'absent' };
  const sessions = join(home, 'sessions');
  let files: string[];
  try {
    files = rolloutsOf(sessions, id);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { verdict: 'absent' }
      : { verdict: 'unreadable' };
  }
  if (files.length === 0) return { verdict: 'absent' };
  let unread = false;
  for (const file of files) {
    let meta: Record<string, unknown> | null;
    try {
      meta = firstJsonLine(readHeadBytes(file, META_HEAD_BYTES));
    } catch {
      unread = true;
      continue;
    }
    const payload =
      meta?.type === 'session_meta' && meta.payload && typeof meta.payload === 'object'
        ? (meta.payload as Record<string, unknown>)
        : null;
    // Имя файла — не доказательство: id внутри обязан совпасть (копия под чужим именем — чужая).
    if (payload?.id === id && rootMatches(payload.cwd, root)) {
      return { verdict: 'owned', file, rel: relative(sessions, file) };
    }
  }
  return { verdict: unread ? 'unreadable' : 'foreign' };
}

/** Разговор Codex, начатый не ядром, — этого корня (этап 10; `CliAdapter.ownsTranscript`). */
export function codexOwnsTranscript(
  pin: Record<string, string>,
  root: string,
  conversationId: string,
): boolean | undefined {
  const home = codexHumanHome(pin);
  if (!home) return undefined;
  return ownedAnswer(findCodexRollout(home, root, conversationId).verdict);
}

/** Транскрипт кончившейся сессии ядра на месте — в доме Codex её каталога (`transcriptPresent`). */
export function codexTranscriptPresent(
  _pin: Record<string, string>,
  conversationId: string,
  sessionDir?: string,
): boolean | undefined {
  if (!sessionDir) return undefined;
  const verdict = findCodexRollout(join(sessionDir, CODEX_HOME_DIR), null, conversationId).verdict;
  return verdict === 'unreadable' ? undefined : verdict === 'owned';
}

/** Перенос нити в дом сеанса: файл разговора — на то же место под `sessions/`, больше ничего. */
export function codexResume(spec: SessionSpec): ResumeStage {
  const id = spec.resume?.conversationId ?? '';
  const source = resumeSourceOf(spec, CODEX_HOME_DIR);
  if (typeof source === 'string') return { ok: false, reason: source };
  const home = source.kind === 'core' ? source.home : codexHumanHome(spec.env.pin);
  if (!home) return { ok: false, reason: resumeRefusal('codex', 'unreadable', id) };
  const found = findCodexRollout(home, spec.cwd, id);
  if (found.verdict !== 'owned' || !found.file || !found.rel) {
    return { ok: false, reason: resumeRefusal('codex', found.verdict, id) };
  }
  const { file, rel } = found;
  return {
    ok: true,
    place: () => writeCopy(join(spec.dir, CODEX_HOME_DIR, 'sessions', rel), readFileSync(file)),
  };
}
