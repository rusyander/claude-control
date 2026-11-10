import { BOARD_MOVES, boardEntrySchema, boardMoveSchema } from '@agentdeck/contracts/core/board';
import { browseGapSchema, browseStepSchema } from '@agentdeck/contracts/core/browse';
import { dataSchemaFor } from '@agentdeck/contracts/core/journal';
import { inboxRelatedSchema } from '@agentdeck/contracts/core/inbox';
import {
  BROWSER_TOOL_NAMES,
  isBrowserToolName,
  MODEL_TOOL_NAMES,
  parseModelCall,
  SESSION_STEP_KINDS,
  toolPlanFor,
} from '@agentdeck/contracts/core/model-tools';
import {
  boardMoveBodySchema,
  CORE_PANEL_ROUTES,
  panelCorePath,
} from '@agentdeck/contracts/core/panel-api';
import { relayNoticeSchema } from '@agentdeck/contracts/core/relay';
import {
  PRESET_IDS,
  scenarioProblems,
  STEP_KINDS,
  STEP_TIER_OF,
  stepDefSchema,
  type Scenario,
  type StepDef,
} from '@agentdeck/contracts/core/scenario';
import { isRemotePushKind, REMOTE_PUSH_KINDS } from '@agentdeck/contracts/push-kinds';
import {
  PICK_HTML_MAX,
  PICK_MESSAGE_TYPE,
  PICK_TEXT_MAX,
  pickPayloadSchema,
  sitePreviewOpenBodySchema,
  sitePreviewSchema,
} from '@agentdeck/contracts/site-preview';
import { describe, expect, it } from 'vitest';
import { WALK_NOT_WIRED } from './conductor/model-tools/walk-tools.ts';
import { handleModelTool } from './conductor/model-tools/model-tools.ts';
import type { SessionBinding } from './conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from './journal/resume.ts';
import { newId } from './lib/ids/uuidv7.ts';
import { presetStep } from './conductor/scenario/presets.ts';

/**
 * Контракты этапа 12, волна 3 (каркас S3): строки прохода по стенду, инструменты браузера только у
 * шага `walk`, поля шага `onlyProfile` / `crossOf`, ход доски `merge`, пересылка только вопросов,
 * виды push, окно сайта и выбор элемента, ручка прохода. Каждая граница — пара «внутри / за ней».
 */

const ID = newId();
const ID2 = newId();
const ID3 = newId();
const checks = { console: 0, failed: 0, blank: false, stale: false };

describe('stage 12 w3: browse journal lines (P177)', () => {
  const step = {
    stepId: ID,
    n: 1,
    action: 'click',
    target: { role: 'button', name: 'Save' },
    url: 'http://127.0.0.1:3000/',
    checks,
    ok: true,
  };

  it('browse.step: a semantic target is accepted, a CSS selector or an extra field is refused', () => {
    expect(dataSchemaFor(1, 'browse.step')!.safeParse(step).success).toBe(true);
    for (const target of [{ testId: 'save' }, { label: 'Email' }, { text: 'Готово' }])
      expect(browseStepSchema.safeParse({ ...step, target }).success, JSON.stringify(target)).toBe(
        true,
      );
    expect(browseStepSchema.safeParse({ ...step, target: { css: '#save' } }).success).toBe(false);
    expect(browseStepSchema.safeParse({ ...step, extra: 1 }).success).toBe(false);
    expect(browseStepSchema.safeParse({ ...step, n: 0 }).success).toBe(false);
    expect(browseStepSchema.safeParse({ ...step, action: 'hover' }).success).toBe(false);
  });

  it('browse.step: a secret is named, never valued; a bad env name is refused', () => {
    const fill = { ...step, action: 'fill', secret: { name: 'STAND_PASSWORD' } };
    expect(browseStepSchema.safeParse(fill).success).toBe(true);
    expect(browseStepSchema.safeParse({ ...fill, secret: { name: '1BAD' } }).success).toBe(false);
    expect(browseStepSchema.safeParse({ ...fill, secret: { name: 'A', value: 'x' } }).success).toBe(
      false,
    );
  });

  it('browse.gap: a gesture outside the core skills with why; an ordinary action is refused', () => {
    const gap = { stepId: ID, action: 'drag', why: 'reorder the list' };
    expect(dataSchemaFor(1, 'browse.gap')!.safeParse(gap).success).toBe(true);
    expect(browseGapSchema.safeParse({ ...gap, action: 'click' }).success).toBe(false);
    expect(browseGapSchema.safeParse({ ...gap, why: '' }).success).toBe(false);
  });
});

