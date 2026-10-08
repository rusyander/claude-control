import type { Group } from '@agentdeck/contracts';
import { readAnswerBlock } from './answer-block.ts';
import { memberKey } from './members/members.ts';
import { singleTurn, type GroupAsk } from './model.ts';
import { fallbackOverrideText } from './override/override.ts';

/**
 * Текст файла переопределения и список запретов для тумблера «В этом проекте —
 * общая группа». Текст пишет модель (она называет шаги своими словами), не
 * ответила или ответила не по форме — запасной шаблон: тумблер не должен
 * зависеть от того, доступна ли модель прямо сейчас.
 *
 * Запреты `Skill(<id>)` — скиллы ПРОЕКТНОЙ группы: проверка на живом CLI
 * (`tools/qa/check-group-override.mjs`) показала, что одного текста мало —
 * скилл остаётся в списке и по вызову грузится, а запрет вызов отклоняет.
 */

export const OVERRIDE_BLOCK_KIND = 'group-override';
/** Потолок текста: правило уезжает в каждый запрос проекта. */
const MAX_TEXT = 8_000;

function skillIds(group: Group | undefined): string[] {
  return (group?.members ?? []).filter((m) => m.kind === 'skill').map((m) => m.id);
}

function itemsOf(group: Group | undefined): string[] {
  return (group?.members ?? []).filter((m) => m.kind !== 'group').map((m) => memberKey(m));
}

function describe(label: string, group: Group): string {
  return [
    `${label} group "${group.name}"${group.when ? ` — ${group.when}` : ''}`,
    ...itemsOf(group).map((item) => `- ${item}`),
  ].join('\n');
}

export async function overrideTextFor(
  ask: GroupAsk,
  prompt: string,
  global: Group,
  project: Group | undefined,
): Promise<{ text: string; denySkills: string[] }> {
  const denySkills = skillIds(project);
  const fallback = fallbackOverrideText({
    globalName: global.name,
    globalSkills: skillIds(global),
    projectName: project?.name ?? '',
    projectItems: itemsOf(project),
  });
  const data = [
    project ? describe('PROJECT', project) : 'PROJECT group: (none recorded)',
    describe('GLOBAL', global),
  ].join('\n\n');
  try {
    const reply = await ask(singleTurn(prompt, data), 'cheap');
    const text = readAnswerBlock(reply, OVERRIDE_BLOCK_KIND)?.trim();
    if (text && text.startsWith('#')) return { text: text.slice(0, MAX_TEXT), denySkills };
  } catch {
    // Модель недоступна — ниже запасной текст.
  }
  return { text: fallback, denySkills };
}
