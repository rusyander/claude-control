import type { PathStep } from '@agentdeck/contracts';
import { skillTextSteps } from './skillText';
import type { RowText } from './describe.types';
import type { PathRow } from './pathRows.types';
import { pickLang } from '../lib/pickLang';

/** Скилл из общего списка: текст нужен для разделов шагов, описание — для подсказки. */
export interface KnownSkill {
  description: string;
  body: string;
}

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
