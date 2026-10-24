import type { ServerContext } from '../../context.ts';
import type { DeferredAskRecord } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import {
  groupAutoApproveFor,
  groupDecision,
  groupDiscards,
  groupKillRefusal,
  groupPushRefusal,
  killTargetsOf,
  needsMrState,
  withProcessFacts,
  withWorktree,
  type GroupAutoApprove,
  type GroupPermissionSource,
  type ProcessFactsIo,
} from '../../domains/chat/group-permissions.ts';
import {
  sessionTranscriptDir,
  toolCallCwd,
} from '../../domains/chat/ChatTranscriptFile/tool-call-cwd.ts';
import { cachedMainOf, guardHitFor } from '../../domains/backend-guard/backend-guard.ts';
import { mainCheckoutOf } from '../../domains/project-tests/project-tests.ts';
import {
  createAllowedMcpToolsReader,
  createGuardedPatternsReader,
} from '../../domains/permissions/permissions.ts';
import { projectsDir } from '../../routes/chat/paths.ts';

/** Что решила панель сама: разрешить вызов или отказать с причиной и тем, что делать вместо. */
export interface PanelDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

export interface RejudgeDeps {
  source: GroupPermissionSource;
  /** Каталог транскриптов CLI (`~/.claude/projects`). */
  projectsDir: string;
  guardedPatterns: () => string[];
  allowedTools: () => ReadonlySet<string>;
  /** Защита бэкенда узнала вызов — его решает только человек. */
  guarded: (cwd: string | undefined, toolName: string, input: unknown) => boolean;
  /** Снимок процессов и держатели портов — подменяемы в тесте (граница ОС). */
  facts?: ProcessFactsIo;
  /** Своя ветка копии — у её git; в тесте без git. */
  worktree?: (group: GroupAutoApprove, cwd: string | undefined) => Promise<GroupAutoApprove>;
}

/** Первый ключ прогона, для которого нашлось значение (транскрипт пишется под ключом сессии). */
function firstOf<T>(keys: readonly string[], read: (key: string) => T | undefined): T | undefined {
  for (const key of keys) {
    const value = read(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Повторный суд ждущей записи группы при старте панели (D-1, 24.10, решение
 * владельца «все подобные — автоматом»). Судятся только погашения: правило для
 * них сменилось (своё — разрешить, чужое и неназванное — отказ агенту с
 * причиной), а запись, ушедшая человеку по старому правилу, ждала бы его
 * неделю. Остальные вызовы живой маршрут судит с проверками, которых здесь нет
 * (догон main, затирание незакоммиченного, пуш на ревью), — они не трогаются.
 * `undefined` — решать по-прежнему человеку.
 */
export async function rejudgeGroupAsk(
  record: DeferredAskRecord,
  deps: RejudgeDeps,
): Promise<PanelDecision | undefined> {
  if (record.state !== 'waiting' || record.kind !== 'permission') return undefined;
  if (record.scope.kind !== 'group' || record.reasonCode !== 'group-rows') return undefined;
  const request = { toolName: record.toolName, input: record.input };
  if (deps.guarded(record.cwd, record.toolName, record.input)) return undefined;
  const linked = groupAutoApproveFor(deps.source, record.runKeys);
  if (!linked) return undefined;
  const placed = await (deps.worktree
    ? deps.worktree(linked, record.cwd)
    : withWorktree(linked, record.cwd, request));
  const kills = killTargetsOf(placed, request);
  if (!kills) return undefined;
  // Пуш и затирание в той же строке — вопрос к форджу и снимку, их задаёт живой маршрут.
  if (needsMrState(placed, request) || groupDiscards(placed, request).length > 0) return undefined;
  const shellCwd =
    record.toolName === 'Bash'
      ? firstOf(record.runKeys, (key) => toolCallCwd(deps.projectsDir, key, record.toolUseId))
      : undefined;
  const transcriptDir = firstOf(record.runKeys, (key) =>
    sessionTranscriptDir(deps.projectsDir, key),
  );
  // Прогон кончил ход ожиданием — корней дерева нет: своё доказывают метка и текст запуска.
  const group = await withProcessFacts(
    { ...placed, ...(shellCwd ? { shellCwd } : {}) },
    request,
    [],
    deps.facts,
    transcriptDir ? { transcriptDir } : {},
  );
  const refusal = groupKillRefusal(group, request) ?? groupPushRefusal(group, request);
  if (refusal) return { behavior: 'deny', message: refusal };
  const level = groupDecision(group, {
    ...request,
    guardedPatterns: deps.guardedPatterns(),
    allowedTools: deps.allowedTools(),
  });
  return level === 'human' ? undefined : { behavior: 'allow' };
}

/** Настоящие зависимости суда: стор панели, файлы настроек, защита бэкенда. */
export function rejudgeDepsFor(ctx: ServerContext): RejudgeDeps {
  const settings = () => ({
    settings: ctx.location.paths.settings,
    settingsLocal: ctx.location.paths.settingsLocal,
    store: ctx.store,
  });
  const mainOf = cachedMainOf(mainCheckoutOf);
  return {
    source: ctx.store,
    projectsDir: projectsDir(ctx),
    guardedPatterns: createGuardedPatternsReader(settings),
    allowedTools: createAllowedMcpToolsReader(settings),
    guarded: (cwd, toolName, input) => Boolean(guardHitFor(cwd, toolName, input, mainOf)),
  };
}