describe('stage 12 w3: browser tools only at the walk step (D23)', () => {
  it('eight browser tools are model tools; walk alone sees them, read-only builtins, no check or diff', () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(8);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(MODEL_TOOL_NAMES).toContain(name);
      expect(isBrowserToolName(name)).toBe(true);
    }
    expect(isBrowserToolName('check')).toBe(false);
    expect(STEP_KINDS).toContain('walk');
    expect(SESSION_STEP_KINDS).toContain('walk');
    expect(STEP_TIER_OF.walk).toBe('ceiling');
    const plan = toolPlanFor('walk')!;
    expect(plan.builtins).toBe('read-only');
    expect(plan.modelTools).toEqual([
      'step_done',
      'ask_human',
      'blocker',
      'core_state',
      ...BROWSER_TOOL_NAMES,
    ]);
    for (const kind of SESSION_STEP_KINDS.filter((k) => k !== 'walk'))
      expect(toolPlanFor(kind)!.modelTools.filter(isBrowserToolName), kind).toEqual([]);
  });

  it('fill takes exactly one of value and secret', () => {
    const target = { label: 'Password' };
    expect(parseModelCall('browse_fill', { target, value: 'x' }).ok).toBe(true);
    expect(parseModelCall('browse_fill', { target, secret: { name: 'PW' } }).ok).toBe(true);
    expect(parseModelCall('browse_fill', { target }).ok).toBe(false);
    expect(parseModelCall('browse_fill', { target, value: 'x', secret: { name: 'PW' } }).ok).toBe(
      false,
    );
  });

  it('expect pairs: url without target; visible target only; text target and value', () => {
    const target = { text: 'Saved' };
    expect(parseModelCall('browse_expect', { expect: 'url', value: '/done' }).ok).toBe(true);
    expect(parseModelCall('browse_expect', { expect: 'url', target, value: '/d' }).ok).toBe(false);
    expect(parseModelCall('browse_expect', { expect: 'visible', target }).ok).toBe(true);
    expect(parseModelCall('browse_expect', { expect: 'visible', target, value: 'x' }).ok).toBe(
      false,
    );
    expect(parseModelCall('browse_expect', { expect: 'text', target, value: 'Saved' }).ok).toBe(
      true,
    );
    expect(parseModelCall('browse_expect', { expect: 'text', target }).ok).toBe(false);
    expect(parseModelCall('browse_gesture', { action: 'hover', why: 'menu' }).ok).toBe(true);
    expect(parseModelCall('browse_click', { target: { css: 'a' } }).ok).toBe(false);
  });

  it('the core answers a browser call of a walk step not-wired (skeleton), and refuses it at work', () => {
    // Шаг идёт: без подключённого браузера ответ «не подключено»; шаг не идёт — отказ раньше браузера.
    const task = { state: { steps: { [ID3]: { state: 'running' } } } } as unknown as LiveTask;
    const idle = { state: { steps: {} } } as unknown as LiveTask;
    const bind = (stepKind: string): SessionBinding =>
      ({ taskId: ID, unitId: ID2, stepId: ID3, stepKind }) as unknown as SessionBinding;
    const deps = {} as Parameters<typeof handleModelTool>[4];
    const at = (kind: string, input: unknown) =>
      handleModelTool(task, bind(kind), 'browse_open', input, deps);
    expect(at('walk', { url: 'http://127.0.0.1:3000/' })).toMatchObject({
      ok: false,
      code: WALK_NOT_WIRED,
    });
    expect(
      handleModelTool(idle, bind('walk'), 'browse_open', { url: 'http://127.0.0.1:3000/' }, deps),
    ).toMatchObject({ ok: false, code: 'step-not-running' });
    expect(at('walk', {})).toMatchObject({ ok: false, code: 'invalid' });
    expect(at('work', { url: 'http://127.0.0.1:3000/' })).toMatchObject({
      ok: false,
      code: 'tool-not-in-plan',
    });
  });
});

