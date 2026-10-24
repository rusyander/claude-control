import { allowedPermissionRules } from '@agentdeck/contracts/permission-rules';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { cachedMainOf, guardHitFor } from '../../domains/backend-guard/backend-guard.ts';
import { stagesAhead } from '../../domains/chat/ChatCascadeStages/ChatCascadeStages.ts';
import { foreignShellRules } from '../../domains/chat/foreign-shell-judge/foreign-ask-rules.ts';
import {
  judgeForeignShell,
  type ForeignShellBridge,
} from '../../domains/chat/foreign-shell-judge/foreign-shell-judge.ts';
import type { ShellJudge } from '../../domains/provider-chat/ProviderChatService/ProviderChatService.ts';
import { mainCheckoutOf } from '../../domains/project-tests/project-tests.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { AppStore } from '../../lib/app-store/store.ts';
import type { ServerContext } from '../../context.ts';
import { deferredAsksOf } from '../../routes/chat/deferred-routes/deferred-store.ts';
import {
  branchFactsOf,
  deferCall,
  deferReason,
  deliveryRefusal,
  protectedWriteRefusal,
  reachesPanelDecision,
  scopeOfRun,
  sourceOfRun,
} from '../../routes/chat/run-routes/deferred-bridge.ts';
import { syncRefOf, UNNAMED_SYNC, withMrState } from '../../routes/chat/run-routes/run-routes.ts';

/**
 * Судья команд оболочки чужого CLI (P-01..P-05) — та же граница, что у маршрута
 * прав Claude, теми же функциями маршрута: D-n, отказ публикации, защищённые
 * ветки, состояние MR, цель догона. Домен судьи маршрутов не импортирует —
 * мост собирается здесь.
 */
export interface ForeignShellJudgeWiringDeps {
  ctx: ServerContext;
  store: AppStore;
  providerChats: { setShellJudge(judge: ShellJudge): void };
  /** Конвейер разделения: за звеном — доставка (`SplitConveyor.deliverAhead`). */
  deliverAhead: (link: ChatLink) => boolean;
}

export function wireForeignShellJudge(deps: ForeignShellJudgeWiringDeps): void {
  const { ctx, store } = deps;
  const guardMainOf = cachedMainOf(mainCheckoutOf);
  const bridge: ForeignShellBridge = {
    asks: () => deferredAsksOf(ctx),
    scopeOf: (keys) => scopeOfRun(store, keys),
    reachesPanelDecision,
    // Хранилище то же, что отдаёт `asks()`: его полный тип нужен `deliveryRefusal`.
    deliveryRefusal: (_asks, scope, toolName, input) =>
      deliveryRefusal(deferredAsksOf(ctx), scope, toolName, input),
    protectedWriteRefusal: async (toolName, input, cwd, base) =>
      protectedWriteRefusal(toolName, input, await branchFactsOf(cwd, toolName, input, base)),
    defer: (call) => {
      const reason = deferReason(call.guard, call.scope.kind === 'group');
      return deferCall(deferredAsksOf(ctx), {
        scope: call.scope,
        runKeys: call.keys,
        toolName: call.toolName,
        input: call.input,
        reason: reason.text,
        reasonCode: reason.code,
        ...(reason.params ? { reasonParams: reason.params } : {}),
        kind: 'permission',
        cwd: call.cwd,
        source: sourceOfRun(store, call.scope, call.cwd, call.title),
      }).message;
    },
    withMrState: (group, toolName, input) =>
      withMrState(store, ctx.location.paths.appData, group, toolName, input),
    syncRefOf: async (group, cwd, toolName, command) => {
      const found = await syncRefOf(group, cwd, toolName, command);
      return found === UNNAMED_SYNC ? 'unnamed' : found;
    },
  };
  deps.providerChats.setShellJudge((call) => {
    const key = foreignChatKey(call.providerId, call.chatId);
    return judgeForeignShell(
      {
        key,
        providerId: call.providerId,
        workdir: call.workdir,
        ...(call.shell.cwd ? { cwd: call.shell.cwd } : {}),
        command: call.shell.command,
        shell: call.shell.shell,
        allowEdits: call.allowEdits,
        ...(call.title ? { title: call.title } : {}),
        ...(call.pid ? { pid: call.pid } : {}),
      },
      {
        store,
        bridge,
        deliverAhead: (chatKey) => {
          const link = store.getChatLink(chatKey);
          return link ? stagesAhead(link, deps.deliverAhead(link)).deliver : false;
        },
        autoApproveRules: () => allowedPermissionRules(store.getSettings().autoApproveRules),
        guardedPatterns: (providerId) => foreignShellRules(providerId),
        guardHit: (cwd, toolName, input) => guardHitFor(cwd, toolName, input, guardMainOf),
      },
    );
  });
}
