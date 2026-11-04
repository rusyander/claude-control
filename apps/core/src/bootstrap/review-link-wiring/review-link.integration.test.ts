import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { StepEvent, StepState } from '@agentdeck/contracts/core/states';
import { createUnitCopy } from '../../conductor/copy/create.ts';
import { estimateTask } from '../../conductor/estimate/index.ts';
import { REVIEW_LINK_PRESET_PROBLEM } from '../../conductor/estimate/estimate.ts';
import { estimateBody } from '../../conductor/split/__fixtures__/split-stand.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { presetOf } from '../../conductor/scenario/presets.ts';
import {
  REVIEW_DECIDE_ANSWERS,
  REVIEW_PUSH_ANSWERS,
} from '../../conductor/scenario/review-link-asks.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  closeWorlds,
  linesOf,
  world,
  type World,
} from '../forge-wiring/__fixtures__/answer-world.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import type { Finding } from './comment.ts';
import { createReviewLinkWiring, type ReviewLinkWiring } from './index.ts';

/**
 * Ревью MR по ссылке (этап 10, F8) на настоящем пути: основной репозиторий и голый «сервер» во
 * временной папке, заглушка форжа (`@agentdeck/stub-forge`) на loopback, настоящий реестр задач,
 * настоящая оценка (голова MR приколота fetch'ем). Ссылка → задача `review-link@1` на ветке MR с
 * базой ревью = общий предок с целевой веткой; отказы с кодом; бриф несёт нити MR; публикация
 * отписывает итог одной заметкой (повтор — без второй), пуш отдаёт публикатору только «отправить».
 */

afterEach(closeWorlds);

const SCENARIO = presetOf({ id: 'review-link', version: 1 })!;
const def = (id: string) => SCENARIO.steps.find((s) => s.id === id) as StepDef;

function wiringOf(w: World, forge: 'on' | 'off' = 'on'): ReviewLinkWiring {
  return createReviewLinkWiring(
    { registry: w.registry, coreHome: w.layout.root },
    { git: w.git, forgeFor: () => (forge === 'on' ? { port: w.port, credential: null } : null) },
  );
}

async function mrUrl(w: World): Promise<string> {
  const mr = await w.port.mr(w.mrIid);
  if (!('value' in mr)) throw new Error(`mr: ${JSON.stringify(mr)}`);
  return mr.value.url;
}

const body = (url: string, repo: string, cmdId = newId()) => ({
  cmdId,
  fields: { url, repo },
  proof: {},
});

/** Шаг сдан и прошёл проверку — так его закрывает дирижёр; у ревью — заявление с замечаниями. */
function done(task: LiveTask, unitId: string, defId: string, findings?: Finding[]): string {
  const d = def(defId);
  const stepId = newId();
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: {
      stepId,
      unitId,
      stepKind: d.kind,
      stepDefId: defId,
      round: 0,
      scenario: { id: 'review-link', version: 1 },
      budgetMs: 600_000,
    },
  });
  const t = (event: StepEvent, from: StepState, to: StepState) =>
    task.append({
      kind: 'step.transition',
      actor: 'core',
      stepId,
      data: { stepId, event, from, to },
    });
  t('start', 'queued', 'running');
  if (findings) {
    task.append({
      kind: 'step.claimed',
      actor: 'core',
      stepId,
      data: {
        stepId,
        sessionId: newId(),
        claim: { stepId, outcome: 'done', requirements: [], summary: 'reviewed', findings },
      },
    });
  } else t('check', 'running', 'checking');
  t('checked-green', 'checking', 'done');
  return stepId;
}

function answer(task: LiveTask, stepId: string, text: string): void {
  const askId = newId();
  task.append({
    kind: 'human.asked',
    actor: 'core',
    stepId,
    data: {
      askId,
      point: 8,
      source: 'scenario-step',
      dedupe: null,
      question: 'q',
      options: [],
      defaultAction: null,
    },
  });
  task.append({
    kind: 'human.answered',
    actor: 'human:panel',
    data: { askId, answer: text, channel: 'test' },
  });
}

