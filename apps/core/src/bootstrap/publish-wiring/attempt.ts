import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { scanOutgoing } from '@agentdeck/sieves';
import { openActions } from '../../conductor/outbox.ts';
import { treeFp } from '../../conductor/outcomes/final-gate.ts';
import type { PublishOutcome, StepCtx } from '../../conductor/run/run.types.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { revParse, unitCommits } from '../../platform/git/commit-shape.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { lsRemote } from '../../platform/git/ls-remote.ts';
import { readCommitMessages } from '../../platform/git/messages.ts';
import { repoHooksPath } from '../../platform/git/push-closure.ts';
import { pushBranch, type PushRoute } from '../../platform/git/push.ts';
import { treeRows } from '../../platform/git/tree.ts';
import { readOnce, sendReplies, wantsCi } from '../../publisher/after/after.ts';
import { classifyCi } from '../../publisher/ci/index.ts';
import { publisherPushSpec } from '../../publisher/closure/index.ts';
import { collectOutgoing } from '../../publisher/collect/outgoing.ts';
import { ensureMr } from '../../publisher/mr/mr.ts';
import { pushUnit } from '../../publisher/push/push.ts';
import type { OutboxPort } from '../../publisher/push/push.types.ts';
import { backoffMs, nextBackoffAttempt } from '../../publisher/queue/queue.ts';
import { refusalUnmet, type ReadyJudge } from '../../publisher/ready/ready.ts';
import type { PublishReadyInput } from '../../publisher/ready/ready.types.ts';
import { fetchBase, gitSyncDeps, syncWithBase } from '../../publisher/sync/sync.ts';
import { detectConvention, loadPublishTextConfig, sieveText } from '../../publisher/text/index.ts';
import { describeUnit, syncSiblingBodies } from './describe.ts';
import { unitViewOf, type UnitView } from './unit-view.ts';

/**
 * Одна попытка шага публикации (05 §Push and MR, §After publish) — порядок неизменный:
 * начатое и не сверенное действие единицы → ждать; дерево исходящего против состава; база
 * сервера одним fetch; синхронизация; готовность (все условия одним отказом); пуш через outbox;
 * MR (личность — только от форжа); ЕДИНСТВЕННОЕ чтение нитей и конфликта; ответы ревьюерам;
 * CI — только по живому решению; тела соседних MR. Ожидание форжа пишет `publish.backoff`
 * КАЖДЫЙ раз — без него повтор шёл бы без паузы.
 */

export interface ForgeAccess {
  port: ForgePort;
  /** Доступ к пушу парами окружения; `null` — git берёт свой (помощник человека). */
  credential: { kind: 'gitlab' | 'github'; token: string } | null;
}

export interface AttemptDeps {
  coreHome: string;
  git: GitOptions;
  now: () => number;
  forgeFor(url: string): ForgeAccess | null;
  judge: ReadyJudge;
  outbox(task: LiveTask, s: StepCtx): OutboxPort;
}

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

function waitForge(task: LiveTask, s: StepCtx, cause: string): PublishOutcome {
  const pub = publicationOf(task.state, s.unitId);
  const lastOk = Math.max(pub.mr?.seq ?? 0, pub.read?.seq ?? 0, pub.composed?.seq ?? 0);
  const prev = pub.backoff ? { attempt: pub.backoff.attempt, seq: pub.backoff.seq } : null;
  const attempt = nextBackoffAttempt(prev, lastOk);
  task.append({
    kind: 'publish.backoff',
    actor: 'core',
    unitId: s.unitId,
    stepId: s.stepId,
    data: { unitId: s.unitId, attempt, waitMs: backoffMs(attempt), cause },
  });
  return { kind: 'refused', next: 'wait-forge', unmet: [`forge-unknown ${cause}`] };
}

const refused = (
  next: 'fix-step' | 'resolve-conflict' | 'regate',
  unmet: string,
): PublishOutcome => ({
  kind: 'refused',
  next,
  unmet: [unmet],
});

export async function publishAttempt(
  deps: AttemptDeps,
  task: LiveTask,
  s: StepCtx,
  compositionId: string | null,
): Promise<PublishOutcome> {
  const unitId = s.unitId;
  const own = openActions(task).filter((a) => task.state.actions[a.actionId]?.unitId === unitId);
  if (own.length > 0)
    return waitForge(task, s, `action ${own[0]!.kind} ${own[0]!.target} started, not reconciled`);
  const pub = publicationOf(task.state, unitId);
  const composed = pub.composed;
  if (!compositionId || !composed || composed.compositionId !== compositionId)
    return refused('regate', 'composition-mismatch no composed commits for the passed final gate');
  const viewed = await unitViewOf(task, unitId, deps.git);
  if (!('value' in viewed)) return waitForge(task, s, viewed.unknown);
  const view = viewed.value;
  const access = deps.forgeFor(view.url);
  if (!access) return waitForge(task, s, `no forge configured for the remote of ${view.repoKey}`);
  const hooks = await repoHooksPath(view.copyDir, deps.git);
  if (!('value' in hooks)) return waitForge(task, s, `hooks path: ${why(hooks)}`);
  const route: PushRoute = publisherPushSpec({
    url: view.url,
    repoHooksPath: hooks.value,
    credential: access.credential,
  });
  const ctx = await readyInput(deps, task, view, route, compositionId, composed.treeFp, !!pub.mr);
  if ('unknown' in ctx) return waitForge(task, s, ctx.unknown);
  const decision = deps.judge.decide(ctx.input);
  if (decision.kind === 'refuse') {
    if (decision.next === 'wait-forge')
      return waitForge(task, s, refusalUnmet(decision).join('; '));
    return { kind: 'refused', next: decision.next, unmet: refusalUnmet(decision) };
  }
  return publishAllowed(deps, task, s, view, route, access.port, ctx.head);
}

