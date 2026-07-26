/**
 * Проверка значений, которые уходят в аргументы командной строки.
 *
 * На Windows `claude` — это .cmd-обёртка, а запустить её без `shell` нельзя.
 * Оболочка же склеивает аргументы в одну строку и сама её разбирает, поэтому
 * всё, что пришло из запроса, становится частью команды: имени вида
 * `отчёт & calc &` достаточно, чтобы выполнился calc.
 *
 * Экранировать под cmd.exe надёжно не выходит — правила цитирования у него
 * свои и с подвохом. Поэтому значения не экранируются, а сверяются с белым
 * списком: что не подошло, до CLI просто не доходит.
 */

/** Идентификатор сессии Claude Code — UUID. */
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** Имя модели: claude-opus-4-8, claude-sonnet-5, иногда с суффиксом в скобках. */
const MODEL = /^[a-zA-Z0-9._[\]-]{1,64}$/;

/** Идентификатор плагина: имя, иногда с маркетплейсом через @ или /. */
const PLUGIN_ID = /^[a-zA-Z0-9._@/-]{1,200}$/;

/** Небезопасное значение отбрасывается: продолжить без него лучше, чем выполнить чужое. */
export function safeSessionId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return SESSION_ID.test(value) ? value : undefined;
}

export function safeModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return MODEL.test(value) ? value : undefined;
}

/** Уровень продумывания (--effort). Белый список — чужого в аргументы не пустим. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function safeEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return EFFORT_LEVELS.has(value) ? value : undefined;
}

/**
 * Имя чата — произвольный текст пользователя, белым списком его не описать.
 * Поэтому метасимволы оболочки заменяются пробелом: имя останется читаемым,
 * а командой стать не сможет.
 */
export function safeName(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const cleaned = value
    .replace(/[&|<>^"`$;\\()!%\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Идентификатор плагина, в отличие от остальных, не отбрасывается молча:
 * установка «почти того» плагина хуже понятной ошибки.
 */
export function safePluginId(value: string): string {
  if (!PLUGIN_ID.test(value)) {
    throw new Error(`Недопустимый идентификатор плагина: ${value}`);
  }
  return value;
}

/**
 * Квотирование аргумента для запуска через оболочку Windows.
 *
 * При `shell: true` Node склеивает аргументы в одну строку и ничего не
 * экранирует — об этом предупреждает и сам Node (DEP0190). Путь вроде
 * `C:\Program Files\node\x.mjs` разваливается тогда на два аргумента, и
 * команда запускается не с тем, что задумано.
 *
 * Оболочка нужна не везде, а только на Windows и только потому, что `npx`,
 * `uvx` и `claude` там на самом деле .cmd-обёртки, а их `spawn` без оболочки
 * не находит. Поэтому аргументы не остаются как есть, а проходят через это.
 */
export function quoteForShell(value: string): string {
  if (value === '') return '""';
  // Без спецсимволов кавычки только мешают читать команду в интерфейсе.
  if (!/[\s"&|<>^()%!,;]/.test(value)) return value;
  // Кавычку внутри значения УДВАИВАЕМ, а не гасим слэшем: `\"` — правило
  // C-рантайма, а cmd.exe его не знает и считает такую кавычку закрывающей.
  // Промпт `a" & echo INJECTED & "b` на этом выходил из кавычек, и вторая
  // команда выполнялась правами сервера (проверено запуском на Windows).
  // Хвостовые обратные слэши тоже удваиваем — иначе последний съест закрывающую
  // кавычку и снова разомкнёт строку.
  const escaped = value.replace(/"/g, '""').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/** Аргументы для spawn: на Windows — квотированные, на остальных системах — как есть. */
export function shellArgs(args: readonly string[] | undefined): string[] {
  if (!args) return [];
  return process.platform === 'win32' ? args.map(quoteForShell) : [...args];
}
