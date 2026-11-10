import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import type { ForgeMr } from '@agentdeck/contracts/core/forge';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { REVIEW_LINK_PRESET } from '@agentdeck/contracts/core/review-link';
import { newId } from '../../lib/ids/uuidv7.ts';
import { commitOf, mergeBaseOf, type CopyGitOptions } from '../../platform/copy-git.ts';
import type { TaskRegistry } from '../tasks.ts';
import { createTask, refuse, replayEstimate } from './estimate.ts';
import type { CreateSeed, EstimateOutcome, PinnedRepoView, SplitEnv } from './estimate.types.ts';
import type { LiveTask } from '../../journal/resume.ts';

/**
 * Задача ревью MR по ссылке (этап 10, F8; перенос карточки ревью старой панели). Тот же путь
 * создания, что у оценки (`createTask`), как у задачи ответов ревьюерам (`answer-task.ts`):
 * - база — ветка MR НА СЕРВЕРЕ (`<remote>/<ветка MR>` после fetch): копия встаёт на голову MR,
 *   правки — новыми коммитами поверх неё, запушенное не переписывается никогда;
 * - ветка единицы 0 — ветка MR, как её вернул форж; личность MR (`publish.mr`) — в журнал сразу
 *   за единицей: публикатор пушит в тот же MR и не открывает второй;
 * - база диффа ревью — общий предок целевой ветки и головы MR (`task.created.review`), иначе
 *   ревьюер видел бы изменения целевой ветки как правку MR.
 * Чтение MR у форжа и выбор проекта — до этой функции (`bootstrap/review-link-wiring.ts`):
 * дирижёр форж не знает. Запуск — человеком (`confirm`), CI не ждём (R:S1-09).
 */

export interface ReviewTaskInput {
  cmdId: string;
  repo: string;
  remote: string;
  forge: 'gitlab' | 'github';
  mr: Pick<ForgeMr, 'id' | 'iid' | 'url' | 'sourceBranch' | 'targetBranch'> & { title: string };
  lang?: 'ru' | 'en';
  /** Этап 12: задача пришла с доски — запись, остановка, источник и доказательство старта. */
  boardEntry?: JournalDataV1['task.created']['boardEntry'];
}

/** Текст запроса: какой MR и что от ревью ждут; нити и дифф шаги читают сами. */
export function reviewRequestOf(input: ReviewTaskInput): string {
  const { mr } = input;
  return [
    `Ревью MR ${mr.url} (!${mr.iid}, ${mr.sourceBranch} → ${mr.targetBranch}) — «${mr.title}».`,
    'Прочитать изменения MR и открытые нити, дать замечания (файл, строка, важность, текст).',
    'Файлы на шаге ревью не менять: что делать с замечаниями, решает человек после ревью.',
  ].join('\n');
}

/** Создания в полёте по `cmdId`: повтор того же звонка ждёт первое, а не создаёт вторую задачу. */
const inflight = new Map<string, Promise<EstimateOutcome>>();

export async function openReviewTask(
  input: ReviewTaskInput,
  registry: TaskRegistry,
  env: SplitEnv,
  git: CopyGitOptions = {},
): Promise<EstimateOutcome> {
  const running = inflight.get(input.cmdId);
  if (running) await running.catch(() => undefined);
  const replayed = replayEstimate(registry, input.cmdId);
  if (replayed) return { status: 200, reply: replayed };
  const work = createReviewTask(input, registry, env, git);
  inflight.set(input.cmdId, work);
  try {
    return await work;
  } finally {
    inflight.delete(input.cmdId);
  }
}

async function createReviewTask(
  input: ReviewTaskInput,
  registry: TaskRegistry,
  env: SplitEnv,
  git: CopyGitOptions,
): Promise<EstimateOutcome> {
  const { mr } = input;
  const branch = mr.sourceBranch;
  const title = `Ревью !${mr.iid}: ${mr.title}`.slice(0, 300);
  const body: EstimateBody = {
    cmdId: input.cmdId,
    proof: {},
    fields: {
      title,
      request: reviewRequestOf(input),
      repos: [{ path: input.repo, baseRef: `${input.remote}/${branch}` }],
      scenario: { preset: REVIEW_LINK_PRESET },
      launchPolicy: 'confirm',
      ciWait: false,
      ...(input.lang ? { lang: input.lang } : {}),
    },
  };
  let reviewBase: string | null = null;
  const checkPinned = async (pinned: readonly PinnedRepoView[]): Promise<string[]> => {
    const p = pinned[0];
    if (!p) return ['no repository pinned'];
    // Голова MR — только свежая с сервера: локальная `<remote>/<ветка>` могла отстать от чужих пушей.
    if (p.pin.source !== 'fresh')
      return [`${branch}: the MR head on the server was not read (${p.pin.note ?? 'no fetch'})`];
    const local = await commitOf(p.path, `refs/heads/${branch}`, git);
    if ('unknown' in local) return [`${branch}: local branch unreadable: ${local.unknown}`];
    if ('value' in local && local.value !== p.sha)
      return [
        `${branch}: the local branch is at ${local.value.slice(0, 12)}, the MR head on the server at ${p.sha.slice(0, 12)} — update or remove the local branch`,
      ];
    const target = `${input.remote}/${mr.targetBranch}`;
    const base = await mergeBaseOf(p.path, target, p.sha, git);
    if (!('value' in base))
      return [
        `${target}: no merge base with the MR head (${'unknown' in base ? base.unknown : 'unrelated histories'})`,
      ];
    reviewBase = base.value;
    return [];
  };
  const seed: CreateSeed = {
    checkPinned,
    branch,
    refuseBeforeCreate: true,
    created: () => ({
      review: {
        url: mr.url,
        mrIid: mr.iid,
        forge: input.forge,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        reviewBase: reviewBase!,
      },
      ...(input.boardEntry ? { boardEntry: input.boardEntry } : {}),
    }),
    afterUnitZero(task: LiveTask, zero, cmdId) {
      // Личность MR от форжа (P31): публикатор пушит в этот MR. `actionId` — свой, без действия
      // в журнале: MR открыт не ядром, и описание его публикатор не трогает.
      task.append({
        kind: 'publish.mr',
        actor: 'core',
        unitId: zero.unitId,
        cmdId,
        data: {
          unitId: zero.unitId,
          forge: input.forge,
          mrId: mr.id,
          mrIid: mr.iid,
          url: mr.url,
          sourceBranch: mr.sourceBranch,
          actionId: newId(),
        },
      });
    },
  };
  let made: LiveTask | undefined;
  const opened = seed.opened;
  seed.opened = (task, cmdId) => {
    made = task;
    opened?.(task, cmdId);
  };
  try {
    return await createTask(body, registry, env, seed);
  } catch (error) {
    const why = `review task creation failed: ${error instanceof Error ? error.message : String(error)}`;
    if (made && made.state.ended === null) refuse(made, [why], body.cmdId);
    return { status: 422, problems: [why] };
  }
}
