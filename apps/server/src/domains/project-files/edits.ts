import { relativeToProject } from './paths.ts';

/**
 * Правки агента, вытащенные из транскрипта разговора, и восстановление текста
 * «до» по ним.
 *
 * Почему не git: git знает, что изменилось в рабочем дереве, но не знает, КТО
 * это сделал и в каком разговоре. Вопрос же стоит иначе — «что натворил агент
 * вот в этой переписке», — и ответ на него есть только в транскрипте. Заодно
 * это работает в каталоге, где git нет вовсе.
 *
 * Домен намеренно не знает про чат: на вход приходят записи транскрипта,
 * описанные СТРУКТУРНО (`TranscriptLike`). Тип чата сюда не импортируется — так
 * домен остаётся проверяемым в одиночку, а маршрут сам решает, откуда взять
 * записи.
 */

/** Запись транскрипта в той мере, в какой она нужна здесь. */
export interface TranscriptLike {
  message?: { content?: unknown } | undefined;
}

/** Одна замена: что было на что заменено в конкретном файле. */
export interface AgentEdit {
  /** Путь от корня проекта. */
  path: string;
  /** Прежний фрагмент. У `Write` не задан: инструмент его не передаёт. */
  before?: string;
  /** Новый фрагмент; у `Write` — всё содержимое файла. */
  after: string;
  /** `Edit` с `replace_all`: заменены все вхождения, а не одно. */
  replaceAll: boolean;
  /** Файл перезаписан целиком. */
  whole: boolean;
}

export interface CollectedEdits {
  /** Правки по файлам, в порядке появления в разговоре. */
  byFile: Map<string, AgentEdit[]>;
  /** Вызовы, которые к файлам проекта не привязались. */
  skipped: number;
}

/** Инструменты, которые меняют файл и раскрывают, чем именно. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * Собрать правки агента по файлам проекта.
 *
 * Ветки субагентов (`isSidechain`) не отсеиваются намеренно: их запустил тот же
 * разговор, и для человека это правки того же агента. Порядок сохраняется —
 * восстановление «до» без него невозможно.
 */
export function collectAgentEdits(root: string, records: Iterable<TranscriptLike>): CollectedEdits {
  const byFile = new Map<string, AgentEdit[]>();
  let skipped = 0;

  for (const call of toolCalls(records)) {
    const input = call.input;
    if (!isRecord(input)) continue;

    const filePath = input.file_path ?? input.notebook_path;
    if (typeof filePath !== 'string' || !filePath) {
      skipped += 1;
      continue;
    }

    const path = relativeToProject(root, filePath);
    // Файл вне проекта — не наше дело: агент правит и свои настройки, и чужие
    // каталоги, но показываем мы дерево ОДНОГО проекта.
    if (!path) {
      skipped += 1;
      continue;
    }

    const parsed = editsOf(call.name, input);
    if (parsed.length === 0) {
      skipped += 1;
      continue;
    }

    const list = byFile.get(path) ?? [];
    for (const edit of parsed) list.push({ ...edit, path });
    byFile.set(path, list);
  }

  return { byFile, skipped };
}

/** Разложить один вызов инструмента на замены. */
function editsOf(name: string, input: Record<string, unknown>): Omit<AgentEdit, 'path'>[] {
  if (name === 'Write') {
    const content = input.content;
    return typeof content === 'string' ? [{ after: content, replaceAll: false, whole: true }] : [];
  }

  if (name === 'MultiEdit') {
    const raw = input.edits;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => (isRecord(entry) ? singleEdit(entry) : []));
  }

  // NotebookEdit меняет ячейку блокнота, а не текст файла: положить его правку
  // на строки .ipynb честно нельзя, поэтому такой вызов идёт в «пропущено».
  if (name === 'NotebookEdit') return [];

  return singleEdit(input);
}

function singleEdit(input: Record<string, unknown>): Omit<AgentEdit, 'path'>[] {
  const before = input.old_string;
  const after = input.new_string;
  if (typeof before !== 'string' || typeof after !== 'string') return [];
  return [{ before, after, replaceAll: input.replace_all === true, whole: false }];
}

/** Вызовы файловых инструментов из записей транскрипта, по порядку. */
function* toolCalls(
  records: Iterable<TranscriptLike>,
): Generator<{ name: string; input: unknown }> {
  for (const record of records) {
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const name = block.name;
      if (typeof name === 'string' && EDIT_TOOLS.has(name)) yield { name, input: block.input };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface Baseline {
  /** Текст до правок агента; undefined — правок по файлу не было. */
  text?: string;
  kind: 'exact' | 'whole-file' | 'none';
  /** Правки, которых не нашлось в текущем тексте. */
  unmatched: number;
}

/**
 * Восстановить текст «до» обратной прокруткой правок по текущему содержимому.
 *
 * Идём с последней правки к первой и возвращаем `new_string` обратно в
 * `old_string`. Это единственный способ получить базу: снимка «до» никто не
 * делал, а сам файл на диске уже новый.
 *
 * Три честных ограничения, каждое видно наружу:
 *
 *  1. `Write` перезаписывает файл целиком и прежнего текста не передаёт. Дойдя
 *     до него, откатываться дальше некуда: база становится пустой, и весь файл
 *     показывается как новый (`whole-file`). Для файла, который агент и создал,
 *     это ровно правда.
 *  2. Фрагмент могли переписать уже после агента — тогда `new_string` в тексте
 *     не находится. Такая правка считается в `unmatched`, а не выдумывается:
 *     дифф выйдет неполным, и клиент об этом скажет.
 *  3. Удаление (`new_string` пустой) привязать не к чему: пустая строка есть в
 *     любом месте любого текста. Тоже `unmatched`.
 */
export function rebuildBaseline(current: string, edits: AgentEdit[]): Baseline {
  if (edits.length === 0) return { kind: 'none', unmatched: 0 };

  let text = current;
  let unmatched = 0;

  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (!edit) continue;

    if (edit.whole || edit.before === undefined) {
      // Дошли до перезаписи: всё, что было раньше, уже неизвестно.
      return { text: '', kind: 'whole-file', unmatched };
    }

    if (edit.after === '') {
      unmatched += 1;
      continue;
    }

    if (edit.replaceAll) {
      if (!text.includes(edit.after)) {
        unmatched += 1;
        continue;
      }
      text = text.split(edit.after).join(edit.before);
      continue;
    }

    const at = text.indexOf(edit.after);
    if (at < 0) {
      unmatched += 1;
      continue;
    }
    text = text.slice(0, at) + edit.before + text.slice(at + edit.after.length);
  }

  return { text, kind: 'exact', unmatched };
}
