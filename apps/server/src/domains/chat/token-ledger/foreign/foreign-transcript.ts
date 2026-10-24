import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { collectForeignFiles } from '../../../analytics/scanner/foreign.ts';
import type { ForeignTranscriptKind } from './foreign.types.ts';

/**
 * Где лежит переписка сессии чужого CLI. Каталоги-дома — те же, что читает
 * аналитика (`foreignHomes`): у Qwen их два (свой человека и `QWEN_HOME` набора).
 *
 * - Codex: `<дом>/sessions/ГГГГ/ММ/ДД/rollout-<время>-<сессия>.jsonl` (и `archived_sessions/`);
 * - Qwen Code: `<дом>/projects/<каталог проекта>/chats/<сессия>.jsonl` (и `chats/archive/`).
 */

/** Чью переписку читать по id провайдера; не Codex и не Qwen Code — переписки сторож не знает. */
export function foreignTranscriptKind(providerId: string): ForeignTranscriptKind | undefined {
  if (providerId === 'codex') return 'codex';
  return providerId === 'qwen' ? 'qwen' : undefined;
}

/**
 * Имя каталога проекта у Qwen Code: на Windows путь в нижнем регистре, затем
 * всё, кроме латиницы и цифр, — дефис (сверено с файлами qwen 0.24.3).
 */
export function qwenProjectSlug(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const base = platform === 'win32' ? cwd.toLowerCase() : cwd;
  return base.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Путь для сравнения: косые одинаково, на Windows без учёта регистра. */
function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const flat = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? flat.toLowerCase() : flat;
  };
  return norm(a) === norm(b);
}

/** Кусок чтения первой строки; предел строки — `FIRST_ROW_CAP`. */
const FIRST_ROW_CHUNK = 256 * 1024;
/**
 * Предел первой строки. `session_meta` Codex несёт полный текст инструкций
 * (`base_instructions`, у codex 0.155 — около 20 КБ, с набором и правилами
 * группы больше): обрезанная на 256 КБ строка не разбиралась, и сессию не
 * находили ни сторож, ни карточка.
 */
const FIRST_ROW_CAP = 4 * 1024 * 1024;

/** Первая строка файла (у Codex — `session_meta`, в ней проект сессии). */
function firstRow(path: string, cap = FIRST_ROW_CAP): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    const size = Math.min(statSync(path).size, cap);
    fd = openSync(path, 'r');
    const chunks: Buffer[] = [];
    let read = 0;
    let line: Buffer | undefined;
    // Строка читается кусками до перевода строки: короткая — одним куском.
    while (read < size) {
      const chunk = Buffer.alloc(Math.min(FIRST_ROW_CHUNK, size - read));
      const got = readSync(fd, chunk, 0, chunk.length, read);
      if (got <= 0) break;
      const end = chunk.subarray(0, got).indexOf(0x0a);
      chunks.push(chunk.subarray(0, end === -1 ? got : end));
      read += got;
      if (end !== -1) {
        line = Buffer.concat(chunks);
        break;
      }
    }
    const value: unknown = JSON.parse((line ?? Buffer.concat(chunks)).toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Проект сессии Codex — `cwd` из `session_meta`. */
function codexCwd(path: string): string | undefined {
  const payload = firstRow(path)?.payload;
  const cwd =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>).cwd : undefined;
  return typeof cwd === 'string' ? cwd : undefined;
}

/** Сессия Codex начата в каталоге `cwd`. */
function codexIn(path: string, cwd: string): boolean {
  const own = codexCwd(path);
  return own !== undefined && samePath(own, cwd);
}

/** Запас на часовой пояс: Codex называет каталоги по местной дате, граница считается по UTC. */
const DATE_SLACK_MS = 24 * 60 * 60_000;

/** Подкаталоги с именами из цифр (`ГГГГ`, `ММ`, `ДД`). */
function numberDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Файлы Codex, которые могли родиться не раньше `since`: только каталоги дат
 * `sessions/ГГГГ/ММ/ДД` от суток до `since` и позже, без `archived_sessions`
 * (свежую сессию Codex там не держит). Первый ход звена ищет файл на каждом
 * тике — обход всей истории Codex человека рос бы с ней (ревью W, ⚪ 8).
 */
