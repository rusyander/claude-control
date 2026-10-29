import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { stageOf, stagesAhead } from '../../chat/ChatCascadeStages/ChatCascadeStages.ts';
import {
  aheadNote,
  GROUP_DELIVER_AHEAD_ENV,
  GROUP_STAGE_ENV,
} from '../../chat/group-profile/group-profile.ts';
import type { ProviderChatCascade } from '../store/store.ts';

/**
 * Стадия звена в окружении чужого CLI — те же переменные, что у групп Claude
 * (`groupRunProfile`, P-09). Их читает `gate-at-end` набора в хуке CLI: полный
 * гейт группы — один, в звене доставки; в работе, ревью и правках при доставке
 * впереди он отказывает, в доставке после красного гейта и правки ждёт узкой
 * зелёной проверки. Без них хук набора у Qwen Code и вариантов, поставленных
 * руками, считал звено обычной сессией и пускал полный гейт в каждом звене.
 */
export function childStageEnv(link: ChatLink, delivers: boolean): Record<string, string> {
  return {
    [GROUP_STAGE_ENV]: stageOf(link),
    ...(stagesAhead(link, delivers).deliver ? { [GROUP_DELIVER_AHEAD_ENV]: '1' } : {}),
  };
}

/**
 * Звенья впереди у группы чужого CLI (P-39). Доставка — то же правило, что у Claude и у
 * суда публикации (`stagesAhead(...).deliver`, `foreign-shell-judge-wiring`). Ревью —
 * по шапке разговора, которую читает планировщик стадий (`planForeignStage`), а не по
 * потолку связи: у чужого CLI потолка нет, ревью идёт после КАЖДОЙ работы со шапкой
 * (U6), если «Ревью после работы» не выключено, и проход проверки — после правок со
 * списком замечаний. Шапки нет (подбор выключен) — ревью планировщик не заведёт.
 * `reviewedAt` — ревью уже заведено: следующий ход того же разговора его не ждёт.
 */
function foreignStagesAhead(
  link: ChatLink,
  delivers: boolean,
  cascade: ProviderChatCascade | undefined,
): { review: boolean; deliver: boolean } {
  const fresh = cascade !== undefined && !cascade.reviewedAt;
  const review =
    fresh &&
    ((cascade.stage === 'work' && cascade.reviewAfterWork !== false) ||
      (cascade.stage === 'fix' && Boolean(cascade.fixFindings?.length)));
  return { review, deliver: stagesAhead(link, delivers).deliver };
}

/**
 * Строка «что за звеном» для системной строки звена чужого CLI — та же, что у звена
 * Claude (`groupRunProfile` → `aheadNote`), словами без потолка. Без неё рабочее звено
 * узнавало о доставке впереди только отказом пуша (`PUBLISH_BEFORE_DELIVERY_DENIED`).
 */
export function childStageNote(
  link: ChatLink,
  delivers: boolean,
  cascade: ProviderChatCascade | undefined,
): string | undefined {
  return aheadNote(foreignStagesAhead(link, delivers, cascade), 'cli');
}
