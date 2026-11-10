import type { ReviewLinkBody } from '@agentdeck/contracts/core/review-link';
import { forgeActionKey, noteHash } from '../../adapters/forge/index.ts';
import type { SplitEnv } from '../../conductor/estimate/index.ts';
import { reviewLinkFacts, isReviewLink } from '../../conductor/next/review-link.ts';
import { unitView } from '../../conductor/next/attempts.ts';
import type {
  BriefSection,
  ConductorHooks,
  HookVerdict,
  PublishOutcome,
  StepCtx,
} from '../../conductor/run/run.types.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { backoffMs, nextBackoffAttempt } from '../../publisher/queue/queue.ts';
import { loadPublishTextConfig, sieveText } from '../../publisher/text/index.ts';
import { forgeOfPanel } from '../panel-forge.ts';
import type { ForgeAccess } from '../publish-wiring/attempt.ts';
import { outboxPort } from '../publish-wiring/outbox-port.ts';
import { unitViewOf } from '../publish-wiring/unit-view.ts';
import {
  findingsBrief,
  mrContextBrief,
  redact,
  reviewSummaryComment,
  type Finding,
} from './comment.ts';
import { openReviewLink, type ReviewLinkOpenOutcome } from './open.ts';

/**
 * Проводка ревью MR по ссылке (этап 10, F8): открытие задачи по ссылке (`open`) и крючки
 * дирижёра для сценария `review-link@1`:
 * - перед разбором и ревью — база диффа и открытые нити MR (секция `threads`), перед правкой —
 *   замечания ревью (секция `findings`);
 * - публикация — итог ревью заметкой в MR через outbox `mr-comment` (повтор находит свою заметку
 *   по хешу тела, второй не будет), затем пуш только при ответе «отправить»: тогда шаг отдаётся
 *   публикатору (`null`), иначе итог — «опубликовано» без пуша.
 * Крючки стоят раньше публикатора (`conductor-wiring/index.ts`): первый ответивший решает шаг.
 */

const FROM = 'review-link';
const OK: HookVerdict = { ok: true };

export interface ReviewLinkWiringOptions {
  git?: GitOptions;
  /** Форж по адресу пуша; `null` — форжа нет. По умолчанию — настройки панели. */
  forgeFor?: (url: string) => ForgeAccess | null;
}

export interface ReviewLinkWiring {
  hooks: ConductorHooks;
  /** `extra.boardEntry` — старт с доски (этап 12): факт ложится в `task.created`. */
  open(
    body: ReviewLinkBody,
    env: SplitEnv,
    extra?: Parameters<typeof openReviewLink>[2],
  ): Promise<ReviewLinkOpenOutcome>;
}

/** Форж из настроек панели; форж без API (generic) — `null`, как у публикатора. */
export function panelForgeFor(panelAppData: string | null | undefined) {
  const forgeOf = forgeOfPanel(panelAppData);
  return (url: string): ForgeAccess | null => {
    const remote = forgeOf(url);
    if (remote.project.kind === 'generic') return null;
    return { port: remote.port, credential: null };
  };
}

/**
 * Замечания последнего круга ревью единицы: каждое сданное ревью после последней правки, что
 * началась до последнего ревью (первое ревью и второе, `review-cross`), — по последней попытке
 * каждого шага, без повторов (файл, строка, текст). Раньше бралось одно последнее ревью, и при
 * втором ревью в MR уходили только его замечания (этап 12, W3-D).
 */
