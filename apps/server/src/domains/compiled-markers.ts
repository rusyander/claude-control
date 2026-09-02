/**
 * Маркеры хуков, скомпилированных панелью. Сценарий-автоматизация и триггер
 * сценария группы уходят в settings.json обычными хуками, и отличить их от
 * написанных руками можно только по метке в команде: по ней их пересобирают,
 * не задевая чужое, и по ней же определяют принадлежность группе — участником
 * группы скомпилированный хук не числится.
 *
 * Модуль без зависимостей: маркеры нужны и `hooks.ts` (принадлежность группе
 * при чтении), и `group-scenario.ts`, который сам импортирует `hooks.ts`.
 * Константа внутри любого из них замкнула бы цикл импортов.
 */

/** Метка триггера сценария группы; за ней — id группы. */
export const SCENARIO_MARKER = '# claude-control:scenario';

/** Метка сценария-автоматизации; за ней — id автоматизации. */
export const AUTOMATION_MARKER = '# claude-control:automation';

export type CompiledHookOrigin =
  { kind: 'scenario'; groupId: string } | { kind: 'automation'; automationId: string };

const ORIGIN = /# claude-control:(scenario|automation):(\S+)/;

/** Чем скомпилирован хук, судя по метке в команде; нет метки — хук написан руками. */
export function compiledHookOrigin(command: string): CompiledHookOrigin | undefined {
  const match = ORIGIN.exec(command);
  const id = match?.[2];
  if (!match || !id) return undefined;

  return match[1] === 'scenario'
    ? { kind: 'scenario', groupId: id }
    : { kind: 'automation', automationId: id };
}
