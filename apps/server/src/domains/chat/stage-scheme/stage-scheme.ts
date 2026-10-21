import { DELIVERY_SKILL_ROUTE } from '@agentdeck/contracts/quality-floor';
import { GROUP_DELIVERY_SKILL_CLAUSE } from '@agentdeck/contracts/task-split';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Задания, выданные до смены схемы стадий (владелец 20.10.2026), и их перевод.
 *
 * Задание группы собирается один раз, при заведении связи, и хранится в ней
 * (`task`, `groupTask`, `stagePrompt`). Дерево, заведённое 19.10 и продолженное
 * после 20.10, вело работу по старой схеме: «проектный навык доставки главнее
 * общего» — сессии читали проектный конвейер, `ticket-delivery-2` не открыли ни
 * разу (замечание прогона 20.10, §10). Продолжение задание не пересобирает,
 * поэтому старые фразы меняются на нынешние здесь, по тексту — дата заведения
 * связи не говорит, каким кодом собрано задание.
 */

/** Фразы старой схемы — дословно, как их собирал код до 20.10 — и их нынешние замены. */
const LEGACY_CLAUSES: readonly (readonly [legacy: string, current: string])[] = [
  [
    "Take the group's tasks through the task delivery skill (a project variant, e.g. " +
      '`<project>-ticket-delivery`, wins over the general `ticket-delivery`; no skill — go through ' +
      'the same stages yourself):',
    GROUP_DELIVERY_SKILL_CLAUSE,
  ],
  [
    'a ticket or delivery to an MR → the project delivery skill (`<project>-ticket-delivery` wins ' +
      'over `ticket-delivery`)',
    DELIVERY_SKILL_ROUTE,
  ],
];

/**
 * Первая строка продолжения ТЕПЛОЙ сессии старого дерева: её окно уже держит
 * старое задание, переписать его нельзя — только сказать поверх, что схема
 * сменилась. Новый разговор (холодное продолжение) получает уже переведённое
 * задание, и строка ему не нужна.
 */
export const STAGE_SCHEME_LINE =
  'Stage scheme update — the task above was issued before it: take the stages through the ' +
  'delivery skill of the panel group, else the global `ticket-delivery-2`; a project delivery ' +
  'skill (`<project>-ticket-delivery`) only supplies project facts — gate commands, tracker ' +
  'statuses, the stand — even where the earlier task text names it as the one that leads the work.';

/** Текст с фразами старой схемы, переведёнными на нынешнюю. */
export function upgradeStageScheme(text: string): string {
  return LEGACY_CLAUSES.reduce(
    (result, [legacy, current]) => result.split(legacy).join(current),
    text,
  );
}

function legacyText(text: string | undefined): boolean {
  return Boolean(text && LEGACY_CLAUSES.some(([legacy]) => text.includes(legacy)));
}

/** Хоть одно задание связи собрано по старой схеме стадий. */
export function onLegacyStageScheme(link: ChatLink): boolean {
  return legacyText(link.task) || legacyText(link.groupTask) || legacyText(link.stagePrompt);
}

/** Связь с заданиями, переведёнными на нынешнюю схему; остальные поля как есть. */
export function upgradedLink(link: ChatLink): ChatLink {
  return {
    ...link,
    ...(link.task ? { task: upgradeStageScheme(link.task) } : {}),
    ...(link.groupTask ? { groupTask: upgradeStageScheme(link.groupTask) } : {}),
    ...(link.stagePrompt ? { stagePrompt: upgradeStageScheme(link.stagePrompt) } : {}),
  };
}
