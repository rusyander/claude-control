import {
  OPENCODE_PERMISSION_LEVELS,
  OPENCODE_PERMISSION_TOOLS,
  type OpencodePermissionLevel,
  type OpencodePermissionTool,
} from '@claude-control/contracts/vocabulary';
import { UnrecognizedFormatError } from './codex-toml.ts';

/**
 * Права OpenCode — ключ `permission` в `opencode.json` (OPENCODE-1).
 *
 * ФОРМАТ (по документации OpenCode):
 *
 * ```jsonc
 * {
 *   "$schema": "https://opencode.ai/config.json",
 *   "permission": {
 *     "edit": "deny",
 *     "bash": "ask",
 *     "webfetch": "allow"
 *   }
 * }
 * ```
 *
 * Значение уровня — РОВНО одно из `allow` | `deny` | `ask`. Задокументированные
 * инструменты — `edit`, `bash`, `webfetch`.
 *
 * РАСШИРЕННАЯ ФОРМА: вместо строки значением инструмента может быть ОБЪЕКТ
 * «шаблон команды → уровень», и документирована она для `bash`:
 *
 * ```jsonc
 * "bash": { "*": "ask", "git *": "allow", "git push *": "deny" }
 * ```
 *
 * ЧТО ПАНЕЛЬ ВЕДЁТ: три задокументированных инструмента — простым уровнем, и
 * дополнительно `bash` — картой шаблонов. ВСЁ ОСТАЛЬНОЕ внутри `permission`
 * (другие имена инструментов, расширенная форма у `edit`/`webfetch`, любые
 * незнакомые значения) СОХРАНЯЕТСЯ БАЙТ-В-БАЙТ по значению и показывается
 * только для чтения — панель такие записи не переписывает и не удаляет.
 *
 * ПЕРЕОПРЕДЕЛЕНИЯ ПРАВ НА УРОВНЕ АГЕНТА (`agent.<имя>.permission`) — ВНЕ ОБЛАСТИ
 * задачи: они лежат за пределами ключа `permission`, и раздел их не касается
 * вовсе (правится только сам ключ `permission`).
 *
 * FAIL-CLOSED: `permission` не объект → `UnrecognizedFormatError` (раздел только
 * для чтения, запись 422). Форматы не угадываем.
 */

/**
 * Уровни прав OpenCode (ровно три значения, без синонимов) и задокументированные
 * инструменты, у которых панель ведёт уровень. Оба набора — из общего словаря
 * контрактов: теми же значениями фронт рисует форму.
 */
export {
  OPENCODE_PERMISSION_LEVELS,
  OPENCODE_PERMISSION_TOOLS,
  type OpencodePermissionLevel,
  type OpencodePermissionTool,
};

/**
 * Инструменты, у которых задокументирована КАРТА ШАБЛОНОВ (команда → уровень) и
 * панель умеет её править. Расширенная форма документирована для `bash`.
 */
export const OPENCODE_PATTERN_TOOLS = ['bash'] as const;

/** Строка карты шаблонов: шаблон команды → уровень. */
export interface OpencodePatternRule {
  pattern: string;
  level: OpencodePermissionLevel;
}

/** Права одного инструмента: либо простой уровень, либо карта шаблонов. */
export interface OpencodeToolPermission {
  tool: OpencodePermissionTool;
  /** `level` — простая форма (строка), `patterns` — карта шаблонов (объект). */
  mode: 'level' | 'patterns';
  /** Уровень простой формы (задан при `mode: 'level'`). */
  level?: OpencodePermissionLevel;
  /** Карта шаблонов в порядке файла (задана при `mode: 'patterns'`). */
  patterns?: OpencodePatternRule[];
}

/** Запись внутри `permission`, которую панель не ведёт: показывается для чтения. */
export interface OpencodePreservedEntry {
  key: string;
  /** Значение в компактном JSON — только для показа (в файле оно не меняется). */
  value: string;
}

/** Разобранное состояние ключа `permission`. */
export interface OpencodePermissionState {
  /** Ключ `permission` присутствует в файле. */
  present: boolean;
  /** Инструменты, которые панель ведёт (только реально заданные в файле). */
  tools: OpencodeToolPermission[];
  /** Записи, которые панель НЕ ведёт — сохраняются как есть. */
  preserved: OpencodePreservedEntry[];
}

/** Максимальная длина показываемого значения сохранённой записи. */
const PRESERVED_VALUE_LIMIT = 200;

