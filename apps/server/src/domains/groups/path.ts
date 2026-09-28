import type { GroupPathView, PathEntry, PathStep } from '@agentdeck/contracts/group-path';
import { PATH_ANCHORS } from '@agentdeck/contracts/group-path';
import type { GroupFlow } from '@agentdeck/contracts';
import { skillStepHeadings, type SkillStepHeading } from '@agentdeck/contracts/skill-steps';

/**
 * Сборка «Пути» группы — то, что рисует вкладка и по чему идёт конвейер.
 *
 * Чистая функция: на входе группа и тексты её скиллов, на выходе упорядоченный
 * список. Встроенные стадии берутся из `PATH_ANCHORS` (то есть из списка стадий
 * конвейера), а не хранятся — иначе новая стадия не появилась бы ни у одной
 * группы. Шаги скилла-участника выводятся из его текста при каждом чтении и
 * только показываются: правит их человек в самом скилле.
 */

/** Скилл-участник для сборки: id и текст SKILL.md (без шапки или с ней — неважно). */
export interface PathSkill {
  id: string;
  body: string;
}

/**
 * Где встают шаги скиллов: после стадии работы. Скилл с порядком работы — это
 * и есть то, КАК идёт работа, а не отдельная стадия до или после неё.
 */
const SKILL_STEPS_AFTER = 'work';

/**
 * Пронумерованные шаги скилла — разбор общий с числами группы и страницей
 * (`@agentdeck/contracts/skill-steps`): своя копия регулярки и оград здесь
 * совпадала байт в байт и разошлась бы при первой правке одной из них (F-230).
 * Меньше двух шагов — это не порядок работы, а просто пронумерованный раздел.
 */
export function skillSteps(body: string): string[] {
  return stepHeadings(body).map((step) => step.title);
}

/** Шаги скилла с номером строки заголовка — тем, кому нужен сам текст шага. */
export function stepHeadings(body: string): SkillStepHeading[] {
  return skillStepHeadings(body);
}

/** Свои шаги стадии (без шагов внутри скиллов) в порядке `order`, при равенстве — порядок в массиве. */
function stepsAfter(steps: readonly PathStep[], anchor: string): PathStep[] {
  return ordered(steps.filter((step) => !step.within && step.anchor === anchor));
}

function ordered(steps: readonly PathStep[]): PathStep[] {
  return steps
    .map((step, position) => ({ step, position }))
    .sort((a, b) => a.step.order - b.step.order || a.position - b.position)
    .map(({ step }) => step);
}

/**
 * Номер шага скилла, после которого стоит свой шаг: по заголовку, затем по
 * номеру, иначе — после последнего (скилл переписали, а шаг человека терять
 * нельзя). `-1` — до первого шага.
 */
export function withinIndex(within: NonNullable<PathStep['within']>, titles: string[]): number {
  if (within.index === -1 && !within.after) return -1;
  const byTitle = within.after ? titles.indexOf(within.after) : -1;
  if (byTitle >= 0) return byTitle;
  if (within.index >= 0 && within.index < titles.length) return within.index;
  return titles.length - 1;
}

export function buildPath(
  group: { id: string; flow?: GroupFlow; path?: { steps: PathStep[] } },
  skills: readonly PathSkill[],
): GroupPathView {
  const custom = group.path?.steps ?? [];
  // Сценарий — это сами шаги по порядку: стадий конвейера и шагов скиллов в нём
  // нет, скилл входит в сценарий шагом-ресурсом.
  if (group.flow === 'scenario') {
    const flat = PATH_ANCHORS.flatMap((stage) =>
      ordered(custom.filter((step) => step.anchor === stage)),
    );
    return { groupId: group.id, entries: flat.map((step) => ({ kind: 'custom', step })) };
  }
  const entries: PathEntry[] = [];
  const placed = new Set<string>();

  for (const stage of PATH_ANCHORS) {
    entries.push({ kind: 'builtin', stage });
    if (stage === SKILL_STEPS_AFTER) {
      for (const skill of skills) {
        const titles = skillSteps(skill.body);
        const inside = ordered(custom.filter((step) => step.within?.skillId === skill.id));
        const at = (index: number): void => {
          for (const step of inside) {
            if (placed.has(step.id) || withinIndex(step.within!, titles) !== index) continue;
            placed.add(step.id);
            entries.push({ kind: 'custom', step });
          }
        };
        at(-1);
        titles.forEach((title, index) => {
          entries.push({ kind: 'skill-step', skillId: skill.id, index, title });
          at(index);
        });
      }
      // Шаги внутри скилла, которого здесь нет (не участник, текст не прочитан, у
      // скилла нет пронумерованных шагов) — в конце блока скиллов, а не молча мимо.
      for (const step of ordered(custom.filter((item) => item.within && !placed.has(item.id)))) {
        entries.push({ kind: 'custom', step });
      }
    }
    for (const step of stepsAfter(custom, stage)) entries.push({ kind: 'custom', step });
  }

  return { groupId: group.id, entries };
}
