import type { SkillStepTitle } from './tile.types';
import type { PathEntry } from '@agentdeck/contracts';
import { pickLang } from '@features/GroupPath';

/** Сколько шагов карточка показывает словами: дальше — «и ещё N». */
export const TILE_PREVIEW_STEPS = 3;

export const rawStepTitle: SkillStepTitle = (entry) => entry.title;

export interface StepPreview {
  /** Первые шаги работы на языке интерфейса — без стадий конвейера. */
  titles: string[];
  /** Сколько шагов осталось за кадром. */
  more: number;
  /** Шаги скиллов, чьи названия ещё пишутся: все шаги такие — карточка «читает», а не «шагов нет». */
  waiting: number;
}

/**
 * Превью порядка работы на карточке: первые шаги, которые делает сама группа
 * (шаги скиллов и свои), без стадий конвейера — стадии есть у каждой группы и
 * ничего о ней не говорят. Пустые названия пропускаются: строка без слов в
 * превью хуже, чем её отсутствие.
 */
export function previewSteps(
  entries: readonly PathEntry[],
  language: string,
  limit = TILE_PREVIEW_STEPS,
  stepTitle: SkillStepTitle = rawStepTitle,
): StepPreview {
  const titles: string[] = [];
  let waiting = 0;
  for (const entry of entries) {
    if (entry.kind === 'skill-step') {
      const title = stepTitle(entry);
      if (title === undefined) waiting += 1;
      else titles.push(title.trim());
    } else if (entry.kind === 'custom') {
      titles.push(pickLang(entry.step.title, language) || pickLang(entry.step.prompt, language));
    }
  }
  const named = titles.filter(Boolean);
  return {
    titles: named.slice(0, limit),
    more: Math.max(0, named.length - limit) + waiting,
    waiting,
  };
}