async function openedTask(w: World, wiring: ReviewLinkWiring) {
  const got = await wiring.open(body(await mrUrl(w), w.st.main), w.env);
  if (got.status === 422) throw new Error(`open: ${JSON.stringify(got)}`);
  const task = w.registry.live(got.reply.taskId)!;
  const [unitId, unit] = Object.entries(task.state.units)[0]!;
  const copy = await createUnitCopy(task, unitId, { root: join(w.st.root, 'copies'), git: w.git });
  if (!copy.ok) throw new Error(`copy: ${copy.failed}`);
  const ctx = (defId: string): StepCtx => ({
    taskId: task.taskId,
    unitId,
    repoKey: unit.repoKey,
    copyDir: copy.placed.dir,
    stepId: newId(),
    def: def(defId),
    round: 0,
    sessionId: null,
  });
  return { task, unitId, copyDir: copy.placed.dir, ctx };
}

const notesOf = (w: World): string[] => {
  const all = w.stub.state().discussions as { mrIid: number; notes: { body: string }[] }[];
  return all.filter((d) => d.mrIid === w.mrIid).flatMap((d) => d.notes.map((n) => n.body));
};

describe('review MR by link (stage 10, F8)', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('a link to an open MR of the repo remote opens ONE review-link task on the MR branch; base = merge base with the target', async () => {
    const w = await world();
    const wiring = wiringOf(w);
    const url = await mrUrl(w);
    const cmdId = newId();
    const got = await wiring.open(body(url, w.st.main, cmdId), w.env);
    expect(got.status).toBe(202);
    if (got.status === 422) return;
    const task = w.registry.live(got.reply.taskId)!;
    const created = task.state.created!;
    expect(created.scenario).toEqual({ id: 'review-link', version: 1 });
    expect(created.launchPolicy).toBe('confirm');
    expect(created.ciWait).toBe(false);
    const head = w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`);
    const base = w.st.g(w.st.main, 'merge-base', 'origin/main', head);
    expect(created.review).toEqual({
      url,
      mrIid: w.mrIid,
      forge: 'gitlab',
      sourceBranch: w.branch,
      targetBranch: 'main',
      reviewBase: base,
    });
    // База ревью — не голова MR: иначе дифф ревью пуст.
    expect(base).not.toBe(head);
    const [zeroId, zero] = Object.entries(task.state.units)[0]!;
    expect(zero.branch).toBe(w.branch);
    expect(publicationOf(task.state, zeroId).mr).toMatchObject({ mrIid: w.mrIid, url });
    // Повтор того же `cmdId` — та же задача, второй нет.
    const again = await wiring.open(body(url, w.st.main, cmdId), w.env);
    expect(again).toMatchObject({ status: 200, reply: { taskId: task.taskId } });
    expect(w.registry.list().filter((t) => t.taskId !== w.source.taskId)).toHaveLength(1);
  });

  it('refusals carry a named code and open no task', async () => {
    const w = await world();
    const wiring = wiringOf(w);
    const url = await mrUrl(w);
    const before = w.registry.list().length;
    const code = async (u: string, repo = w.st.main, wr = wiring) => {
      const got = await wr.open(body(u, repo), w.env);
      return got.status === 422 ? got.code : `status ${got.status}`;
    };
    expect(await code('https://tracker.example.com/not/a/link')).toBe('review_link_unparsed');
    expect(await code(url.replace('/acme/app/', '/other/proj/'))).toBe('review_link_foreign_repo');
    expect(await code(url.replace(`merge_requests/${w.mrIid}`, 'merge_requests/9999'))).toBe(
      'review_link_foreign_repo',
    );
    // Ссылка другого форжа отказывается до запроса к форжу remote и называет оба форжа.
    const crossForge = await wiring.open(
      body(`https://github.com/acme/app/pull/${w.mrIid}`, w.st.main),
      w.env,
    );
    expect(crossForge).toMatchObject({
      status: 422,
      code: 'review_link_foreign_repo',
      problems: ['the link is a github MR, the repository remote is on gitlab'],
    });
    expect(await code(url, w.st.root)).toBe('review_link_unread');
    expect(await code(url, w.st.main, wiringOf(w, 'off'))).toBe('review_link_forge_unsupported');
    w.stub.act('publisher', { type: 'merge', mrIid: w.mrIid });
    expect(await code(url)).toBe('review_link_closed');
    expect(w.registry.list().length).toBe(before);
    // Ревью по ссылке не открывается оценкой: сценарий читает MR у форжа, оценка его не знает.
    const est = await estimateTask(
      estimateBody([w.st.main], { scenario: { preset: 'review-link' } }),
      w.registry,
      w.env,
    );
    expect(est).toEqual({ status: 422, problems: [REVIEW_LINK_PRESET_PROBLEM] });
  });

  it('a local MR branch behind the server head is refused naming both commits, no task', async () => {
    const w = await world();
    const wiring = wiringOf(w);
    const url = await mrUrl(w);
    // Чужой пуш в ветку MR на сервере: локальная ветка основного репозитория отстала.
    const other = join(w.st.root, 'other-clone');
    w.st.g(w.st.root, 'clone', '-q', '-b', w.branch, w.st.bare, other);
    w.st.g(other, 'config', 'user.name', 't');
    w.st.g(other, 'config', 'user.email', 't@t');
    const pushed = w.st.commitIn(other, 'late');
    w.st.g(other, 'push', '-q', 'origin', w.branch);
    const before = w.registry.list().length;
    const got = await wiring.open(body(url, w.st.main), w.env);
    expect(got).toMatchObject({ status: 422, code: 'estimate-refused' });
    if (got.status !== 422) return;
    expect(got.problems.join('\n')).toContain(
      `the MR head on the server at ${pushed.slice(0, 12)} — update or remove the local branch`,
    );
    expect(w.registry.list().length).toBe(before);
  });

  it('the brief carries the base and the open MR threads before intake/review, the findings before fix', async () => {
    const w = await world();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'why is this file here?' });
    const wiring = wiringOf(w);
    const { task, unitId, ctx } = await openedTask(w, wiring);
    const intake = await wiring.hooks.preStep!(ctx('intake'));
    expect(intake.sections).toHaveLength(1);
    const text = intake.sections[0]!.text;
    expect(text).toContain(task.state.created!.review!.reviewBase);
    expect(text).toContain('reviewer: why is this file here?');
    expect(text).toContain('do not answer them in this task');
    const review = await wiring.hooks.preStep!(ctx('review'));
    expect(review.sections[0]!.id).toBe('threads');
    done(task, unitId, 'intake');
    // Ревью ещё нет — правке нечего брифовать.
    expect((await wiring.hooks.preStep!(ctx('fix'))).sections).toEqual([]);
    done(task, unitId, 'review', [
      { file: 'feature.txt', line: 1, severity: 'major', text: 'rename' },
    ]);
    const fix = await wiring.hooks.preStep!(ctx('fix'));
    expect(fix.sections).toEqual([
      {
        id: 'findings',
        text: 'Review findings to fix (1):\n1. `feature.txt:1` [major] — rename',
        from: 'review-link',
      },
    ]);
    // Шаг другого вида — без секций.
    expect((await wiring.hooks.preStep!(ctx('final-gate'))).sections).toEqual([]);
  });

  it('«Отписать в MR»: ONE summary note in the MR (local paths cut), published without a push; a repeat posts nothing', async () => {
    const w = await world();
    const wiring = wiringOf(w);
    const { task, unitId, copyDir, ctx } = await openedTask(w, wiring);
    const headBefore = w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`);
    done(task, unitId, 'intake');
    done(task, unitId, 'review', [
      { file: 'feature.txt', line: 1, severity: 'major', text: 'rename the file' },
      { file: 'b.ts', line: 2, severity: 'nit', text: `see ${join(copyDir, 'b.ts')}` },
    ]);
    answer(task, done(task, unitId, 'decide'), REVIEW_DECIDE_ANSWERS.ru.post);
    const got = await wiring.hooks.onPublish!(ctx('publish'), null);
    expect(got).toEqual({ kind: 'published', mrIid: w.mrIid });
    const notes = notesOf(w);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('**Замечания ревью (2)**');
    expect(notes[0]).toContain('1. `feature.txt:1` [major] — rename the file');
    expect(notes[0]).not.toContain(copyDir);
    expect(notes[0]).toContain('[…]');
    const actions = Object.values(task.state.actions).filter((a) => a.kind === 'mr-comment');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.status).toBe('done');
    // Повтор публикации (перезапуск ядра) — заметка уже есть, второй нет.
    expect(await wiring.hooks.onPublish!(ctx('publish'), null)).toEqual({
      kind: 'published',
      mrIid: w.mrIid,
    });
    expect(notesOf(w)).toHaveLength(1);
    expect(w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`)).toBe(headBefore);
  });

  it('«Починить» + «Отправить»: no note, the step goes to the publisher (null); «И то и другое» + «Не отправлять» posts and publishes', async () => {
    const w = await world();
    const wiring = wiringOf(w);
    const fixSend = await openedTask(w, wiring);
    done(fixSend.task, fixSend.unitId, 'review', [
      { file: 'a', line: 1, severity: 'minor', text: 'x' },
    ]);
    answer(
      fixSend.task,
      done(fixSend.task, fixSend.unitId, 'decide'),
      REVIEW_DECIDE_ANSWERS.ru.fix,
    );
    done(fixSend.task, fixSend.unitId, 'fix');
    answer(fixSend.task, done(fixSend.task, fixSend.unitId, 'push'), REVIEW_PUSH_ANSWERS.ru.send);
    expect(await wiring.hooks.onPublish!(fixSend.ctx('publish'), null)).toBeNull();
    expect(notesOf(w)).toHaveLength(0);

    // Вторая задача на тот же MR — после того, как первая отпустила ветку.
    w.st.g(w.st.main, 'worktree', 'remove', '--force', fixSend.copyDir);
    const both = await openedTask(w, wiring);
    done(both.task, both.unitId, 'review', [{ file: 'a', line: 1, severity: 'minor', text: 'x' }]);
    answer(both.task, done(both.task, both.unitId, 'decide'), REVIEW_DECIDE_ANSWERS.en.both);
    done(both.task, both.unitId, 'fix');
    answer(both.task, done(both.task, both.unitId, 'push'), REVIEW_PUSH_ANSWERS.ru.keep);
    expect(await wiring.hooks.onPublish!(both.ctx('publish'), null)).toEqual({
      kind: 'published',
      mrIid: w.mrIid,
    });
    expect(notesOf(w)).toHaveLength(1);
  });

  it('the forge refuses the note → wait-forge with a journaled backoff, no note; the next try posts once', async () => {
    const w = await world();
    const wiring = wiringOf(w);
    const { task, unitId, ctx } = await openedTask(w, wiring);
    done(task, unitId, 'review', [{ file: 'a', line: 1, severity: 'minor', text: 'x' }]);
    answer(task, done(task, unitId, 'decide'), REVIEW_DECIDE_ANSWERS.ru.post);
    w.stub.fault({ kind: 'status', status: 500, method: 'POST', path: 'discussions', times: 1 });
    const failed = await wiring.hooks.onPublish!(ctx('publish'), null);
    expect(failed).toMatchObject({ kind: 'refused', next: 'wait-forge' });
    expect(linesOf(task, 'publish.backoff')).toHaveLength(1);
    expect(notesOf(w)).toHaveLength(0);
    expect(await wiring.hooks.onPublish!(ctx('publish'), null)).toEqual({
      kind: 'published',
      mrIid: w.mrIid,
    });
    expect(notesOf(w)).toHaveLength(1);
  });

  it('a task of another scenario is not touched: no sections, onPublish null', async () => {
    const w = await world();
    const wiring = wiringOf(w);
    const s: StepCtx = {
      taskId: w.source.taskId,
      unitId: w.unitId,
      repoKey: 'r1',
      copyDir: null,
      stepId: newId(),
      def: def('intake'),
      round: 0,
      sessionId: null,
    };
    expect(await wiring.hooks.preStep!(s)).toEqual({ verdict: { ok: true }, sections: [] });
    expect(await wiring.hooks.onPublish!({ ...s, def: def('publish') }, null)).toBeNull();
  });
});
