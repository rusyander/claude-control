import type { PathAnchor, PathResourceType, PathStep } from '@agentdeck/contracts';
import type { PathRow } from './pathRows';
import { firstParagraph, skillTextSteps } from './skillText';
import { pickLang } from './useEntryTitle';

/** Скилл из общего списка: текст нужен для разделов шагов, описание — для подсказки. */
export interface KnownSkill {
  description: string;
  body: string;
}

/**
 * Откуда брать описание строки. Сводка ресурса стоит серверу вызова модели при
 * промахе кэша — поэтому это не текст, а указание: спросит только показанная
 * подсказка или открытое окно шага.
 */
export type RowText =
  | { kind: 'stage'; stage: PathAnchor }
  | { kind: 'text'; text: string }
  | { kind: 'summary'; type: PathResourceType; id: string; project?: string };

/**
 * Полное описание строки — для окна шага: раздел шага в тексте скилла дословно,
 * описание скилла, текст своего шага или сводка ресурса.
 */
export function rowText(
  row: PathRow,
  skills: ReadonlyMap<string, KnownSkill> | undefined,
  language: string,
): RowText {
  if (row.kind === 'skill') return skillText(row.skillId, skills);
  const { entry } = row;
  if (entry.kind === 'builtin') return { kind: 'stage', stage: entry.stage };
  if (entry.kind === 'custom') return stepText(entry.step, language);
  const known = skills?.get(entry.skillId);
  const section = known ? skillTextSteps(known.body)[entry.index]?.body : undefined;
  if (section) return { kind: 'text', text: section };
  return skillText(entry.skillId, skills);
}

/**
 * Сводка ресурса проекта спрашивается в его проекте: у одноимённого общего
 * ресурса — другой файл, а кэш запросов без проекта делил бы описание на все группы.
 */
export function inProject(text: RowText, project: string | undefined): RowText {
  return text.kind === 'summary' && project ? { ...text, project } : text;
}

/** Короткое описание — для подсказки строки: первый абзац того же текста. */
export function rowHint(text: RowText): RowText {
  return text.kind === 'text' ? { kind: 'text', text: firstParagraph(text.text) } : text;
}

function skillText(skillId: string, skills: ReadonlyMap<string, KnownSkill> | undefined): RowText {
  const description = skills?.get(skillId)?.description.trim();
  return description
    ? { kind: 'text', text: description }
    : { kind: 'summary', type: 'skill', id: skillId };
}

function stepText(step: PathStep, language: string): RowText {
  const prompt = pickLang(step.prompt, language);
  if (prompt) return { kind: 'text', text: prompt };
  if (step.resource) return { kind: 'summary', type: step.resource.type, id: step.resource.id };
  return { kind: 'text', text: '' };
}
