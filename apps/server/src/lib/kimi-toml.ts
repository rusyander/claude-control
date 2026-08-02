import { stringify as stringifyToml } from 'smol-toml';
import {
  KIMI_DECISIONS,
  KIMI_MODES,
  type KimiDecision,
  type KimiMode,
} from '@claude-control/contracts/vocabulary';
import {
  UnrecognizedFormatError,
  parseCodexToml,
  spliceCodexTableRegion,
  stableToml,
  upsertCodexRootScalar,
} from './codex-toml.ts';

/**
 * Права Kimi Code в `config.toml` — седьмая модель прав панели и вторая на TOML.
 *
 * ГДЕ ФАЙЛ (задокументировано): `$KIMI_CODE_HOME/config.toml`, по умолчанию
 * `~/.kimi-code/config.toml` (на Windows — `C:\Users\<имя>\.kimi-code`, каталог
 * тот же, отличаются только разделители). Проектного config.toml у Kimi НЕТ:
 * документация прямо говорит, что читается ровно один пользовательский файл, а
 * изоляция под проект делается подменой `KIMI_CODE_HOME`.
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *
 *  1. `default_permission_mode` — СКАЛЯРНЫЙ ключ КОРНЯ: `manual` (спрашивать
 *     каждый раз), `auto` (агент решает сам), `yolo` (без вопросов вовсе).
 *  2. `[[permission.rules]]` — МАССИВ ТАБЛИЦ, у каждой ровно два поля:
 *
 *         [[permission.rules]]
 *         decision = "deny"
 *         pattern  = "Bash(rm -rf*)"
 *
 *     `decision` — `allow` | `deny` | `ask`; `pattern` — имя инструмента с
 *     необязательным уточнением аргумента (`Read`, `Bash(git push*)`), у
 *     MCP-инструментов имя вида `mcp__<сервер>__<инструмент>` и шаблоны `*`/`**`.
 *
 * ЧЕГО ПАНЕЛЬ НЕ ТРОГАЕТ: остальные ключи `config.toml` (провайдеры, модели,
 * `loop_control`, `[tools]`, `[[hooks]]`, `[mcp]`-таймауты) — они вне области
 * раздела прав и остаются БАЙТ-В-БАЙТ; `tui.toml` не открывается вовсе.
 *
 * ЧЕСТНОЕ ОГРАНИЧЕНИЕ (fail-closed, а не «допишем как поймём»): если внутри
 * `[permission]` есть что-то кроме `rules`, или у правила есть поля кроме
 * `decision`/`pattern`, раздел уходит в режим только для чтения. Регенерировать
 * такой блок значило бы потерять чужие данные, а угадывать их форму мы не будем.
 *
 * ЗАПИСЬ ХИРУРГИЧЕСКАЯ: режим — правкой одной корневой строки
 * (`upsertCodexRootScalar`), правила — заменой непрерывного региона таблиц
 * `[permission…]` (`spliceCodexTableRegion`). Всё вне этих двух мест, включая
 * комментарии и порядок ключей, сохраняется. Перед возвратом результат
 * ПЕРЕПРОВЕРЯЕТСЯ: репарс + совпадение с намерением + неизменность проекции всех
 * прочих ключей. Не сошлось — `UnrecognizedFormatError`, файл не пишется.
 */

export { UnrecognizedFormatError };

/** Скалярный ключ корня: режим аппрувов новых сессий. */
export const KIMI_MODE_KEY = 'default_permission_mode';

/** Регион правил — массив таблиц `[[permission.rules]]`. */
export const KIMI_PERMISSION_KEY = 'permission';

/** Задокументированные режимы, в порядке роста самостоятельности агента (общий словарь). */
export { KIMI_MODES, type KimiMode };

/** Режим по умолчанию: без ключа Kimi спрашивает подтверждение каждый раз. */
export const KIMI_DEFAULT_MODE: KimiMode = 'manual';

/** Задокументированные решения правила (общий словарь). */
export { KIMI_DECISIONS, type KimiDecision };

/** Поля правила, которые панель ведёт. Любое другое поле → fail-closed. */
const RULE_KEYS = ['decision', 'pattern'];

export interface KimiPermissionRule {
  decision: KimiDecision;
  pattern: string;
}

/**
 * Прочитать режим аппрувов. Ключа нет → `undefined` (раздел «на дефолтах CLI»).
 * Ключ есть, но не строка → fail-closed: чужую форму не толкуем.
 */
