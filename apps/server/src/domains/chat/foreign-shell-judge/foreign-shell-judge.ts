import type { DeferredScope } from '@agentdeck/contracts/deferred-asks';
import type { GuardHit } from '../../backend-guard/guard-script.mjs';
import { shouldAutoApprove } from '../auto-approve/auto-approve.ts';
import {
  alreadyQueuedDenial,
  humanRefusedDenial,
  selfApprovalRefusal,
} from '../deferred-asks/texts.ts';
import { expandAliasText } from '../group-command/alias-text.ts';
import {
  PUBLISH_BEFORE_DELIVERY_DENIED,
  publishesBeforeDelivery,
  publishTextOf,
  SEND_PACK_DENIED,
  sendsPack,
} from '../group-profile/delivery-publish.ts';
import {
  groupAutoApproveFor,
  groupDecision,
  groupDiscards,
  groupKillRefusal,
  groupPushRefusal,
  recordGroupAutoNotice,
  syncDanger,
  withProcessFacts,
  withWorktree,
  type GroupAutoApprove,
} from '../group-permissions.ts';
import { gitDestroys, guardUncommitted } from '../group-tree-state.ts';
import {
  conflictsWith,
  isSoleSync,
  MAIN_SYNC_DENIED,
  MAIN_SYNC_UNKNOWN,
  resolvedSyncText,
} from '../main-sync/main-sync.ts';
import type {
  ForeignShellCall,
  ForeignShellJudgeDeps,
  ForeignShellKind,
  ForeignShellVerdict,
} from './foreign-shell-judge.types.ts';

export type {
  ForeignDeferredAsks,
  ForeignShellBridge,
  ForeignShellCall,
  ForeignShellJudgeDeps,
  ForeignShellKind,
  ForeignShellVerdict,
} from './foreign-shell-judge.types.ts';

/**
 * Судья команд оболочки чужого CLI (P-01..P-05, решения владельца 24.10).
 *
 * Чужой CLI спрашивает о команде своим каналом (`live/permission.ts`), и раньше
 * панель отвечала по одному переключателю: правки включены — «да» на всё,
 * включая `git branch -D`, `git push origin main` и пуш до звена доставки.
 * Здесь — тот же суд, что у маршрута прав Claude (`run-routes.ts`), в том же
 * порядке и теми же функциями; чего у чужого CLI нет, названо у места:
 * - группа: строки вкладки «Группы» всегда, тумблер человека их не перекрывает
 *   (у чужого разговора группы нет своего тумблера); `human` — D-n и отказ,
 *   группа не ждёт; погашение не своего процесса — отказ агенту, своё — дерево
 *   процесса CLI хода и метка группы в его окружении (P-06);
 * - одиночный чат: правки включены — авторежим чата (`gitDestroys`, правила
 *   автоподтверждения из настроек); выключены — карточка, как раньше;
 * - оболочка не названа (`unknown`, `cmd`) — команда судится чтением Bash и
 *   чтением PowerShell, строжайшее побеждает.
 */