describe('stage 12 w3: onlyProfile and crossOf step fields (D25)', () => {
  const steps = (cross: Partial<StepDef>): Scenario => ({
    id: 'x',
    version: 1,
    title: 'x',
    steps: [
      presetStep('work', 'work', 'Работа', []),
      presetStep('review', 'review', 'Ревью', ['work']),
      { ...presetStep('review-cross', 'review', 'Второе ревью', ['review']), ...cross },
    ],
  });

  it('a cross review of an earlier review step is clean; onlyProfile takes lead profiles only', () => {
    expect(scenarioProblems(steps({ crossOf: 'review', onlyProfile: ['max-quality'] }))).toEqual(
      [],
    );
    const def = presetStep('r', 'review', 'r', []);
    expect(stepDefSchema.safeParse({ ...def, onlyProfile: ['balanced'] }).success).toBe(true);
    expect(stepDefSchema.safeParse({ ...def, onlyProfile: [] }).success).toBe(false);
    expect(stepDefSchema.safeParse({ ...def, onlyProfile: ['turbo'] }).success).toBe(false);
  });

  it('crossOf is refused off kind review, on a non-review target, on itself and on a later step', () => {
    const work = steps({ crossOf: 'review' });
    work.steps[2] = { ...work.steps[2]!, kind: 'fix' };
    expect(scenarioProblems(work)).toContain('review-cross: crossOf needs kind review');
    expect(scenarioProblems(steps({ crossOf: 'work' }))).toContain(
      'review-cross: crossOf must name another review step',
    );
    expect(scenarioProblems(steps({ crossOf: 'review-cross' }))).toContain(
      'review-cross: crossOf must name another review step',
    );
    const later = steps({});
    later.steps[1] = { ...later.steps[1]!, crossOf: 'review-cross' };
    expect(scenarioProblems(later)).toContain(
      'review: crossOf step review-cross must run before it',
    );
  });

  it('browser-walk is a preset id', () => {
    expect(PRESET_IDS).toContain('browser-walk');
  });
});

describe('stage 12 w3: board merge move and entry fields (D26, P186)', () => {
  const move = { cmdId: ID, to: 'merge', entryId: ID2, entryIds: [ID3] };

  it('merge folds other entries into entryId; the body schema judges the same', () => {
    expect(BOARD_MOVES).toContain('merge');
    expect(boardMoveSchema.safeParse(move).success).toBe(true);
    // Тело несёт доказательство команды; суд `entryIds` тот же, что у хода.
    const proof = { nonce: 'n', page: ID };
    expect(boardMoveBodySchema.safeParse({ ...move, proof }).success).toBe(true);
    expect(boardMoveBodySchema.safeParse({ ...move, entryIds: [ID2], proof }).success).toBe(false);
    expect(
      boardMoveBodySchema.safeParse({
        cmdId: ID,
        to: 'queue',
        entryId: ID2,
        entryIds: [ID3],
        proof,
      }).success,
    ).toBe(false);
  });

  it('merge without entryIds, with the entry itself, with repeats, on a task, or entryIds elsewhere — refused', () => {
    expect(boardMoveSchema.safeParse({ ...move, entryIds: undefined }).success).toBe(false);
    expect(boardMoveSchema.safeParse({ ...move, entryIds: [] }).success).toBe(false);
    expect(boardMoveSchema.safeParse({ ...move, entryIds: [ID2] }).success).toBe(false);
    expect(boardMoveSchema.safeParse({ ...move, entryIds: [ID3, ID3] }).success).toBe(false);
    expect(
      boardMoveSchema.safeParse({ cmdId: ID, to: 'merge', taskId: ID2, entryIds: [ID3] }).success,
    ).toBe(false);
    expect(boardMoveSchema.safeParse({ ...move, to: 'queue' }).success).toBe(false);
    expect(boardMoveSchema.safeParse({ cmdId: ID, to: 'queue', entryId: ID2 }).success).toBe(true);
  });

  it('entryIds is capped at 20', () => {
    const many = (n: number) => Array.from({ length: n }, () => newId());
    expect(boardMoveSchema.safeParse({ ...move, entryIds: many(20) }).success).toBe(true);
    expect(boardMoveSchema.safeParse({ ...move, entryIds: many(21) }).success).toBe(false);
  });

  it('an entry carries related facts and merged sources; inbox reads the same related schema', () => {
    expect(inboxRelatedSchema.safeParse({ links: [], paths: [] }).success).toBe(true);
    const entry = {
      entryId: ID,
      state: 'inbox',
      rank: 1,
      stop: 'mr',
      preset: 'feature',
      source: { kind: 'tracker', key: 'PROJ-1', title: 't' },
      launch: { kind: 'fields', fields: {} },
      createdAt: 1,
    };
    expect(boardEntrySchema.safeParse(entry).success).toBe(true);
    const related = { epic: 'PROJ-100', links: ['PROJ-7'], paths: ['src/a.ts'] };
    const merged = [{ kind: 'tracker', key: 'PROJ-2', title: 'u' }];
    expect(boardEntrySchema.safeParse({ ...entry, related, merged }).success).toBe(true);
    expect(boardEntrySchema.safeParse({ ...entry, related: { links: [] } }).success).toBe(false);
    expect(boardEntrySchema.safeParse({ ...entry, merged: [{ kind: 'tracker' }] }).success).toBe(
      false,
    );
  });
});