async function readyInput(
  deps: AttemptDeps,
  task: LiveTask,
  view: UnitView,
  route: PushRoute,
  compositionId: string,
  composedFp: string,
  mrExists: boolean,
): Promise<{ input: PublishReadyInput; head: string } | { unknown: string }> {
  let head = await revParse(view.copyDir, 'HEAD', deps.git);
  const base = await fetchBase(view.copyDir, route, view.baseBranch, deps.git);
  let mergeTree: PublishReadyInput['mergeTree'] = { unknown: 'base on the server unread' };
  if ('value' in base) {
    const sync = await syncWithBase(gitSyncDeps(view.copyDir, deps.git), {
      baseSha: base.value.sha,
      head,
      mrExists,
    });
    if (sync.kind === 'rebased') head = sync.head;
    mergeTree =
      sync.kind === 'unknown'
        ? { unknown: sync.reason }
        : sync.kind === 'conflict'
          ? 'conflict'
          : 'clean';
  }
  const rows = await treeRows(view.copyDir, head, deps.git);
  if (!('value' in rows)) return { unknown: `outgoing tree: ${why(rows)}` };
  const outgoing = await collectOutgoing(view.copyDir, view.base, head, view.ownedPaths, deps.git);
  if (!('value' in outgoing)) return { unknown: `outgoing diff: ${why(outgoing)}` };
  const config = await loadPublishTextConfig(deps.coreHome);
  if (!('value' in config)) return { unknown: `publish text config: ${why(config)}` };
  const history = await readCommitMessages(view.sourceRepo, view.base, deps.git);
  const convention = 'value' in history ? detectConvention(history.value) : null;
  const tctx = {
    config: config.value,
    convention,
    localRoots: [deps.coreHome, view.copyDir, view.sourceRepo],
  };
  const commits = await unitCommits(view.copyDir, view.base, head, deps.git);
  const described = describeUnit(task, view.unitId);
  const texts: PublishReadyInput['texts'] = [
    ...commits.map((c) => ({
      kind: 'commit' as const,
      verdict: sieveText('commit', c.message, tctx).kind,
    })),
    { kind: 'mr-title', verdict: sieveText('mr-title', described.title, tctx).kind },
    { kind: 'mr-body', verdict: sieveText('mr-body', described.body, tctx).kind },
  ];
  const open = Object.values(task.state.requirements)
    .filter((r) => r.verdict === 'open' || r.verdict === 'unknown')
    .map((r) => `R${r.ordinal}`);
  return {
    head,
    input: {
      unitId: view.unitId,
      compositionId,
      compositionTreeFp: composedFp,
      outgoingTreeFp: treeFp(rows.value),
      baseOnServer: 'value' in base ? base.value : { unknown: why(base) },
      mergeTree,
      requirements: open.length === 0 ? 'met' : { unmet: open },
      // Покрытие уже судила финальная проверка (её отказ состава не дал бы); здесь не повторяется.
      coverage: { policy: 'warn', gaps: [] },
      sieves: scanOutgoing(outgoing.value),
      texts,
      openHumanPoints: Object.values(task.state.asks)
        .filter((a) => a.state === 'open')
        .map((a) => a.point),
    },
  };
}