export function readKimiMode(text: string): string | undefined {
  if (!text.trim()) return undefined;
  const value = parseCodexToml(text)[KIMI_MODE_KEY];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new UnrecognizedFormatError();
  return value.trim();
}

/**
 * Прочитать правила. Ключа нет → пусто. Любое отклонение от задокументированной
 * формы (внутри `[permission]` не только `rules`, `rules` не массив, правило не
 * таблица, чужое поле правила, незнакомое `decision`, пустой `pattern`) →
 * fail-closed: править вслепую нельзя.
 */
export function readKimiRules(text: string): KimiPermissionRule[] {
  if (!text.trim()) return [];
  const permission = parseCodexToml(text)[KIMI_PERMISSION_KEY];
  if (permission === undefined || permission === null) return [];
  if (typeof permission !== 'object' || Array.isArray(permission)) {
    throw new UnrecognizedFormatError();
  }

  const entries = Object.entries(permission as Record<string, unknown>);
  if (entries.some(([key]) => key !== 'rules')) throw new UnrecognizedFormatError();

  const rules = (permission as Record<string, unknown>).rules;
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) throw new UnrecognizedFormatError();

  return rules.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new UnrecognizedFormatError();
    }
    const rule = item as Record<string, unknown>;
    if (Object.keys(rule).some((key) => !RULE_KEYS.includes(key))) {
      throw new UnrecognizedFormatError();
    }
    const { decision, pattern } = rule;
    if (typeof decision !== 'string' || !(KIMI_DECISIONS as readonly string[]).includes(decision)) {
      throw new UnrecognizedFormatError();
    }
    if (typeof pattern !== 'string' || !pattern.trim()) throw new UnrecognizedFormatError();
    return { decision: decision as KimiDecision, pattern };
  });
}

/** Проекция всех ключей, кроме ведомых панелью — для сверки «чужое не тронуто». */
function otherKeysProjection(text: string): string {
  if (!text.trim()) return stableToml({});
  const parsed = { ...parseCodexToml(text) };
  delete parsed[KIMI_MODE_KEY];
  delete parsed[KIMI_PERMISSION_KEY];
  return stableToml(parsed);
}

/**
 * Записать режим и правила, сохранив остальной файл. Возвращает НОВЫЙ текст;
 * сама запись — снаружи, через `safe-io` (копия + атомарно).
 *
 * Пустой список правил УДАЛЯЕТ регион `[permission…]`, а не пишет пустой массив.
 */
export function writeKimiPermissions(
  text: string,
  mode: KimiMode,
  rules: readonly KimiPermissionRule[],
): string {
  if (!(KIMI_MODES as readonly string[]).includes(mode)) throw new UnrecognizedFormatError();
  for (const rule of rules) {
    if (!(KIMI_DECISIONS as readonly string[]).includes(rule.decision)) {
      throw new UnrecognizedFormatError();
    }
    if (!rule.pattern.trim()) throw new UnrecognizedFormatError();
  }

  // Fail-closed на ВХОДЕ: то, что уже лежит в файле, обязано читаться нашей моделью.
  readKimiMode(text);
  readKimiRules(text);

  const intent = rules.map((rule) => ({ decision: rule.decision, pattern: rule.pattern }));
  const block =
    intent.length > 0 ? stringifyToml({ [KIMI_PERMISSION_KEY]: { rules: intent } }) : '';

  let next: string;
  if (!text.trim()) {
    // Пустого файла нет — собираем минимальный из намерения целиком.
    next = `${stringifyToml({ [KIMI_MODE_KEY]: mode, ...(intent.length > 0 ? { [KIMI_PERMISSION_KEY]: { rules: intent } } : {}) }).replace(/\n+$/, '')}\n`;
  } else {
    next = spliceCodexTableRegion(
      upsertCodexRootScalar(text, KIMI_MODE_KEY, mode),
      block,
      KIMI_PERMISSION_KEY,
    );
  }

  // Верификация: репарс + совпадение с намерением + неизменность прочих ключей.
  if (readKimiMode(next) !== mode) throw new UnrecognizedFormatError();
  if (stableToml(readKimiRules(next)) !== stableToml(intent)) throw new UnrecognizedFormatError();
  if (otherKeysProjection(next) !== otherKeysProjection(text)) {
    throw new UnrecognizedFormatError();
  }

  return next;
}
