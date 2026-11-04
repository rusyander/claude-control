import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homeDir } from '../../platform/os-kind.ts';
import type { SessionSpec } from '../adapter.types.ts';
import {
  UUID_SHAPE,
  firstJsonLine,
  ownedAnswer,
  readHeadBytes,
  resumeRefusal,
  resumeSourceOf,
  rootMatches,
  writeCopy,
} from '../resume-store.ts';
import type { ResumeStage, TranscriptVerdict } from '../resume-store.types.ts';

/**
 * Хранилище разговоров Gemini CLI (0.66, `gemini --acp`, пробы 02–03.11 в контейнере и на Windows):
 * `<GEMINI_CLI_HOME>/.gemini/tmp/<метка>/chats/session-<время>-<id8>.jsonl`, первая строка
 * `{sessionId, projectHash, startTime, kind}`; `tmp/<метка>/.project_root` — корень проекта (на
 * Windows CLI пишет его в нижнем регистре), `projects.json` — `{projects: {<корень>: <метка>}}`.
 * Свой — файл, первая строка которого называет этот id, в каталоге метки, чей `.project_root` — этот
 * корень. Продолжение кладёт в дом сеанса ровно три вещи: этот файл на то же место, `.project_root`
 * метки и `projects.json` с одной строкой — проба: `session/load` по такой копии видит разговор.
 */

export const GEMINI_HOME_DIR = 'gemini-home';
/** Голова файла разговора: первая строка — метаданные, длиннее не бывает. */
const HEAD_BYTES = 64 * 1024;

interface GeminiChat {
  verdict: TranscriptVerdict;
  /** Только у `owned`: метка проекта, содержимое `.project_root`, имя и путь файла разговора. */
  slug?: string;
  projectRoot?: string;
  name?: string;
  file?: string;
}

/** Дом Gemini человека по пину; относительный CLI достроил бы от своего cwd — ядро не угадывает. */
export function geminiHumanHome(pin: Record<string, string>): string | null {
  const home = pin.GEMINI_CLI_HOME || homeDir(pin);
  return isAbsolute(home) ? home : null;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Разговор `id` в доме Gemini `home` (`root: null` — только наличие, суд `transcriptPresent`). */
export function findGeminiChat(home: string, root: string | null, id: string): GeminiChat {
  if (!UUID_SHAPE.test(id)) return { verdict: 'absent' };
  const tmp = join(home, '.gemini', 'tmp');
  let slugs: string[];
  try {
    slugs = readdirSync(tmp, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { verdict: 'absent' }
      : { verdict: 'unreadable' };
  }
  // Имя файла несёт первые 8 знаков id: головы читаются только у кандидатов.
  const tail = `-${id.slice(0, 8).toLowerCase()}.jsonl`;
  let seen = false;
  for (const slug of slugs) {
    const chats = join(tmp, slug, 'chats');
    let names: string[];
    try {
      names = readdirSync(chats).filter((name) => name.toLowerCase().endsWith(tail));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(chats, name);
      let head: Record<string, unknown> | null;
      try {
        head = firstJsonLine(readHeadBytes(file, HEAD_BYTES));
      } catch {
        return { verdict: 'unreadable' };
      }
      if (head?.sessionId !== id) continue;
      seen = true;
      const projectRoot = readText(join(tmp, slug, '.project_root'))?.trim() ?? '';
      if (!rootMatches(projectRoot, root)) continue;
      return { verdict: 'owned', slug, projectRoot, name, file };
    }
  }
  return { verdict: seen ? 'foreign' : 'absent' };
}

/** Разговор Gemini, начатый не ядром, — этого корня (этап 10; `CliAdapter.ownsTranscript`). */
export function geminiOwnsTranscript(
  pin: Record<string, string>,
  root: string,
  conversationId: string,
): boolean | undefined {
  const home = geminiHumanHome(pin);
  if (!home) return undefined;
  return ownedAnswer(findGeminiChat(home, root, conversationId).verdict);
}

/** Транскрипт кончившейся сессии ядра на месте — в доме Gemini её каталога (`transcriptPresent`). */
export function geminiTranscriptPresent(
  _pin: Record<string, string>,
  conversationId: string,
  sessionDir?: string,
): boolean | undefined {
  if (!sessionDir) return undefined;
  const verdict = findGeminiChat(join(sessionDir, GEMINI_HOME_DIR), null, conversationId).verdict;
  return verdict === 'unreadable' ? undefined : verdict === 'owned';
}

/** Перенос разговора в дом сеанса: файл разговора, `.project_root` метки и `projects.json`. */
export function geminiResume(spec: SessionSpec): ResumeStage {
  const id = spec.resume?.conversationId ?? '';
  const source = resumeSourceOf(spec, GEMINI_HOME_DIR);
  if (typeof source === 'string') return { ok: false, reason: source };
  const home = source.kind === 'core' ? source.home : geminiHumanHome(spec.env.pin);
  if (!home) return { ok: false, reason: resumeRefusal('gemini', 'unreadable', id) };
  const found = findGeminiChat(home, spec.cwd, id);
  const { slug, projectRoot, name, file } = found;
  if (found.verdict !== 'owned' || !slug || !projectRoot || !name || !file) {
    return { ok: false, reason: resumeRefusal('gemini', found.verdict, id) };
  }
  const target = join(spec.dir, GEMINI_HOME_DIR, '.gemini');
  return {
    ok: true,
    place: () => {
      writeCopy(join(target, 'tmp', slug, 'chats', name), readFileSync(file));
      writeCopy(join(target, 'tmp', slug, '.project_root'), projectRoot);
      // Корень — как его записал сам CLI: по этой строке он найдёт метку при `session/load`.
      writeCopy(
        join(target, 'projects.json'),
        JSON.stringify({ projects: { [projectRoot]: slug } }, null, 2),
      );
    },
  };
}
