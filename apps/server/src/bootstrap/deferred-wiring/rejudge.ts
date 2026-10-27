import { statSync } from 'node:fs';
import type { ServerContext } from '../../context.ts';
import type { DeferredAskRecord } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import {
  groupAutoApproveFor,
  groupDecision,
  groupDiscards,
  groupGitAimRefusal,
  groupGitSubcommands,
  groupKillRefusal,
  groupPushRefusal,
  killTargetsOf,
  missingCdTargets,
  needsMrState,
  withOwnTemp,
  withProcessFacts,
  withWorktree,
  type GroupAutoApprove,
  type GroupPermissionSource,
  type ProcessFactsIo,
} from '../../domains/chat/group-permissions.ts';
import {
  callTranscriptFile,
  recordedToolCallCwd,
  sessionScratchpad,
  sessionTranscriptDir,
  sessionTranscriptFile,
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

/** Команда оболочки упоминает git — её сверки (догон, пуш) знает только живой маршрут. */
function touchesGit(record: DeferredAskRecord): boolean {
  const command = (record.input as { command?: unknown } | null)?.command;
  return typeof command === 'string' && /\bgit\b/i.test(command);
}

/**
 * Подкоманды git, у которых нет сверок живого маршрута: запись в индекс и
 * коммит своей копии и чтения. Ни сети (push/pull/fetch/send-pack), ни догона
 * (merge/rebase), ни смены ветки и затирания (checkout/switch/reset/restore/
 * clean/stash), ни ссылок (branch/update-ref/tag) — их сверяет только живой маршрут.
 */
const LOCAL_GIT = new Set([
  'add',
  'commit',
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'grep',
  'describe',
  'rev-list',
  'cat-file',
  'ls-tree',
  'shortlog',
  // Архив своего коммита (D-9, 25.10): файл по `-o` судит место записи (`git-output.ts`).
  'archive',
]);

/**
 * git команды — только свои записи и чтения (D-6, 25.10: коммит в своей копии из
 * подпапки ждал человека после перезапуска, потому что git целиком оставался
 * живому маршруту). Каждое слово `git` в тексте должно быть звеном, которое разбор
 * судил: `git` в строке `echo`, в обёртке, которую разбор не раскрыл, или в
 * псевдониме лишает доказательства, что git только свой, — тогда живому маршруту.
 */
function localGitOnly(group: GroupAutoApprove, record: DeferredAskRecord): boolean {
  const command = (record.input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return false;
  const subs = groupGitSubcommands(group, { toolName: record.toolName, input: record.input });
  const mentions = command.match(/\bgit\b/gi)?.length ?? 0;
  return (
    subs !== undefined &&
    subs.length > 0 &&
    subs.length === mentions &&
    subs.every((sub) => LOCAL_GIT.has(sub))
  );
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
 * (догон main, затирание незакоммиченного, пуш на ревью), — они не трогаются;
 * git только из своих записей и чтений их не требует и судится здесь (D-6, 25.10).
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
  const shellCwd =
    record.toolName === 'Bash'
      ? (firstOf(record.runKeys, (key) =>
          recordedToolCallCwd(deps.projectsDir, key, record.toolUseId),
        ) ?? record.shellCwd)
      : undefined;
  // Рабочая папка CLI — как у живого маршрута (26.10): без неё уборка в своей
  // папке судилась при пересуде строже, чем вживую.
  const scratchpad = firstOf(record.runKeys, (key) => sessionScratchpad(deps.projectsDir, key));
  // Пути судятся от каталога оболочки, как у живого маршрута (`-C ..` из подпапки — копия).
  const here = withOwnTemp(
    {
      ...placed,
      ...(shellCwd ? { shellCwd } : {}),
      ...(scratchpad ? { scratchpad } : {}),
    },
    request,
    record.toolUseId,
    () =>
      firstOf(record.runKeys, (key) => callTranscriptFile(deps.projectsDir, key, record.toolUseId)),
  );
  const decision = await judgePlaced(record, deps, here, kills);
  return decision ?? staleFolderRefusal(here, request);
}

/**
 * Запись ждала часами, а папки, куда команда уходит `cd`, больше нет (D-5, 26.10:
 * клон рецензии убран вместе с её папкой) — исполнять нечего, а карточка висела
 * бы человеку вечно. Только там, где суд оставил решение человеку: разрешение
 * сильнее. Агенту — что случилось и что делать.
 */
function staleFolderRefusal(
  here: GroupAutoApprove,
  request: { toolName: string; input: unknown },
): PanelDecision | undefined {
  const missing = missingCdTargets(here, request);
  if (missing.length === 0) return undefined;
  return {
    behavior: 'deny',
    message:
      `Nothing ran: the folder ${missing.join(', ')} this call works in no longer exists ` +
      '(it was removed while the call waited for a decision). Redo the step if it is still needed.',
  };
}

/**
 * Ждущая запись, исполнять которую больше негде (F7, split d9869abf: D-10 разрешён
 * человеком в 12:49, а клон рецензии, куда шёл `cd`, убран ещё утром). Обход каждую
 * минуту, не только при старте панели: каталог прогона записи пропал или папки
 * `cd` нет. Относительный `cd` судится только от каталога оболочки из транскрипта —
 * без него цель не назвать, и запись остаётся человеку.
 */
export function staleFolderOfAsk(
  record: DeferredAskRecord,
  deps: Pick<RejudgeDeps, 'source' | 'projectsDir'>,
): PanelDecision | undefined {
  if (record.state !== 'waiting' || record.scope.kind !== 'group') return undefined;
  if (record.cwd && !isDirectory(record.cwd)) {
    return {
      behavior: 'deny',
      message:
        `Nothing ran: the folder ${record.cwd} this call was asked in no longer exists ` +
        '(it was removed while the call waited for a decision). Redo the step if it is still needed.',
    };
  }
  if (record.toolName !== 'Bash') return undefined;
  // Чужой CLI транскрипта Claude не пишет — каталог, от которого судили вживую, в записи (P-26).
  const shellCwd =
    firstOf(record.runKeys, (key) =>
      recordedToolCallCwd(deps.projectsDir, key, record.toolUseId),
    ) ?? record.shellCwd;
  if (!shellCwd) return undefined;
  const linked = groupAutoApproveFor(deps.source, record.runKeys);
  if (!linked) return undefined;
  // Корень копии — каталог прогона записи: без него обход не начинал с каталога
  // оболочки, и относительный `cd` в убранную папку не назывался никогда (P-26).
  // Каталог оболочки вне него — неизвестен, как у живого суда: отказа не будет.
  const worktree = linked.worktree ?? record.cwd;
  return staleFolderRefusal(
    { ...linked, ...(worktree ? { worktree } : {}), shellCwd },
    { toolName: record.toolName, input: record.input },
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Суд записи по месту: `undefined` — решать человеку. */
async function judgePlaced(
  record: DeferredAskRecord,
  deps: RejudgeDeps,
  here: GroupAutoApprove,
  kills: ReturnType<typeof killTargetsOf>,
): Promise<PanelDecision | undefined> {
  const request = { toolName: record.toolName, input: record.input };
  // git над копией (D-4, 25.10) — отказ с причиной и без живого маршрута: путь
  // считается из текста и папки оболочки, форж и снимок тут не нужны.
  const aimRefusal = groupGitAimRefusal(here, request);
  if (aimRefusal) return { behavior: 'deny', message: aimRefusal };
  // Не погашение судится заново, только если в нём нет git: догон main, пуш и
  // send-pack сверяет живой маршрут (форж, вершина сервера). 25.10, решение
  // владельца «D-n, кроме удалений, — автоматом»: D-3 (тест в контейнере из
  // переменной) ждал человека по правилу, которое уже исправлено.
  // git только из своих записей и чтений (`add`, `commit`, `status`…) сверок живого
  // маршрута не требует — его судят строки группы здесь же (D-6, 25.10).
  if (!kills && touchesGit(record) && !localGitOnly(here, record)) return undefined;
  // Пуш и затирание в той же строке — вопрос к форджу и снимку, их задаёт живой маршрут.
  if (needsMrState(here, request) || groupDiscards(here, request).length > 0) return undefined;
  if (!kills) {
    const level = groupDecision(here, {
      ...request,
      guardedPatterns: deps.guardedPatterns(),
      allowedTools: deps.allowedTools(),
    });
    return level === 'human' ? undefined : { behavior: 'allow' };
  }
  const transcriptDir = firstOf(record.runKeys, (key) =>
    sessionTranscriptDir(deps.projectsDir, key),
  );
  // Номера, что разговор напечатал о своём запуске (D-8), — из файла этого разговора.
  const conversation = firstOf(record.runKeys, (key) =>
    sessionTranscriptFile(deps.projectsDir, key),
  );
  // Прогон кончил ход ожиданием — корней дерева нет: своё доказывают метка, текст
  // запуска и напечатанный номер.
  const group = await withProcessFacts(here, request, [], deps.facts, {
    ...(transcriptDir ? { transcriptDir } : {}),
    ...(conversation ? { conversation } : {}),
  });
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
