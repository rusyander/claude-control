import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptId, PromptOverride } from '@agentdeck/contracts/prompts';
import { PROMPT_MAX_BYTES } from '@agentdeck/contracts/prompts';
import { backupEntry, writeJsonFile, writeTextFile } from '../../lib/safe-io.ts';
import { builtinPromptSha, builtinPromptText, promptIds } from './catalog.ts';
import { PromptTooLongError } from './errors.ts';

/**
 * Правки промптов на диске: `<appData>/prompts/`.
 *
 * Текст лежит отдельным файлом `<id>.md`, а не строкой в `state.json`, ровно по
 * той причине, по которой встроенные тексты лежат файлами: промпт читают и
 * правят абзацами, и в состоянии панели он был бы одной длинной строкой с `\n`.
 * Рядом `index.json` — отметки о правках: отпечаток встроенного текста на момент
 * сохранения и дата.
 *
 * ДВА ФАЙЛА МОГУТ РАЗОЙТИСЬ, и чтение это переживает молча: текст без отметки —
 * правка с неизвестной базой (панель не станет утверждать, что встроенный текст
 * менялся), отметка без текста — мусор от прошлой жизни, её просто нет.
 * Обратное — падать на чтении каталога из-за битого json — стоило бы человеку
 * всего раздела настроек.
 */

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;

interface PromptIndexEntry {
  baseSha: string;
  updatedAt: string;
}

interface PromptIndex {
  version: number;
  entries: Record<string, PromptIndexEntry>;
}

export function promptsDir(appData: string): string {
  return join(appData, 'prompts');
}

function promptFile(appData: string, id: PromptId): string {
  return join(promptsDir(appData), `${id}.md`);
}

function readIndex(appData: string): PromptIndex {
  const path = join(promptsDir(appData), INDEX_FILE);
  if (!existsSync(path)) return { version: INDEX_VERSION, entries: {} };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const entries =
      typeof raw === 'object' && raw !== null && 'entries' in raw
        ? (raw as { entries?: unknown }).entries
        : undefined;
    return {
      version: INDEX_VERSION,
      entries:
        typeof entries === 'object' && entries !== null
          ? (entries as Record<string, PromptIndexEntry>)
          : {},
    };
  } catch {
    return { version: INDEX_VERSION, entries: {} };
  }
}

function writeIndex(appData: string, index: PromptIndex): void {
  mkdirSync(promptsDir(appData), { recursive: true });
  writeJsonFile(join(promptsDir(appData), INDEX_FILE), index);
}

/** Правка одного промпта или `undefined`, если её нет. */
export function readOverride(appData: string, id: PromptId): PromptOverride | undefined {
  const path = promptFile(appData, id);
  if (!existsSync(path)) return undefined;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  const entry = readIndex(appData).entries[id];
  return {
    id,
    text,
    baseSha: entry?.baseSha ?? '',
    updatedAt: entry?.updatedAt ?? '',
  };
}

/** Все правки — для архива переноса; порядок каталога, а не порядок файлов на диске. */
export function readOverrides(appData: string): PromptOverride[] {
  return promptIds()
    .map((id) => readOverride(appData, id))
    .filter((override): override is PromptOverride => Boolean(override));
}

/**
 * Сохранить правку. Текст, совпавший со встроенным, правкой НЕ становится:
 * «правка», которая ничего не меняет, оставляла бы карточку в состоянии
 * «изменён», а кнопку «Сбросить» — без работы.
 *
 * `at` приходит снаружи, чтобы тест не зависел от часов машины.
 */
export function writeOverride(
  appData: string,
  id: PromptId,
  text: string,
  at: string = new Date().toISOString(),
  backupDir?: string,
): PromptOverride | undefined {
  // Потолок стоит ЗДЕСЬ, в единственной двери записи, а не в маршруте: писателей
  // у правок двое — `PUT /api/prompts/:id` и разворот архива переноса, — и
  // проверка, известная одному, означала бы, что мегабайтный промпт въезжает
  // снимком и уезжает потом в КАЖДЫЙ запрос режима.
  if (Buffer.byteLength(text, 'utf8') > PROMPT_MAX_BYTES) {
    throw new PromptTooLongError(id);
  }

  if (text === builtinPromptText(id)) {
    clearOverride(appData, id, backupDir);
    return undefined;
  }

  mkdirSync(promptsDir(appData), { recursive: true });
  // Форма файла не сохраняется намеренно: промпт уезжает модели ровно теми
  // байтами, что пришли из панели, и подстроенный под прежний файл BOM или CRLF
  // оказался бы в тексте запроса.
  // Копия перед перезаписью — тем же каталогом копий, что у всех настроек
  // панели: страницу набранного текста стирает одно нажатие, а истории правок у
  // промптов нет по устройству («сохраняется последняя»).
  writeTextFile(promptFile(appData, id), text, {
    preserveForm: false,
    ...(backupDir ? { backupDir } : {}),
  });

  const baseSha = builtinPromptSha(id);
  const index = readIndex(appData);
  index.entries[id] = { baseSha, updatedAt: at };
  writeIndex(appData, index);

  return { id, text, baseSha, updatedAt: at };
}

/** Убрать правку: панель снова работает встроенным текстом. */
export function clearOverride(appData: string, id: PromptId, backupDir?: string): boolean {
  const path = promptFile(appData, id);
  const existed = existsSync(path);
  // Копия ДО удаления: «Сбросить к встроенному» необратим по замыслу, но
  // необратим не значит бесследен — иначе единственная копия текста человека
  // исчезает с одного нажатия.
  if (existed && backupDir) backupEntry(path, backupDir);
  if (existed) rmSync(path, { force: true });

  const index = readIndex(appData);
  if (index.entries[id]) {
    delete index.entries[id];
    writeIndex(appData, index);
  }
  return existed;
}