function findingsOf(task: LiveTask, unitId: string): Finding[] {
  const steps = Object.values(task.state.steps).filter((st) => st.unitId === unitId);
  const reviews = steps
    .filter((st) => st.stepKind === 'review' && st.state === 'done')
    .sort((a, b) => b.startedSeq - a.startedSeq);
  const last = reviews[0];
  if (!last) return [];
  const fixedAt = Math.max(
    0,
    ...steps
      .filter((st) => st.stepKind === 'fix' && st.startedSeq < last.startedSeq)
      .map((st) => st.startedSeq),
  );
  const latestPerDef = new Map<string, (typeof reviews)[number]>();
  for (const st of reviews)
    if (st.startedSeq > fixedAt && !latestPerDef.has(st.stepDefId))
      latestPerDef.set(st.stepDefId, st);
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const st of [...latestPerDef.values()].sort((a, b) => a.startedSeq - b.startedSeq))
    for (const f of st.claim?.call.findings ?? []) {
      const key = `${f.file}|${f.line}|${f.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  return out;
}

const why = (f: { unknown: string } | { absent: true } | { unsupported: string }): string =>
  'unknown' in f ? f.unknown : 'absent' in f ? 'absent' : f.unsupported;

export function createReviewLinkWiring(
  /** `coreHome` — дом ядра: настройки сита текста публикации и каталог, что не уходит наружу. */
  deps: { registry: TaskRegistry; coreHome: string; panelAppData?: string | null },
  options: ReviewLinkWiringOptions = {},
): ReviewLinkWiring {
  const git = options.git ?? {};
  const forgeFor = options.forgeFor ?? panelForgeFor(deps.panelAppData);

  const contextSection = async (task: LiveTask, s: StepCtx): Promise<BriefSection | null> => {
    const review = task.state.created?.review;
    if (!review) return null;
    const mrIid = publicationOf(task.state, s.unitId).mr?.mrIid ?? review.mrIid;
    const view = await unitViewOf(task, s.unitId, git);
    const access = 'value' in view ? forgeFor(view.value.url) : null;
    const threads = !access
      ? 'value' in view
        ? `no forge configured for ${view.value.url}`
        : view.unknown
      : await access.port.threads(mrIid);
    const text = mrContextBrief({
      url: review.url,
      reviewBase: review.reviewBase,
      targetBranch: review.targetBranch,
      threads:
        typeof threads === 'string' ? threads : 'value' in threads ? threads.value : why(threads),
    });
    return { id: 'threads', text: deps.registry.mask(text).text, from: FROM };
  };

  const preStep: ConductorHooks['preStep'] = async (s) => {
    const task = deps.registry.live(s.taskId);
    if (!task || !isReviewLink(task.state)) return { verdict: OK, sections: [] };
    if (s.def.kind === 'intake' || s.def.kind === 'review') {
      const section = await contextSection(task, s);
      return { verdict: OK, sections: section ? [section] : [] };
    }
    if (s.def.kind === 'fix') {
      const text = findingsBrief(findingsOf(task, s.unitId));
      return {
        verdict: OK,
        sections: text ? [{ id: 'findings', text: deps.registry.mask(text).text, from: FROM }] : [],
      };
    }
    return { verdict: OK, sections: [] };
  };

  /** Ожидание форжа: строка `publish.backoff` — срок следующей попытки (P77), как у публикатора. */
  const waitForge = (task: LiveTask, s: StepCtx, cause: string): PublishOutcome => {
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
  };

  /** Итог ревью заметкой: готовое действие с тем же ключом не повторяется. `null` — отписано. */
  const postSummary = async (task: LiveTask, s: StepCtx, mrIid: number): Promise<string | null> => {
    const view = await unitViewOf(task, s.unitId, git);
    if (!('value' in view)) return `unit view: ${view.unknown}`;
    const access = forgeFor(view.value.url);
    if (!access) return `no forge configured for ${view.value.url}`;
    const lang = task.state.created?.lang === 'en' ? 'en' : 'ru';
    const raw = deps.registry.mask(reviewSummaryComment(findingsOf(task, s.unitId), lang)).text;
    const config = await loadPublishTextConfig(deps.coreHome);
    if (!('value' in config)) return `publish text config: ${why(config)}`;
    const sieved = sieveText('reply', raw, {
      config: config.value,
      convention: null,
      localRoots: [view.value.copyDir, view.value.sourceRepo, deps.coreHome],
    });
    const body = sieved.kind === 'refused' ? redact(raw, sieved.spans) : sieved.text;
    const key = forgeActionKey({
      kind: 'mr-comment',
      url: view.value.url,
      iid: mrIid,
      bodyHash: noteHash(body),
    });
    const done = Object.values(task.state.actions).some(
      (a) =>
        a.kind === 'mr-comment' &&
        a.status === 'done' &&
        a.target === key.target &&
        a.idempotencyHint === key.idempotencyHint,
    );
    if (done) return null;
    const got = await outboxPort(task, s).run({ kind: 'mr-comment', ...key }, async () => {
      const sent = await access.port.comment(mrIid, body);
      return 'value' in sent
        ? { ok: true, result: { noteId: sent.value.id, bodyHash: sent.value.bodyHash } }
        : { ok: false, code: 'comment-failed', detail: why(sent) };
    });
    return got.ok ? null : `mr-comment: ${got.code}`;
  };

  const onPublish: ConductorHooks['onPublish'] = async (s) => {
    const task = deps.registry.live(s.taskId);
    if (!task || !isReviewLink(task.state)) return null;
    const facts = reviewLinkFacts(task.state, unitView(task.state, s.unitId));
    const mrIid = publicationOf(task.state, s.unitId).mr?.mrIid;
    if (mrIid === undefined)
      return {
        kind: 'refused',
        next: 'wait-forge',
        unmet: ['review-link: no MR identity journaled'],
      };
    if (facts.decide === 'post' || facts.decide === 'both') {
      const failed = await postSummary(task, s, mrIid);
      if (failed) return waitForge(task, s, failed);
    }
    // Пуш — только по ответу «отправить»: дальше шаг ведёт публикатор (готовность, пуш, чтение).
    if (facts.push === 'send') return null;
    return { kind: 'published', mrIid };
  };

  return {
    hooks: { preStep, onPublish },
    open: (body, env, extra) =>
      openReviewLink(body, { registry: deps.registry, env, git, forgeFor }, extra),
  };
}
