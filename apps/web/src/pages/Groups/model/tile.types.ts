import type { PathEntry } from '@agentdeck/contracts';

/**
 * Название шага скилла на карточке: `undefined` — шаг в превью не попадает.
 * Карточка решает, как у строки «Порядка работы»: описанный шаг — на языке
 * интерфейса, английский заголовок раздела — только в английском интерфейсе
 * или когда описывать уже нечего.
 */
export type SkillStepTitle = (
  entry: Extract<PathEntry, { kind: 'skill-step' }>,
) => string | undefined;
