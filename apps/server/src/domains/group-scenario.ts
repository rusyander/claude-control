import type { GroupScenario, ScenarioStep } from '@agentdeck/contracts';
import { readHooks, writeHooks } from './hooks.ts';
import { hasScenarioMarker, SCENARIO_MARKER } from './compiled-markers.ts';
import type { EntityToggleDeps } from './entity-toggle.ts';

/**
 * Старый «Порядок работы» группы (`scenario`) — после переезда в «Путь».
 *
 * Прежде шаги компилировались в скилл `scenario-<slug>` и хук-триггер
 * `UserPromptSubmit`: модель видела их подсказкой, а панель ничего не
 * проверяла. Теперь шаги — это «Путь» группы (`path.steps`), и конвейер ведёт
 * их настоящими ходами после стадии. Компиляция снята: подсказка, говорящая то
 * же самое другими словами, только путала бы модель и расходилась бы с путём
 * при первой правке. Перенос и уборку скомпилированного делает
 * `groups/path-migration.ts`; здесь остаётся то, что ему нужно, и уборка
 * хуков-триггеров.
 */

/**
 * Метка скомпилированного триггера в команде хука — по ней он и опознаётся.
 * Живёт в `compiled-markers.ts`: её читает и `hooks.ts`. Реэкспорт — ради
 * прежних импортов.
 */
export { SCENARIO_MARKER };

/** Есть ли в сценарии шаги: пустой сценарий переносить не во что. */
export function hasScenario(scenario?: GroupScenario): scenario is GroupScenario {
  return Boolean(scenario && scenario.steps.some((step) => step.title.trim()));
}

/**
 * Годится ли выражение триггера. Триггер больше не компилируется, но форма
 * старых клиентов его ещё шлёт — и отказ на сломанном выражении остаётся тем
 * же, чтобы запись в state.json не несла мусор.
 */
export function isValidTrigger(pattern: string): boolean {
  if (!pattern.trim()) return true;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

/**
 * Тело SKILL.md, которое собирала компиляция. Нужно переносу: скомпилированный
 * скилл удаляется, только если его текст совпадает с этой сборкой байт в байт,
 * — иначе его правил человек, и это уже его работа.
 */
export function buildScenarioBody(
  group: { name: string; description: string },
  scenario: GroupScenario,
): string {
  const lines: string[] = [`# ${group.name}`, ''];

  const intro = scenario.when.trim() || group.description.trim();
  if (intro) lines.push(intro, '');

  lines.push('## Порядок работы', '');

  scenario.steps.forEach((step: ScenarioStep, index: number) => {
    if (!step.title.trim()) return;
    lines.push(`### ${index + 1}. ${step.title.trim()}`, '');
    if (step.body.trim()) lines.push(step.body.trim(), '');
    if (step.gate.trim()) lines.push(`**Готово, когда:** ${step.gate.trim()}`, '');
  });

  lines.push(
    '## Чего не делать',
    '',
    'Не переставлять шаги местами и не объявлять шаг сделанным без его признака выполнения.',
  );

  return lines.join('\n');
}

/**
 * Снять хуки-триггеры сценариев из settings.json. Свои записи узнаются по
 * маркеру в команде, поэтому ни хуки, написанные руками, ни автоматизации не
 * задеваются. Нет ни одного триггера — файл не трогаем вовсе: иначе каждый
 * щелчок тумблера плодил бы резервную копию settings.json на пустом месте.
 */
export function retireScenarioHooks(deps: EntityToggleDeps): string | undefined {
  const { paths, store, backupDir } = deps;

  const hooks = readHooks(paths.settings, store);
  const kept = hooks.filter((hook) => !hasScenarioMarker(hook.command));
  if (kept.length === hooks.length) return undefined;

  // Путь копии — вызывающему: щелчок группы называет её в итоге (F-219).
  return writeHooks(paths.settings, kept, backupDir);
}
