import { describe, expect, it } from 'vitest';
import { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import type { GrantConfirmation } from '@agentdeck/contracts/core/user-layer';
import { failureOf, failureOfOutcome } from '@entities/CoreTask';
import { cliPathOf, withCliPath } from './cliOverride';
import {
  attemptFor,
  choiceOfValue,
  emptyDraft,
  fieldsOf,
  scenarioOptions,
  scenarioValue,
} from './launchDraft';
import {
  EMPTY_FOLD,
  foldLaunchLine,
  grantRows,
  launchBlockers,
  launchCommand,
  lineOfEvent,
} from './launchFold';
import { parseCliDetail, rejectedRows, roadsOf } from './launchReply';
import type { LaunchFold } from './launch.types';

/**
 * Модель экрана запуска ядра: черновик → поля оценки (схема ядра), ключ повтора, ответ оценки
 * (дороги, место CLI, отвергнутые правки), свёртка потока (деление, гранты, состояние) и замок
 * запуска. Строки дорог — дословно те, что ядро стенда вернуло на оценке 01.11.
 */

const SPLIT = '01a19701-3a30-7000-8d2f-ebe5ef2ea4b5';
const CMD = '01a19701-3293-7129-af91-db30415a0d70';

const filled = () => ({
  ...emptyDraft(),
  title: 'Починить вход',
  request: 'Кнопка входа не реагирует',
  repos: [{ path: 'C:\\work\\repo', baseRef: '' }],
});

describe('core launch draft', () => {
  it('the panel language reaches the estimate body (the core writes the launch question in it)', () => {
    const lang = (language?: string) => {
      const got = fieldsOf(filled(), language);
      if (!got.ok) throw new Error('draft refused');
      expect(estimateFieldsSchema.safeParse(got.fields).success).toBe(true);
      return got.fields.lang;
    };
    expect(lang('ru')).toBe('ru');
    expect(lang('en-US')).toBe('en');
    expect(lang(undefined)).toBeUndefined();
  });

  it('CI wait is off by default and reaches the estimate body as false', () => {
    expect(emptyDraft().ciWait).toBe(false);
    const got = fieldsOf(filled());
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.fields.ciWait).toBe(false);
      expect(estimateFieldsSchema.safeParse(got.fields).success).toBe(true);
    }
  });

  it('fields pass the core schema: empty base is null, blank repo rows are dropped, policy is confirm', () => {
    const got = fieldsOf({
      ...filled(),
      repos: [
        { path: ' C:\\a ', baseRef: ' main ' },
        { path: '   ', baseRef: '' },
        { path: 'C:\\b', baseRef: '' },
      ],
      ciWait: true,
    });
    expect(got).toEqual({
      ok: true,
      fields: {
        title: 'Починить вход',
        request: 'Кнопка входа не реагирует',
        repos: [
          { path: 'C:\\a', baseRef: 'main' },
          { path: 'C:\\b', baseRef: null },
        ],
        scenario: { preset: 'feature' },
        launchPolicy: 'confirm',
        ciWait: true,
      },
    });
  });

  it('names each empty field once and refuses the forge-only preset', () => {
    const got = fieldsOf({
      ...emptyDraft(),
      scenario: { kind: 'preset', id: 'answer-reviewers' },
    });
    expect(got.ok).toBe(false);
    if (!got.ok)
      expect(got.problems.map((p) => p.field).sort()).toEqual([
        'repos',
        'request',
        'scenario',
        'title',
      ]);
  });

  it('library choice sends id and version; value round-trips', () => {
    const choice = { kind: 'library', id: 'my-flow', version: 3 } as const;
    expect(choiceOfValue(scenarioValue(choice))).toEqual(choice);
    expect(choiceOfValue('preset:nope')).toBeNull();
    const got = fieldsOf({ ...filled(), scenario: choice });
    expect(got.ok && got.fields.scenario).toEqual({ id: 'my-flow', version: 3 });
  });

  it('retry key: same fields keep the cmdId, changed fields mint a new one', () => {
    let n = 0;
    const mint = () => `id-${(n += 1)}`;
    const a = fieldsOf(filled());
    const b = fieldsOf({ ...filled(), title: 'Другое' });
    if (!a.ok || !b.ok) throw new Error('draft must be valid');
    const first = attemptFor(null, a.fields, mint);
    expect(attemptFor(first, a.fields, mint)).toBe(first);
    expect(attemptFor(first, b.fields, mint).cmdId).toBe('id-2');
  });

  it('scenario options: every preset once, forge-only disabled, library versions listed', () => {
    const opts = scenarioOptions({
      presets: [],
      library: [{ id: 'flow', version: 2, title: 'Мой поток', steps: [] as never }],
    });
    expect(opts.find((o) => o.value === 'preset:answer-reviewers')?.disabled).toBe(true);
    expect(opts.filter((o) => o.value.startsWith('preset:')).length).toBe(6);
    expect(opts.some((o) => o.value === 'preset:chat')).toBe(false);
    expect(opts.some((o) => o.value === 'preset:ask')).toBe(false);
    expect(opts.at(-1)).toEqual({
      value: 'library:flow@2',
      label: 'Мой поток · v2',
      disabled: false,
    });
  });
});