async function publishAllowed(
  deps: AttemptDeps,
  task: LiveTask,
  s: StepCtx,
  view: UnitView,
  route: PushRoute,
  forge: ForgePort,
  head: string,
): Promise<PublishOutcome> {
  const unitId = view.unitId;
  const outbox = deps.outbox(task, s);
  const pub = publicationOf(task.state, unitId);
  const ref = `refs/heads/${view.branch}`;
  const remote = await lsRemote(view.copyDir, view.url, [ref], deps.git);
  if ('unknown' in remote) return waitForge(task, s, `branch on the server: ${remote.unknown}`);
  const before = 'value' in remote ? (remote.value[ref] ?? null) : null;
  const pushed = await pushUnit(
    { outbox, push: (mode) => pushBranch(view.copyDir, route, view.branch, head, mode, deps.git) },
    { url: view.url, branch: view.branch, sha: head, before, mrExists: !!pub.mr },
  );
  if (pushed.kind === 'rejected')
    return refused('resolve-conflict', `base-conflict push — the server refused: ${pushed.detail}`);
  if (pushed.kind === 'failed') return waitForge(task, s, `push: ${pushed.code}`);
  const me = await forge.whoAmI();
  if (!('value' in me)) return waitForge(task, s, `forge account: ${why(me)}`);
  const self = me.value.username;
  const described = describeUnit(task, unitId);
  const priorCreate = Object.entries(task.state.actions)
    .filter(([, a]) => a.kind === 'mr-create' && a.unitId === unitId && a.status !== 'done')
    .map(([actionId, a]) => ({ actionId, startedAt: a.startedAt }))
    .sort((a, b) => a.startedAt - b.startedAt)[0];
  const mr = await ensureMr(
    { forge, forgeKind: forge.kind, outbox, self },
    {
      unitId,
      url: view.url,
      sourceBranch: view.branch,
      targetBranch: view.baseBranch,
      title: described.title,
      body: described.body,
      draft: false,
      existing: pub.mr,
      priorCreate: priorCreate ?? null,
    },
  );
  if (mr.kind === 'unknown' || mr.kind === 'unsupported')
    return waitForge(task, s, `merge request: ${mr.reason}`);
  if (mr.kind === 'identified') {
    task.append({ kind: 'publish.mr', actor: 'core', unitId, stepId: s.stepId, data: mr.record });
  }
  const iid = mr.record.mrIid;
  if (!publicationOf(task.state, unitId).read) {
    const read = await readOnce(forge, { iid, self, localConflict: false });
    if ('unknown' in read) return waitForge(task, s, read.unknown);
    task.append({
      kind: 'publish.read',
      actor: 'core',
      unitId,
      stepId: s.stepId,
      data: { unitId, ...read.value },
    });
  }
  const replies = await replyToReviewers(deps, task, s, forge, outbox, view.url, iid, self);
  if (replies) return waitForge(task, s, replies);
  const ci = await readCi(task, s, forge, head);
  if (ci) return ci;
  await syncSiblingBodies(task, { forge, outbox }, view.url, view.repoKey);
  return { kind: 'published', mrIid: iid };
}

/** Ответы последнего сданного шага `answer-reviewers` единицы; сбой — причина ожидания. */
async function replyToReviewers(
  _deps: AttemptDeps,
  task: LiveTask,
  s: StepCtx,
  forge: ForgePort,
  outbox: OutboxPort,
  url: string,
  iid: number,
  self: string,
): Promise<string | null> {
  const answered = Object.values(task.state.steps)
    .filter(
      (st) => st.unitId === s.unitId && st.stepKind === 'answer-reviewers' && st.state === 'done',
    )
    .sort((a, b) => b.startedSeq - a.startedSeq)[0];
  const replies = answered?.claim?.call.replies ?? [];
  if (replies.length === 0) return null;
  const threads = await forge.threads(iid);
  if (!('value' in threads)) return `threads: ${why(threads)}`;
  const done = new Set(
    Object.values(task.state.actions)
      .filter((a) => a.kind === 'thread-reply' && a.status === 'done')
      .map((a) => `${a.target}\n${a.idempotencyHint}`),
  );
  const out = await sendReplies(
    { forge, outbox, self },
    { url, iid, replies, threads: threads.value, doneHints: done },
  );
  const failed = out.find((o) => o.kind === 'failed');
  return failed && failed.kind === 'failed' ? `reply ${failed.threadId}: ${failed.code}` : null;
}

/**
 * CI — только когда человек этой задачи просил ждать и не было «опубликовать сейчас» (P64, P96).
 * Красный код — один раз на sha головы шагом правки; инфраструктура и ожидание — ждать форж.
 */
async function readCi(
  task: LiveTask,
  s: StepCtx,
  forge: ForgePort,
  head: string,
): Promise<PublishOutcome | null> {
  const pub = publicationOf(task.state, s.unitId);
  const ciWait = task.state.created?.ciWait === true;
  if (!wantsCi({ ciWait, publishNow: pub.publishNowSeq !== null })) return null;
  const list = await forge.pipelines({ sha: head });
  if (!('value' in list)) return waitForge(task, s, `pipelines: ${why(list)}`);
  // Класс CI — зоны F (P30): последний конвейер головы, красный код решён раньше машины.
  const cls = classifyCi(list.value, head);
  if (cls.pipelineId !== null) {
    task.append({
      kind: 'publish.ci',
      actor: 'core',
      unitId: s.unitId,
      stepId: s.stepId,
      data: {
        unitId: s.unitId,
        pipelineId: cls.pipelineId,
        headSha: head,
        class: cls.class,
        jobs: cls.jobs,
      },
    });
  }
  if (cls.class === 'green' || cls.class === 'none') return null;
  if (cls.class === 'code') {
    // Тот же красный sha уже отдан шагу правки — второй раз не отдаётся (P79).
    const before = pub.ci;
    if (before && before.headSha === head && before.class === 'code') return null;
    return refused('fix-step', `ci code red on ${head.slice(0, 12)}`);
  }
  return waitForge(task, s, `ci ${cls.class}`);
}