export async function judgeForeignShell(
  call: ForeignShellCall,
  deps: ForeignShellJudgeDeps,
): Promise<ForeignShellVerdict> {
  const readings = readingsOf(call.shell);
  const input = { command: call.command };
  // Попытка ответить за человека — отказ раньше всего (`reachesPanelDecision`).
  if (readings.some((toolName) => deps.bridge.reachesPanelDecision(toolName, input))) {
    return { behavior: 'deny', message: selfApprovalRefusal() };
  }
  const asks = deps.bridge.asks();
  const keys = [call.key];
  const scope = deps.bridge.scopeOf(keys);
  // Разовое «да» человека на ровно этот вызов (D-n) — раньше правил.
  if (readings.some((toolName) => asks.consume(scope, toolName, input))) {
    return { behavior: 'allow' };
  }
  for (const toolName of readings) {
    const delivery = deps.bridge.deliveryRefusal(asks, scope, toolName, input);
    if (delivery) return { behavior: 'deny', message: delivery };
  }
  const linked = groupAutoApproveFor(deps.store, keys);
  const verdicts: Reading[] = [];
  for (const toolName of readings) {
    verdicts.push(
      linked
        ? await groupReading(call, deps, linked, toolName)
        : await chatReading(call, deps, toolName),
    );
  }
  // Строка `cmd` (qwen на Windows без Git Bash) отдельного чтения не получает:
  // `rd /s`, `del /s`, `erase /s` оба чтения уже отдают человеку (тест паритета,
  // строки cmd), а своё грубое слово сделало бы `rm -rf` и git строже Claude.
  const final = strictest(verdicts);
  if (final.level === 'deny') return { behavior: 'deny', message: final.message ?? '' };
  if (final.level === 'allow' || final.level === 'notify') {
    if (final.level === 'notify' && final.group) {
      recordGroupAutoNotice(deps.store, final.group, { toolName: final.toolName, input });
    }
    return { behavior: 'allow' };
  }
  if (scope.kind !== 'group') return { behavior: 'human' };
  return { behavior: 'deny', message: deferred(call, deps, scope, final) };
}

/** Как прочитать строку: оболочка известна — одним чтением, нет — обоими. */
function readingsOf(shell: ForeignShellKind): ('Bash' | 'PowerShell')[] {
  if (shell === 'bash') return ['Bash'];
  if (shell === 'powershell') return ['PowerShell'];
  return ['Bash', 'PowerShell'];
}

type Level = 'deny' | 'human' | 'notify' | 'allow';

interface Reading {
  level: Level;
  toolName: 'Bash' | 'PowerShell';
  message?: string;
  group?: GroupAutoApprove;
  guard?: GuardHit;
}

const RANK: Record<Level, number> = { deny: 3, human: 2, notify: 1, allow: 0 };

function strictest(readings: Reading[]): Reading {
  return readings.reduce((worst, next) => (RANK[next.level] > RANK[worst.level] ? next : worst));
}

/** Группа ждёт не карточку, а D-n: тот же вызов уже стоит — запись, иначе новая. */
function deferred(
  call: ForeignShellCall,
  deps: ForeignShellJudgeDeps,
  scope: DeferredScope,
  final: Reading,
): string {
  const input = { command: call.command };
  const already = deps.bridge.asks().retryOf(scope, final.toolName, input);
  if (already) {
    return already.state === 'denied'
      ? humanRefusedDenial(already.id, already.message)
      : alreadyQueuedDenial(already.id);
  }
  return deps.bridge.defer({
    scope,
    keys: [call.key],
    toolName: final.toolName,
    input,
    guard: final.guard,
    cwd: call.workdir ?? call.cwd ?? '',
    ...(call.title ? { title: call.title } : {}),
  });
}

/** Каталог оболочки CLI — только внутри копии: разбор начинает с него (`walk.ts`). */
function shellCwdOf(call: ForeignShellCall, worktree: string | undefined): string | undefined {
  if (!call.cwd || !worktree) return undefined;
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const inside =
    norm(call.cwd) === norm(worktree) || norm(call.cwd).startsWith(`${norm(worktree)}/`);
  return inside ? call.cwd : undefined;
}