const CLI_DETAIL =
  'claude: «claude» not found (searched 51 dirs); qwen: «qwen» not found (searched 51 dirs) — fix: install the CLI or put it on the PATH the core was started with';

describe('core launch reply', () => {
  it('cli road: each adapter with where it was found, override named, fix split off', () => {
    expect(parseCliDetail(CLI_DETAIL)).toEqual([
      {
        adapter: 'claude',
        state: 'absent',
        where: null,
        via: null,
        text: '«claude» not found (searched 51 dirs)',
      },
      {
        adapter: 'qwen',
        state: 'absent',
        where: null,
        via: null,
        text: '«qwen» not found (searched 51 dirs)',
      },
    ]);
    expect(
      parseCliDetail(
        'claude: C:\\bin\\claude.exe (override); unusable qwen: «qwen» refused: not a file',
      ),
    ).toEqual([
      {
        adapter: 'claude',
        state: 'found',
        where: 'C:\\bin\\claude.exe',
        via: 'override',
        text: 'C:\\bin\\claude.exe (override)',
      },
      {
        adapter: 'qwen',
        state: 'refused',
        where: 'qwen',
        via: null,
        text: '«qwen» refused: not a file',
      },
    ]);
    const roads = roadsOf([
      { road: 'cli', status: 'failed', detail: CLI_DETAIL },
      { road: 'disk', status: 'ok', detail: 'free disk 1008.4 GB' },
    ]);
    expect(roads[0]?.fix).toBe('install the CLI or put it on the PATH the core was started with');
    expect(roads[0]?.cli?.length).toBe(2);
    expect(roads[1]).toEqual({
      road: 'disk',
      status: 'ok',
      detail: 'free disk 1008.4 GB',
      fix: null,
      cli: null,
    });
  });

  it('rejected widening repo values are listed with level, path, value and reason', () => {
    const rows = rejectedRows({
      overlay: {
        rejected: [
          {
            level: 4,
            path: 'ciWait',
            value: true,
            reason: "repo-1: .agentdeck/scenario.json: CI wait is the user's live decision",
          },
          { level: 4, path: 'steps.plan.roundCap', value: 9, reason: 'wider than the preset' },
        ],
      },
    });
    expect(rows).toEqual([
      {
        level: 4,
        path: 'ciWait',
        value: 'true',
        reason: "repo-1: .agentdeck/scenario.json: CI wait is the user's live decision",
      },
      { level: 4, path: 'steps.plan.roundCap', value: '9', reason: 'wider than the preset' },
    ]);
  });
});

const line = (seq: number, kind: string, data: unknown) => ({ seq, kind, data });
const UNITS = [
  {
    name: 'api',
    repoKey: 'repo-1',
    ownedPaths: ['src/api/**'],
    deps: [],
    contract: true,
    estimate: { minutes: 5, tokens: 1000 },
  },
  {
    name: 'ui',
    repoKey: 'repo-1',
    ownedPaths: ['src/ui/**'],
    deps: ['api'],
    contract: false,
    estimate: { minutes: null, tokens: null },
  },
];
const GRANT: GrantConfirmation = {
  repoKey: 'repo-1',
  globs: ['db/**'],
  ops: ['edit'],
  matchedOwnedPaths: ['**'],
};

