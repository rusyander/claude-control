import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { parseMrLink } from '@agentdeck/contracts/core/review-link';
import { initialState, reduce } from '../../journal/reduce/reduce.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { presetOf } from '../scenario/presets.ts';
import {
  REVIEW_DECIDE_ANSWERS,
  REVIEW_PUSH_ANSWERS,
  REVIEW_LINK_ASKS,
} from '../scenario/review-link-asks.ts';
import { stepAskIn } from '../scenario/titles.ts';
import { decideNext } from './next.ts';
import { REVIEW_LINK_END, reviewLinkClosedByDecision } from './review-link.ts';

/**
 * Ревью MR по ссылке (этап 10, F8): какие шаги идут после ревью, решает ответ человека — чистый
 * суд `decideNext` над свёрткой журнала `review-link@1`. Каждая ветка старой карточки ревью:
 * чистое ревью, «ничего», «отписать», «починить» + «не отправлять»/«отправить», «оба», чужой ответ.
 */

const TASK = newId();
const SCENARIO = presetOf({ id: 'review-link', version: 1 })!;
type Add = (kind: JournalKind, data: unknown, x?: object) => void;

function fold(build: (add: Add) => void): TaskFoldState {
  let state: TaskFoldState = initialState(TASK);
  let seq = 0;
  const add: Add = (kind, data, x = {}) => {
    seq += 1;
    const line = {
      v: 1,
      seq,
      at: seq,
      mono: seq * 1000,
      bootId: TASK,
      taskId: TASK,
      kind,
      actor: 'core',
      data,
      ...x,
    };
    state = reduce(state, line as JournalLine);
  };
  build(add);
  return state;
}

const created = {
  title: 't',
  repos: [],
  build: 'b',
  scenario: { id: 'review-link', version: 1 },
  profilePins: [],
  modelCeiling: null,
  userLayerHash: null,
  envPin: '',
  requirementsSource: 'text',
  allowedRoutes: [],
  routesSourceLevel: 2,
  origin: null,
  launchPolicy: 'auto',
  ciWait: false,
};

const FINDING = { file: 'src/a.ts', line: 3, severity: 'major', text: 'off by one' };

/** Шаг сдан и прошёл проверку; у ревью — заявление с замечаниями. */
function done(add: Add, unitId: string, defId: string, kind: string, findings?: object[]): string {
  const stepId = newId();
  add('step.started', {
    stepId,
    unitId,
    stepKind: kind,
    stepDefId: defId,
    round: 0,
    scenario: created.scenario,
    budgetMs: 0,
  });
  add('step.transition', { stepId, event: 'start', from: 'queued', to: 'running' });
  if (findings) {
    add('step.claimed', {
      stepId,
      sessionId: newId(),
      claim: { stepId, outcome: 'done', requirements: [], summary: 'r', findings },
    });
  } else {
    add('step.transition', { stepId, event: 'check', from: 'running', to: 'checking' });
  }
  add('step.transition', { stepId, event: 'checked-green', from: 'checking', to: 'done' });
  return stepId;
}

function answered(add: Add, stepId: string, answer: string): void {
  const askId = newId();
  add(
    'human.asked',
    {
      askId,
      point: 8,
      question: 'q',
      options: [],
      defaultAction: null,
      source: 'core',
      dedupe: null,
    },
    { stepId },
  );
  add('human.answered', { askId, answer });
}

interface Path {
  findings?: object[];
  decide?: string;
  fixed?: boolean;
  push?: string;
  closed?: boolean;
}

function world(p: Path): { state: TaskFoldState; unitId: string } {
  const unitId = newId();
  const state = fold((add) => {
    add('task.created', created);
    add('task.transition', { taskId: TASK, event: 'launch', from: 'draft', to: 'running' });
    add('unit.created', {
      unitId,
      name: 'u',
      repoKey: 'r1',
      branch: 'b',
      ownedPaths: [],
      after: [],
      contract: false,
      splitId: null,
    });
    add('unit.transition', { unitId, event: 'start', from: 'planned', to: 'running' });
    done(add, unitId, 'intake', 'intake');
    done(add, unitId, 'review', 'review', p.findings ?? []);
    if (p.decide !== undefined) answered(add, done(add, unitId, 'decide', 'ask-human'), p.decide);
    if (p.fixed) done(add, unitId, 'fix', 'fix');
    if (p.push !== undefined) answered(add, done(add, unitId, 'push', 'ask-human'), p.push);
    if (p.closed) add('unit.transition', { unitId, event: 'close', from: 'running', to: 'closed' });
  });
  return { state, unitId };
}

const next = (state: TaskFoldState) =>
  decideNext({ state, scenario: SCENARIO, workNowMs: 0, live: {} }).action;
const RU = REVIEW_DECIDE_ANSWERS.ru;
const PUSH = REVIEW_PUSH_ANSWERS.ru;