function isLevel(value: unknown): value is OpencodePermissionLevel {
  return (
    typeof value === 'string' &&
    OPENCODE_PERMISSION_LEVELS.includes(value as OpencodePermissionLevel)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Умеет ли панель править карту шаблонов у этого инструмента. */
export function supportsPatternMap(tool: string): boolean {
  return (OPENCODE_PATTERN_TOOLS as readonly string[]).includes(tool);
}

/** Компактное значение для показа сохранённой записи (обрезается по длине). */
function describeValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > PRESERVED_VALUE_LIMIT ? `${text.slice(0, PRESERVED_VALUE_LIMIT)}…` : text;
}

/**
 * Разобрать значение ключа `permission`.
 *
 * `undefined` → раздел не задан (ничего не ограничено: у OpenCode отсутствие
 * ключа означает поведение по умолчанию, панель его молча не пишет).
 * Не объект (строка, массив, число) → `UnrecognizedFormatError` (fail-closed).
 */
export function readOpencodePermission(raw: unknown): OpencodePermissionState {
  if (raw === undefined || raw === null) return { present: false, tools: [], preserved: [] };
  if (!isPlainObject(raw)) throw new UnrecognizedFormatError();

  const tools: OpencodeToolPermission[] = [];
  const preserved: OpencodePreservedEntry[] = [];

  for (const [key, value] of Object.entries(raw)) {
    const managed = (OPENCODE_PERMISSION_TOOLS as readonly string[]).includes(key);

    if (managed && isLevel(value)) {
      tools.push({ tool: key as OpencodePermissionTool, mode: 'level', level: value });
      continue;
    }

    // Расширенная форма ведётся только там, где она задокументирована (`bash`) и
    // где КАЖДОЕ значение — уровень. Иначе запись сохраняется только для чтения.
    if (managed && supportsPatternMap(key) && isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0 && entries.every(([, level]) => isLevel(level))) {
        tools.push({
          tool: key as OpencodePermissionTool,
          mode: 'patterns',
          patterns: entries.map(([pattern, level]) => ({
            pattern,
            level: level as OpencodePermissionLevel,
          })),
        });
        continue;
      }
    }

    preserved.push({ key, value: describeValue(value) });
  }

  return { present: true, tools, preserved };
}

/** Имена записей `permission`, которые панель НЕ ведёт (нельзя ни менять, ни удалять). */
export function preservedKeys(raw: unknown): Set<string> {
  return new Set(readOpencodePermission(raw).preserved.map((entry) => entry.key));
}

/**
 * Собрать новое значение `permission` из черновика.
 *
 * ПРАВИЛА:
 *  - порядок ключей исходного объекта сохраняется (копия + точечные правки);
 *  - инструмент из черновика записывается строкой (простая форма) или объектом
 *    шаблонов (расширенная);
 *  - ВЕДОМЫЙ инструмент, которого в черновике нет, УДАЛЯЕТСЯ (пользователь снял
 *    ограничение) — молчаливых дефолтов панель не пишет;
 *  - запись, которую панель не ведёт (чужой инструмент, непонятая форма),
 *    остаётся нетронутой; попытка переписать её черновиком → fail-closed
 *    (`UnrecognizedFormatError`, маршрут 422).
 */
export function applyOpencodePermission(
  raw: unknown,
  draft: OpencodeToolPermission[],
): Record<string, unknown> {
  const original = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(original)) throw new UnrecognizedFormatError();

  const keep = preservedKeys(original);
  const next: Record<string, unknown> = { ...original };

  for (const tool of OPENCODE_PERMISSION_TOOLS) {
    const entry = draft.find((item) => item.tool === tool);

    if (keep.has(tool)) {
      // Значение этого инструмента панель не понимает → не трогаем его вовсе.
      if (entry) throw new UnrecognizedFormatError();
      continue;
    }

    if (!entry) {
      delete next[tool];
      continue;
    }

    if (entry.mode === 'patterns') {
      if (!supportsPatternMap(tool) || !entry.patterns?.length) throw new UnrecognizedFormatError();
      const map: Record<string, OpencodePermissionLevel> = {};
      for (const rule of entry.patterns) map[rule.pattern] = rule.level;
      next[tool] = map;
      continue;
    }

    if (!entry.level) throw new UnrecognizedFormatError();
    next[tool] = entry.level;
  }

  return next;
}