function foldOf(...lines: ReturnType<typeof line>[]): LaunchFold {
  return lines.reduce(foldLaunchLine, EMPTY_FOLD);
}

const awaiting = () =>
  foldOf(
    line(1, 'task.created', { repos: [{ repoKey: 'repo-1' }] }),
    line(2, 'task.transition', { to: 'estimating' }),
    line(3, 'split.proposed', { splitId: SPLIT, by: 'plan', stepId: null, units: UNITS }),
    line(4, 'split.decided', { splitId: SPLIT, outcome: 'accepted', by: 'core', decisionSeq: 3 }),
    line(5, 'task.transition', { to: 'awaiting-launch' }),
  );

describe('core launch fold and gate', () => {
  it('folds the SSE frame lines: proposal, decision, state; a repeated seq is skipped', () => {
    const event = {
      id: '3',
      event: 'split.proposed',
      data: JSON.stringify(
        line(3, 'split.proposed', { splitId: SPLIT, by: 'plan', stepId: null, units: UNITS }),
      ),
    };
    expect(lineOfEvent(event)?.kind).toBe('split.proposed');
    expect(lineOfEvent({ event: 'message', data: 'not json' })).toBeNull();
    const fold = awaiting();
    expect(fold.state).toBe('awaiting-launch');
    expect(fold.split).toMatchObject({ splitId: SPLIT, decided: 'accepted', by: 'plan' });
    expect(fold.repoKeys).toEqual(['repo-1']);
    const given = line(6, 'grant.given', {
      cmdId: CMD,
      project: 'repo-1',
      globs: ['db/**'],
      ops: ['edit'],
    });
    const twice = [given, given].reduce(foldLaunchLine, fold);
    expect(twice.grantsGiven).toHaveLength(1);
  });

  it('grant confirm blocks launch until the journal holds a covering grant', () => {
    const reply = { state: 'estimating' as const, grants: [GRANT] };
    const fold = awaiting();
    expect(launchBlockers({ reply, fold, viewState: null, splitDirty: false })).toEqual([
      'grants-unconfirmed',
    ]);
    // Грант уже по другим операциям не покрывает строку.
    const narrow = foldLaunchLine(
      fold,
      line(6, 'grant.given', { cmdId: CMD, project: 'repo-1', globs: ['db/**'], ops: ['exec-db'] }),
    );
    expect(grantRows([GRANT], narrow.grantsGiven)[0]?.status).toBe('pending');
    const given = foldLaunchLine(
      narrow,
      line(7, 'grant.given', {
        cmdId: CMD,
        project: 'repo-1',
        globs: ['db/**', 'x/**'],
        ops: ['edit'],
      }),
    );
    expect(grantRows([GRANT], given.grantsGiven)[0]?.status).toBe('confirmed');
    expect(launchBlockers({ reply, fold: given, viewState: null, splitDirty: false })).toEqual([]);
    expect(launchCommand(given)).toEqual({ kind: 'approve-split', fields: { splitId: SPLIT } });
  });

  it('a masked repo key cannot be confirmed and blocks launch by name', () => {
    const reply = { state: 'estimating' as const, grants: [{ ...GRANT, repoKey: '••••••' }] };
    expect(launchBlockers({ reply, fold: awaiting(), viewState: null, splitDirty: false })).toEqual(
      ['grant-unreadable'],
    );
  });

  it('gate order: refused task, launched task, pending split, unsaved edit', () => {
    const noGrants = { state: 'estimating' as const, grants: [] };
    expect(
      launchBlockers({
        reply: { ...noGrants, state: 'refused' },
        fold: awaiting(),
        viewState: null,
        splitDirty: false,
      }),
    ).toEqual(['refused']);
    expect(
      launchBlockers({
        reply: noGrants,
        fold: awaiting(),
        viewState: 'running',
        splitDirty: false,
      }),
    ).toEqual(['launched']);
    const pending = foldOf(
      line(1, 'split.proposed', { splitId: SPLIT, by: 'plan', stepId: null, units: UNITS }),
    );
    expect(
      launchBlockers({
        reply: noGrants,
        fold: pending,
        viewState: 'estimating',
        splitDirty: false,
      }),
    ).toEqual(['awaiting-split']);
    expect(launchCommand(pending)).toBeNull();
    expect(
      launchBlockers({ reply: noGrants, fold: awaiting(), viewState: null, splitDirty: true }),
    ).toEqual(['split-unsaved']);
    const refusedSplit = foldLaunchLine(
      pending,
      line(2, 'split.decided', { splitId: SPLIT, outcome: 'refused', by: 'core', decisionSeq: 1 }),
    );
    expect(
      launchBlockers({
        reply: noGrants,
        fold: refusedSplit,
        viewState: 'estimating',
        splitDirty: false,
      }),
    ).toEqual(['split-refused']);
  });

  it('an approved split whose launch failed relaunches with launch, not a second approval', () => {
    const approved = foldLaunchLine(
      awaiting(),
      line(6, 'split.decided', {
        splitId: SPLIT,
        outcome: 'approved',
        by: 'human',
        decisionSeq: 5,
      }),
    );
    expect(launchCommand(approved)).toEqual({ kind: 'launch', fields: {} });
    expect(COMMAND_FIELDS.launch.safeParse({}).success).toBe(true);
    expect(COMMAND_FIELDS['approve-split'].safeParse({ splitId: SPLIT }).success).toBe(true);
  });
});

