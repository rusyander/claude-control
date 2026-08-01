import type {
  ProviderHookAction,
  ProviderHookPatternGroup,
  ProviderHookRule,
  ProviderHookRulesDraft,
  ProviderHooksDraft,
} from '@claude-control/contracts';
import { rulesMeta } from './event-rules.ts';
import type { ProviderHooksTarget } from './types.ts';

/**
 * Разбор черновика раздела хуков — валидация ДО записи: некорректное тело
 * никогда не доходит до файла (маршрут ответит 400, файл не трогается). Схему
 * zod в рантайме сервера использовать нельзя (значение из contracts роняет node
 * ESM) — проверяем руками.
 */

/** Максимум, чтобы черновик не превращался в способ забить конфиг мусором. */
const MAX_PATTERNS = 200;
const MAX_ACTIONS = 100;
const MAX_ARGV = 100;
const MAX_ENV_VARS = 100;

/** Максимум правил в черновике — та же защита от мусора, что у шаблонов. */
const MAX_RULES = 200;

/**
 * Строка без управляющих символов (аргумент argv, шаблон, значение
 * переменной). Перевод строки внутри argv-элемента почти наверняка означает,
 * что в поле вставили не то, а нулевой байт в конфиге не имеет смысла вовсе.
 *
 * Проверяем кодами, а не регулярным выражением: писать управляющие символы
 * прямо в исходник нельзя, а экранированный класс в регулярке читается хуже.
 */
function isCleanString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Разобрать ОДНО действие черновика.
 *
 * `command` обязан быть НЕПУСТЫМ массивом непустых строк — это argv, а не
 * shell-строка: пустой элемент означал бы пустой аргумент, а пустой массив —
 * запуск «ничего». `environment` необязателен; ключ переменной непустой и
 * уникальный (одноимённые пары в отображении JSON всё равно схлопнулись бы, и
 * пользователь бы этого не заметил).
 */
function parseAction(value: unknown): ProviderHookAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const command = raw.command;
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_ARGV) {
    return undefined;
  }
  if (!command.every((item) => isCleanString(item) && item.length > 0)) return undefined;

  const action: ProviderHookAction = { command: command as string[] };

  if (raw.environment !== undefined) {
    if (!Array.isArray(raw.environment) || raw.environment.length > MAX_ENV_VARS) return undefined;
    const seen = new Set<string>();
    const environment: { key: string; value: string }[] = [];
    for (const item of raw.environment) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const pair = item as Record<string, unknown>;
      // Имя переменной окружения: непустое, без пробелов и без `=`.
      if (typeof pair.key !== 'string' || !/^[^\s=]+$/.test(pair.key)) return undefined;
      if (!isCleanString(pair.value)) return undefined;
      if (seen.has(pair.key)) return undefined;
      seen.add(pair.key);
      environment.push({ key: pair.key, value: pair.value });
    }
    if (environment.length > 0) action.environment = environment;
  }

  return action;
}

/** Разобрать массив действий. Пустой массив допустим — это «событие снято». */
function parseActions(value: unknown): ProviderHookAction[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) return undefined;
  const actions: ProviderHookAction[] = [];
  for (const item of value) {
    const action = parseAction(item);
    if (!action) return undefined;
    actions.push(action);
  }
  return actions;
}

/**
 * Разобрать черновик хуков из тела запроса. Схему zod в рантайме сервера
 * использовать нельзя (значение из contracts роняет node ESM) — проверяем руками.
 * Некорректное тело → `undefined` (маршрут ответит 400, файл не трогается).
 */
export function parseProviderHooksDraft(body: unknown): ProviderHooksDraft | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.fileEdited) || raw.fileEdited.length > MAX_PATTERNS) return undefined;

  const patterns = new Set<string>();
  const fileEdited: ProviderHookPatternGroup[] = [];
  for (const item of raw.fileEdited) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const group = item as Record<string, unknown>;
    // Шаблон — ключ объекта в файле: пустой или повторяющийся молча потерялся бы.
    if (!isCleanString(group.pattern) || !group.pattern.trim()) return undefined;
    if (patterns.has(group.pattern)) return undefined;
    patterns.add(group.pattern);

    const actions = parseActions(group.actions);
    // Шаблон без единого действия в файле выглядел бы как `"*.ts": []` — пустой
    // ключ без смысла. Такую группу не принимаем: её надо просто удалить.
    if (!actions || actions.length === 0) return undefined;
    fileEdited.push({ pattern: group.pattern, actions });
  }

  const sessionCompleted = parseActions(raw.sessionCompleted);
  if (!sessionCompleted) return undefined;

  return { fileEdited, sessionCompleted };
}

/**
 * Разобрать черновик модели `event-rules`. Проверяется всё, что задокументировано
 * у CLI: событие из закрытого списка, матчер только там, где он поддержан,
 * непустая однострочная команда, целый таймаут в границах формата.
 */
export function parseProviderHookRulesDraft(
  body: unknown,
  target: ProviderHooksTarget,
): ProviderHookRulesDraft | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) return undefined;

  const meta = rulesMeta(target.format);
  const events = new Map(meta.events.map((event) => [event.name, event]));

  const rules: ProviderHookRule[] = [];
  for (const item of raw.rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;

    if (typeof entry.event !== 'string') return undefined;
    const event = events.get(entry.event);
    if (!event) return undefined;

    if (!isCleanString(entry.command) || !entry.command.trim()) return undefined;

    const rule: ProviderHookRule = { event: entry.event, command: entry.command };

    if (entry.matcher !== undefined && entry.matcher !== '') {
      // Матчер там, где событие его не поддерживает, CLI молча проигнорирует —
      // а пользователь будет уверен, что фильтр работает. Отказываем.
      if (!event.supportsMatcher) return undefined;
      if (!isCleanString(entry.matcher) || !entry.matcher.trim()) return undefined;
      rule.matcher = entry.matcher;
    }

    if (entry.timeout !== undefined) {
      const timeout = entry.timeout;
      if (typeof timeout !== 'number' || !Number.isInteger(timeout)) return undefined;
      if (timeout < meta.timeoutMin || timeout > meta.timeoutMax) return undefined;
      rule.timeout = timeout;
    }

    rules.push(rule);
  }

  return { rules };
}