describe('stage 12 w3: relay, push kinds, site preview, walk route', () => {
  it('relay: only a question with its askId', () => {
    const ask = { taskId: ID, askId: ID2, kind: 'ask', title: 't', deepLink: '/core?id=x' };
    expect(relayNoticeSchema.safeParse(ask).success).toBe(true);
    expect(relayNoticeSchema.safeParse({ ...ask, kind: 'report-final' }).success).toBe(false);
    expect(relayNoticeSchema.safeParse({ ...ask, askId: null }).success).toBe(false);
  });

  it('push kinds are the waiting kinds only: done and error never push', () => {
    expect(REMOTE_PUSH_KINDS).toEqual(['permission', 'question']);
    expect(isRemotePushKind('question')).toBe(true);
    expect(isRemotePushKind('permission')).toBe(true);
    for (const kind of ['done', 'error', 'testFailed', ''])
      expect(isRemotePushKind(kind), kind).toBe(false);
  });

  it('site preview: open body by registry path, window with a nonce; strict', () => {
    expect(sitePreviewOpenBodySchema.safeParse({ path: 'C:/repos/app' }).success).toBe(true);
    expect(sitePreviewOpenBodySchema.safeParse({ path: '' }).success).toBe(false);
    expect(sitePreviewOpenBodySchema.safeParse({ url: 'http://x' }).success).toBe(false);
    const win = { siteId: 's1', url: '/api/site/s1/', nonce: 'n'.repeat(16) };
    expect(sitePreviewSchema.safeParse(win).success).toBe(true);
    expect(sitePreviewSchema.safeParse({ ...win, nonce: 'n'.repeat(15) }).success).toBe(false);
  });

  it('pick payload: own type and nonce, text and markup capped at their limits', () => {
    const pick = {
      type: PICK_MESSAGE_TYPE,
      nonce: 'n'.repeat(16),
      selector: 'main > button:nth-of-type(2)',
      tag: 'button',
      text: 'x'.repeat(PICK_TEXT_MAX),
      outerHTML: 'y'.repeat(PICK_HTML_MAX),
      rect: { x: 1, y: 2, width: 3, height: 4 },
      url: 'http://127.0.0.1:3000/',
    };
    expect(pickPayloadSchema.safeParse(pick).success).toBe(true);
    expect(
      pickPayloadSchema.safeParse({ ...pick, text: 'x'.repeat(PICK_TEXT_MAX + 1) }).success,
    ).toBe(false);
    expect(
      pickPayloadSchema.safeParse({ ...pick, outerHTML: 'y'.repeat(PICK_HTML_MAX + 1) }).success,
    ).toBe(false);
    expect(pickPayloadSchema.safeParse({ ...pick, type: 'other:pick' }).success).toBe(false);
    expect(
      pickPayloadSchema.safeParse({ ...pick, rect: { x: Infinity, y: 0, width: 0, height: 0 } })
        .success,
    ).toBe(false);
  });

  it('the walk route is on the panel list, a plain GET', () => {
    expect(CORE_PANEL_ROUTES).toContainEqual({ method: 'GET', path: '/tasks/:id/walk' });
    expect(panelCorePath('/tasks/:id/walk', { id: 'a b' })).toBe('/api/core/tasks/a%20b/walk');
  });
});