describe('core launch failures and CLI override', () => {
  const axiosError = (status: number, data: unknown) => ({ response: { status, data } });

  it('classifies 422 problems, 403 authority, 400 issues, 409, proxy refusal and a lost response', () => {
    expect(
      failureOf(
        axiosError(422, { code: 'estimate-refused', problems: ['C:\\x: not a git repository'] }),
      ),
    ).toEqual({
      kind: 'task-refused',
      status: 422,
      problems: ['C:\\x: not a git repository'],
    });
    expect(
      failureOf(axiosError(403, { code: 'signature-required', error: 'peer unknown' })),
    ).toEqual({
      kind: 'authority',
      status: 403,
      code: 'signature-required',
      reason: 'peer unknown',
    });
    expect(
      failureOf(
        axiosError(400, {
          code: 'bad-config',
          issues: [{ path: 'doc.cliPaths', message: 'unknown field' }],
        }),
      ),
    ).toEqual({
      kind: 'invalid',
      status: 400,
      issues: [{ path: 'doc.cliPaths', message: 'unknown field' }],
    });
    expect(failureOf(axiosError(409, { code: 'config-moved', error: 'moved' })).kind).toBe(
      'conflict',
    );
    expect(failureOf(axiosError(503, { code: 'core-absent' }))).toEqual({
      kind: 'refusal',
      status: 503,
      code: 'core-absent',
    });
    expect(failureOf(new Error('Network Error'))).toEqual({
      kind: 'network',
      status: null,
      message: 'Network Error',
    });
    expect(
      failureOfOutcome({
        cmdId: CMD,
        status: 'rejected',
        code: 'unknown-project',
        reason: 'x',
        seq: 3,
      }),
    ).toEqual({
      kind: 'rejected',
      status: null,
      code: 'unknown-project',
      reason: 'x',
    });
    expect(failureOfOutcome({ cmdId: CMD, status: 'applied', seq: 3 })).toBeNull();
  });

  it('cli path override: set keeps other sections and digest, empty path removes the section', () => {
    const view: ConfigView = {
      doc: { routes: { stub: [] }, grantRequired: [] },
      digest: 'a'.repeat(64),
      drift: null,
      issues: [],
    };
    const set = withCliPath(view, 'claude', '  C:\\bin\\claude.exe ');
    expect(set).toEqual({
      doc: { routes: { stub: [] }, grantRequired: [], cliPaths: { claude: 'C:\\bin\\claude.exe' } },
      baseDigest: 'a'.repeat(64),
    });
    const back = { ...view, doc: set.doc };
    expect(cliPathOf(back, 'claude')).toBe('C:\\bin\\claude.exe');
    expect(withCliPath(back, 'claude', '').doc).toEqual({
      routes: { stub: [] },
      grantRequired: [],
    });
  });
});
