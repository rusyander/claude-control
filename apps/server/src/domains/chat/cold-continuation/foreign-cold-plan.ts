import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { AppStore } from '../../../lib/app-store/store.ts';
import { foreignHomes } from '../../analytics/scanner/foreign.ts';
import {
  findForeignTranscript,
  foreignTranscriptKind,
} from '../token-ledger/foreign/foreign-transcript.ts';
import { continuationIntro } from './cold-continuation.ts';
import { foreignColdPlan } from './foreign-cold.ts';

/** Что решатель знает о ходе чужого CLI (`ColdPlanRequest` чата провайдера). */
export interface ForeignColdRequest {
  providerId: string;
  chatId: string;
  workdir?: string;
  session?: { kind: string; id: string };
  local?: boolean;
}

export interface ForeignColdPlanDeps {
  store: Pick<AppStore, 'getChatLink' | 'getSettings' | 'getSplitPlan'>;
  appDataDir: string;
  /** Свой срок остывания (переменная панели для проверок); нет — по CLI. */
  coldAfterMs?: () => number | undefined;
  now?: () => number;
}

/**
 * Решатель `setColdPlan` чата провайдера: группа Codex или Qwen Code после
 * паузы. Рычаг `freshOnColdResume` читается на каждом ходе (правка на странице
 * настроек доходит без перезапуска). Не группа, рычаг выключен, сессии или её
 * переписки нет — `undefined`: сессия продолжается, как без решателя.
 */
export function createForeignColdPlan(deps: ForeignColdPlanDeps) {
  return (
    request: ForeignColdRequest,
  ):
    | { kind: 'resume' }
    | { kind: 'fresh'; brief: string; tail: number; notice: string }
    | undefined => {
    if (!deps.store.getSettings().groupEconomy?.freshOnColdResume) return undefined;
    const kind = foreignTranscriptKind(request.providerId);
    if (!kind || !request.session || !request.workdir) return undefined;
    const link = deps.store.getChatLink(foreignChatKey(request.providerId, request.chatId));
    if (!link?.parentChatId) return undefined;
    const homes = foreignHomes(kind, deps.appDataDir);
    const file = findForeignTranscript(kind, homes, request.session.id, request.workdir);
    if (!file) return undefined;
    const plan = deps.store.getSplitPlan(link.parentChatId);
    const group = plan?.groups.find((item) => item.index === link.groupIndex);
    const coldAfterMs = deps.coldAfterMs?.();
    const decided = foreignColdPlan({
      kind,
      file,
      previous: request.session.id,
      cwd: request.workdir,
      intro: continuationIntro(link, plan),
      ...(group?.base ? { base: group.base } : {}),
      ...(request.local ? { local: true } : {}),
      ...(coldAfterMs !== undefined ? { coldAfterMs } : {}),
      now: (deps.now ?? Date.now)(),
    });
    if (decided.kind === 'resume') return decided;
    return { kind: 'fresh', brief: decided.brief, tail: decided.tail, notice: decided.notice };
  };
}