describe('review-link@1: the human answer picks the steps after the review (F8)', () => {
  it('a clean review closes the unit without asking; the task then finishes, not fails', () => {
    const { state, unitId } = world({ findings: [] });
    expect(next(state)).toEqual({
      kind: 'end-unit',
      unitId,
      event: 'close',
      reason: `${REVIEW_LINK_END.clean}: the review has no findings`,
    });
    const closed = world({ findings: [], closed: true });
    expect(reviewLinkClosedByDecision(closed.state, closed.unitId)).toBe(true);
    expect(next(closed.state)).toEqual({ kind: 'finish-task' });
  });

  it('findings → the decide question starts; «Ничего не делать» closes the unit as declined', () => {
    const asked = world({ findings: [FINDING] });
    expect(next(asked.state)).toMatchObject({ kind: 'start-step', stepDefId: 'decide' });
    const { state, unitId } = world({ findings: [FINDING], decide: RU.none });
    expect(next(state)).toEqual({
      kind: 'end-unit',
      unitId,
      event: 'close',
      reason: `${REVIEW_LINK_END.declined}: the human chose to do nothing`,
    });
    const closed = world({ findings: [FINDING], decide: RU.none, closed: true });
    expect(next(closed.state)).toEqual({ kind: 'finish-task' });
  });

  it('an answer not in the options is «do nothing», never a guess at fixing or pushing', () => {
    const { state, unitId } = world({ findings: [FINDING], decide: 'сделай как считаешь' });
    expect(next(state)).toEqual({
      kind: 'end-unit',
      unitId,
      event: 'close',
      reason: `${REVIEW_LINK_END.declined}: answer not in the options`,
    });
  });

  it('«Отписать в MR» skips fix, push and the final gate, then publishes (the summary note)', () => {
    const { state } = world({ findings: [FINDING], decide: RU.post });
    expect(next(state)).toMatchObject({ kind: 'skip-step', stepDefId: 'fix' });
  });

  it('«Починить в копии» runs fix, then asks push; «Не отправлять» closes keeping the copy', () => {
    const fixing = world({ findings: [FINDING], decide: RU.fix });
    expect(next(fixing.state)).toMatchObject({ kind: 'start-step', stepDefId: 'fix' });
    const fixed = world({ findings: [FINDING], decide: RU.fix, fixed: true });
    expect(next(fixed.state)).toMatchObject({ kind: 'start-step', stepDefId: 'push' });
    const kept = world({ findings: [FINDING], decide: RU.fix, fixed: true, push: PUSH.keep });
    expect(next(kept.state)).toEqual({
      kind: 'end-unit',
      unitId: kept.unitId,
      event: 'close',
      reason: `${REVIEW_LINK_END.notSent}: fixes stay in the copy, not sent`,
    });
    const closed = world({
      findings: [FINDING],
      decide: RU.fix,
      fixed: true,
      push: PUSH.keep,
      closed: true,
    });
    expect(reviewLinkClosedByDecision(closed.state, closed.unitId)).toBe(true);
  });

  it('«Отправить в MR» runs the final gate; «И то и другое» + «Не отправлять» skips it and still publishes', () => {
    const sent = world({ findings: [FINDING], decide: RU.fix, fixed: true, push: PUSH.send });
    expect(next(sent.state)).toMatchObject({ kind: 'start-step', stepDefId: 'final-gate' });
    const both = world({ findings: [FINDING], decide: RU.both, fixed: true, push: PUSH.keep });
    expect(next(both.state)).toMatchObject({ kind: 'skip-step', stepDefId: 'final-gate' });
    // Закрытая без публикации единица «оба» — не решение человека: итог не отписан.
    const closed = world({
      findings: [FINDING],
      decide: RU.both,
      fixed: true,
      push: PUSH.keep,
      closed: true,
    });
    expect(reviewLinkClosedByDecision(closed.state, closed.unitId)).toBe(false);
  });

  it('English answers are the same keys; the asks carry a safe recommendation in both languages', () => {
    const { state, unitId } = world({ findings: [FINDING], decide: REVIEW_DECIDE_ANSWERS.en.none });
    expect(next(state)).toMatchObject({ kind: 'end-unit', unitId });
    const decideDef = SCENARIO.steps.find((s) => s.id === 'decide')!;
    expect(stepAskIn(decideDef, 'en')).toEqual(REVIEW_LINK_ASKS.decide!.en);
    expect(stepAskIn(decideDef, 'ru')).toEqual(REVIEW_LINK_ASKS.decide!.ru);
    expect(REVIEW_LINK_ASKS.decide!.ru.recommendation).toBe(RU.none);
    expect(REVIEW_LINK_ASKS.push!.en.recommendation).toBe(REVIEW_PUSH_ANSWERS.en.keep);
  });
});

describe('parseMrLink (contracts, F8)', () => {
  it('GitLab MR and GitHub PR links parse with tails; anything else is null, never a guess', () => {
    expect(
      parseMrLink('https://tracker.example.com/group/sub/proj/-/merge_requests/42/diffs#note_1'),
    ).toEqual({
      forge: 'gitlab',
      host: 'tracker.example.com',
      project: 'group/sub/proj',
      iid: 42,
    });
    expect(parseMrLink(' https://github.com/owner/repo/pull/7/files ')).toEqual({
      forge: 'github',
      host: 'github.com',
      project: 'owner/repo',
      iid: 7,
    });
    expect(parseMrLink('https://github.com/owner/repo/issues/7')).toBeNull();
    expect(parseMrLink('ftp://tracker.example.com/g/p/-/merge_requests/1')).toBeNull();
    expect(parseMrLink('not a url')).toBeNull();
    expect(parseMrLink('https://github.com/a/b/c/pull/7')).toBeNull();
  });
});