/** Одно чтение для группы — порядок маршрута прав Claude (`run-routes.ts`). */
async function groupReading(
  call: ForeignShellCall,
  deps: ForeignShellJudgeDeps,
  linked: GroupAutoApprove,
  toolName: 'Bash' | 'PowerShell',
): Promise<Reading> {
  const input = { command: call.command };
  const request = { toolName, input };
  const cwd = call.workdir;
  if (
    deps.deliverAhead(call.key) &&
    publishesBeforeDelivery(publishTextOf(toolName, input) ?? '')
  ) {
    return { level: 'deny', toolName, message: PUBLISH_BEFORE_DELIVERY_DENIED };
  }
  const guard = deps.guardHit(cwd, toolName, input);
  const placed = await withWorktree(linked, cwd, request);
  const shellCwd = shellCwdOf(call, placed.worktree);
  // Корень своего дерева — процесс CLI хода (его pid едет с просьбой, P-06);
  // сироту группы узнаёт метка группы в окружении CLI (`runtime.ts` `setChildRun`).
  const found = await withProcessFacts(
    shellCwd ? { ...placed, shellCwd } : placed,
    request,
    call.pid ? [call.pid] : [],
  );
  const stated = await deps.bridge.withMrState(found, toolName, input);
  const kept = !guard
    ? await guardUncommitted(stated.worktree, call.command, groupDiscards(stated, request))
    : {};
  if ('deny' in kept) return { level: 'deny', toolName, message: kept.deny };
  const group = kept.tree ? { ...stated, tree: kept.tree } : stated;
  const level = groupDecision(group, {
    toolName,
    input,
    guardedPatterns: deps.guardedPatterns(call.providerId),
  });
  const pushRefusal = !guard ? groupPushRefusal(group, request) : undefined;
  if (pushRefusal) return { level: 'deny', toolName, message: pushRefusal };
  // Погашение не своего или неназванного — отказ агенту с тем, как погасить своё,
  // не D-n (D-1, 24.10, решение владельца), как у маршрута Claude.
  const killRefusal = !guard ? groupKillRefusal(group, request) : undefined;
  if (killRefusal) return { level: 'deny', toolName, message: killRefusal };
  if (sendsPack(publishTextOf(toolName, input) ?? '')) {
    return { level: 'deny', toolName, message: SEND_PACK_DENIED };
  }
  const syncCommand = resolvedSyncText(
    expandAliasText(call.command, toolName === 'Bash' ? group.aliases : undefined),
  );
  const syncFound =
    !guard && cwd ? await deps.bridge.syncRefOf(group, cwd, toolName, syncCommand) : undefined;
  const syncRef = syncFound === 'unnamed' ? undefined : syncFound;
  if (syncRef && cwd) {
    const conflict = await conflictsWith(cwd, syncRef, group.base);
    if (conflict === false) return { level: 'deny', toolName, message: MAIN_SYNC_DENIED };
    if (conflict === undefined) return { level: 'deny', toolName, message: MAIN_SYNC_UNKNOWN };
    if (isSoleSync(syncCommand) && !syncDanger(group, call.command, toolName)) {
      return { level: 'notify', toolName, group };
    }
  }
  if (!guard && level !== 'human' && syncFound !== 'unnamed') {
    return { level: level === 'notify' ? 'notify' : 'allow', toolName, group };
  }
  const refusal = await deps.bridge.protectedWriteRefusal(toolName, input, cwd, group.base);
  if (refusal) return { level: 'deny', toolName, message: refusal };
  return { level: 'human', toolName, group, ...(guard ? { guard } : {}) };
}

/** Одно чтение для одиночного чата: авторежим при включённых правках, иначе человек. */
async function chatReading(
  call: ForeignShellCall,
  deps: ForeignShellJudgeDeps,
  toolName: 'Bash' | 'PowerShell',
): Promise<Reading> {
  const input = { command: call.command };
  const guard = deps.guardHit(call.workdir, toolName, input);
  if (
    !guard &&
    call.allowEdits &&
    // Удаление данных git и слияние — человеку и в одиночном чате (решение владельца 23.10).
    !gitDestroys(toolName, input) &&
    shouldAutoApprove({
      toolName,
      input,
      guardedPatterns: deps.guardedPatterns(call.providerId),
      allowEdits: true,
      allowedRules: deps.autoApproveRules(),
    })
  ) {
    return { level: 'allow', toolName };
  }
  // Слияние и пуш в защищённую ветку — известный ответ, не вопрос (решение 2).
  const refusal = await deps.bridge.protectedWriteRefusal(toolName, input, call.workdir, undefined);
  if (refusal) return { level: 'deny', toolName, message: refusal };
  return { level: 'human', toolName, ...(guard ? { guard } : {}) };
}
