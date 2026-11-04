import type { CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { GroupFlow } from '@agentdeck/contracts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { groupKeyOf, type GroupScope } from '@agentdeck/contracts/group-sources';
import { buildPath } from '../../groups/path/path.ts';

/**
 * Свои шаги «Пути» группы в строках дописки чата: шаги внутри порядка скиллов,
 * сценарий целиком и шаги, привязанные к стадии.
 *
 * Ходы шагов после стадии в том же чате вёл планировщик звеньев панели; он уехал
 * в ядро (этап 10 ядра, 02.11.2026), и с ним — задание хода шага, блок проверки и
 * напоминание отчитаться. Отметки старых связей (`pathRun` в state.json) читаются
 * как были, но новых панель не пишет.
 */

/** Английская сторона, а пустая — русская: непереведённый шаг лучше пропущенного. */
function enOf(text: { ru: string; en: string } | undefined): string {
  return (text?.en.trim() || text?.ru.trim()) ?? '';
}

function resourceLine(step: PathStep): string | undefined {
  if (step.kind !== 'resource' || !step.resource) return undefined;
  const { type, id } = step.resource;
  if (type === 'skill') return `Apply the skill \`${id}\` for this step.`;
  // Утилита сама не действует, как хук или правило: её надо запустить.
  if (type === 'script') {
    return (
      `Run the utility script \`${id}\` for this step — it lives in the hooks folder of the ` +
      'Claude config directory; run it with the interpreter its extension implies and use its output.'
    );
  }
  return `The ${type} \`${id}\` is active for this step; follow it.`;
}

/** Тело шага для строки дописки: текст, ресурс, условие закрытия — по-английски. */
function stepBody(step: PathStep): string {
  const gate = enOf(step.gate);
  return [enOf(step.prompt), resourceLine(step), gate ? `Closed when: ${gate}.` : undefined]
    .filter(Boolean)
    .join(' ');
}

/**
 * Свои шаги группы разговора после стадии. Группа — выбранная в чате (своя или
 * от родителя); `auto` здесь пусто: группу при нём выбирает разбор и пишет
 * ребёнку явным выбором, а до того шагов нет.
 */
export function chatPathSteps(
  groups: readonly {
    id: string;
    scope?: GroupScope;
    flow?: GroupFlow;
    path?: { steps: PathStep[] };
  }[],
  choice: string,
  stage: CascadeStage,
): PathStep[] {
  if (choice === 'auto') return [];
  const group = groups.find((item) => groupKeyOf(item) === choice);
  // Сценарий идёт одной инструкцией (`scenarioLine`), а не ходами после стадий.
  if (!group || group.flow === 'scenario') return [];
  return buildPath(group, []).entries.flatMap((entry) =>
    entry.kind === 'custom' && !entry.step.within && entry.step.anchor === stage
      ? [entry.step]
      : [],
  );
}

/**
 * Свои шаги ВНУТРИ порядка скиллов группы — строкой дописки: скилл идёт одним
 * ходом, отдельного хода «после шага 4 скилла» не бывает, и место шага модель
 * узнаёт только отсюда. Едет вместе с «числами» группы (`chatKnobsLine`) —
 * туда же, куда и они: обычный чат, звено разделения, чужой CLI.
 */
export function skillInsertsLine(group: {
  name: string;
  path?: { steps: PathStep[] };
}): string | undefined {
  const lines = buildPath({ id: '', ...group }, []).entries.flatMap((entry) => {
    if (entry.kind !== 'custom' || !entry.step.within) return [];
    const { step } = entry;
    const within = step.within!;
    const title = enOf(step.title);
    const place = within.after ? `right after its step "${within.after}"` : 'before its first step';
    return [
      `- Skill \`${within.skillId}\`, ${place}${title ? ` — ${title}` : ''}: ${stepBody(step)}`,
    ];
  });
  if (lines.length === 0) return undefined;
  return [
    `The group "${group.name}" inserts its own steps into its skills' numbered order. When you ` +
      'apply such a skill, do each inserted step at its point as part of the skill, and when it ' +
      'has a "closed when" condition, check it before the next skill step:',
    ...lines,
  ].join('\n');
}

/**
 * Сценарий группы — строкой дописки: его шаги по порядку и есть работа. Едет
 * тем же путём, что и «числа» (`chatKnobsLine`): обычный чат и звенья
 * разделения; звено ревью или правок сверяет по нему сделанное, а не делает
 * работу заново.
 */
export function scenarioLine(group: {
  name: string;
  flow?: GroupFlow;
  path?: { steps: PathStep[] };
}): string | undefined {
  if (group.flow !== 'scenario') return undefined;
  const steps = buildPath({ id: '', ...group }, []).entries.flatMap((entry) =>
    entry.kind === 'custom' ? [entry.step] : [],
  );
  if (steps.length === 0) return undefined;
  return [
    `This task follows the scenario "${group.name}". Do its steps in this order, one after ` +
      'another; a step with a "closed when" condition is done only when you have checked it holds. ' +
      'In a review, fix or deliver stage, check the work against these steps instead of redoing them:',
    ...steps.map((step, index) => {
      const title = enOf(step.title);
      return `${index + 1}. ${title ? `${title}: ` : ''}${stepBody(step)}`;
    }),
  ].join('\n');
}