function codexBornSince(
  homes: readonly string[],
  since: number,
): Array<{ path: string; mtimeMs: number }> {
  const floor = new Date(since - DATE_SLACK_MS).toISOString().slice(0, 10);
  const result: Array<{ path: string; mtimeMs: number }> = [];
  for (const home of new Set(homes)) {
    const root = join(home, 'sessions');
    for (const year of numberDirs(root)) {
      if (year < floor.slice(0, 4)) continue;
      for (const month of numberDirs(join(root, year))) {
        if (`${year}-${month}` < floor.slice(0, 7)) continue;
        for (const day of numberDirs(join(root, year, month))) {
          if (`${year}-${month}-${day}` < floor) continue;
          const dir = join(root, year, month, day);
          for (const name of jsonl(dir)) {
            if (!basename(name).startsWith('rollout-')) continue;
            try {
              const { mtimeMs } = statSync(name);
              if (mtimeMs >= since) result.push({ path: name, mtimeMs });
            } catch {
              // Файл исчез между чтением каталога и stat — не кандидат.
            }
          }
        }
      }
    }
  }
  return result;
}

/** Время первой записи файла, мс эпохи; нет — `undefined`. */
export function firstRecordAt(path: string): number | undefined {
  const stamp = firstRow(path)?.timestamp;
  const t = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

function qwenChats(homes: readonly string[], cwd: string): string[] {
  const slug = qwenProjectSlug(cwd);
  return [...new Set(homes)].flatMap((home) => {
    const chats = join(home, 'projects', slug, 'chats');
    return [chats, join(chats, 'archive')];
  });
}

/**
 * Файлы сессий Qwen Code в каталоге. Рядом с `<сессия>.jsonl` qwen 0.24 пишет
 * `<сессия>.ledger.jsonl` (состояние запроса, без времени и вызовов) и трогает
 * его последним — «самой свежей сессией» становился он, и сторож первого хода
 * читал пустой файл (живая проверка `check-foreign-group-watch`).
 */
function jsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.ledger.jsonl'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Файл сессии по её id. `cwd` сужает поиск у Qwen Code (каталог проекта);
 * без него — все проекты всех домов.
 */
export function findForeignTranscript(
  kind: ForeignTranscriptKind,
  homes: readonly string[],
  sessionId: string,
  cwd?: string,
): string | undefined {
  if (kind === 'qwen' && cwd) {
    for (const dir of qwenChats(homes, cwd)) {
      const path = join(dir, `${sessionId}.jsonl`);
      if (existsSync(path)) return path;
    }
  }
  const tail = kind === 'codex' ? `-${sessionId}.jsonl` : `${sessionId}.jsonl`;
  const found = collectForeignFiles({ kind, homes: [...homes] }, 0).find((file) =>
    kind === 'codex' ? basename(file.path).endsWith(tail) : basename(file.path) === tail,
  );
  return found?.path;
}

/**
 * Сессии CLI в каталоге проекта, тронутые не раньше `since`. Qwen Code держит
 * каталог на проект; Codex кладёт все сессии в один каталог по датам, и проект
 * берётся из первой строки файла (`session_meta`).
 */
export function foreignSessionsIn(
  kind: ForeignTranscriptKind,
  homes: readonly string[],
  cwd: string,
  since: number,
): Array<{ path: string; mtimeMs: number }> {
  if (kind === 'codex') {
    return collectForeignFiles({ kind, homes: [...homes] }, since).filter((file) =>
      codexIn(file.path, cwd),
    );
  }
  return qwenChats(homes, cwd)
    .flatMap(jsonl)
    .flatMap((path) => {
      try {
        const { mtimeMs } = statSync(path);
        return mtimeMs >= since ? [{ path, mtimeMs }] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Самый свежий файл сессии в каталоге проекта, начатый не раньше `since`:
 * первый ход звена идёт, а id сессии CLI сообщит только его конец. Звено
 * работает в своей копии — свежая сессия в её каталоге и есть его.
 */
export function newestForeignTranscript(
  kind: ForeignTranscriptKind,
  homes: readonly string[],
  cwd: string,
  since: number,
): string | undefined {
  let best: { path: string; mtimeMs: number } | undefined;
  const candidates =
    kind === 'codex'
      ? codexBornSince(homes, since).filter((file) => codexIn(file.path, cwd))
      : foreignSessionsIn(kind, homes, cwd, since);
  for (const file of candidates) {
    const born = firstRecordAt(file.path);
    if (born !== undefined && born < since) continue;
    if (!best || file.mtimeMs > best.mtimeMs) best = file;
  }
  return best?.path;
}
