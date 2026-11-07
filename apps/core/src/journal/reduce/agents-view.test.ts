import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { agentsJournalRows } from '../../adapters/claude/__fixtures__/agents-journal.ts';
import { journalLines } from '../../observer/__fixtures__/selftest.ts';
import { foldObserver, initObserverFold } from '../../observer/fold.ts';
import {
  agentsGoldenRows,
  agentsGoldenTree,
  BG_ITEM,
  GHOST,
  SUB,
  SUB_UNKNOWN,
  TEMP_FILE,
  timeless,
  type GoldenIds,
  type GoldenRow,
} from './__fixtures__/agents-golden.ts';
import {
  agentDetailOf,
  agentTreeOf,
  foldAgents,
  initAgentsFold,
  openBgItems,
  stepAgents,
} from './agents-view.ts';

/**
 * Свёртка истории агентов (этап 11, P146-P149) над золотым журналом формы переходника: дерево =
 * золото; расход субагента не идёт родителю; строка расхода с неизвестным родителем ждёт и
 * остаётся ничьей; отсутствующий расход — `null`, не `0`. Конверт строк — тот же, что у пар
 * самопроверки наблюдателя (`journalLines`): тот же `taskId`.
 */

const IDS: GoldenIds = {
  taskId: '01900000-0000-7000-8000-000000000000',
  stepId: '01900000-0000-7000-8000-0000000000c1',
  unitId: '01900000-0000-7000-8000-0000000000e1',
  sessionId: '01900000-0000-7000-8000-0000000000d1',
};

const head: GoldenRow[] = [
  {
    kind: 'step.started',
    stepId: IDS.stepId,
    data: { stepId: IDS.stepId, unitId: IDS.unitId, stepKind: 'work' },
  },
  {
    kind: 'session.started',
    sessionId: IDS.sessionId,
    stepId: IDS.stepId,
    data: {
      sessionId: IDS.sessionId,
      stepId: IDS.stepId,
      modelAsked: 'model-a',
      modelServed: null,
      effort: null,
      hostPid: 4242,
      hostStart: 'start-4242',
    },
  },
];

const golden = (): JournalLine[] =>
  journalLines([...head, ...agentsGoldenRows(IDS), { kind: 'task.ended', data: {} }]);

describe('stage 11 agents fold over the golden journal (P146-P149)', () => {
  it('the tree equals the golden: sessions, subagents and background items with their spend', () => {
    const fold = foldAgents(IDS.taskId, golden());
    const view = agentTreeOf(fold);
    expect(view.seq).toBe(golden().length);
    expect(timeless(view.nodes)).toEqual(agentsGoldenTree(IDS));
    expect(fold.taskEnded).toBe(true);
    expect(openBgItems(fold)).toEqual([]);
  });

  it('subagent usage is never charged to the parent; an unknown parent stays pending, nobody’s', () => {
    const fold = foldAgents(IDS.taskId, golden());
    const tree = agentTreeOf(fold).nodes;
    const byId = new Map(tree.map((n) => [n.nodeId, n]));
    expect(byId.get(IDS.sessionId)?.spend.tokens).toBe(2500);
    expect(byId.get(SUB)?.spend.tokens).toBe(500);
    expect(byId.has(GHOST)).toBe(false);
    expect([...fold.pending.values()]).toEqual([
      expect.objectContaining({ sessionId: IDS.sessionId, parentToolUseId: GHOST, tokens: 7700 }),
    ]);
    // Поздний запуск того же вызова забирает свой расход: строка ждала его, а не родителя.
    const late = foldAgents(
      IDS.taskId,
      journalLines([
        ...head,
        ...agentsGoldenRows(IDS).filter((r) => r.kind !== 'session.transition'),
        {
          ...agentsGoldenRows(IDS)[4]!,
          data: {
            ...(agentsGoldenRows(IDS)[4]!.data as object),
            toolUseId: GHOST,
            cliTaskId: 'cli-g',
          },
        },
      ]),
    );
    expect(agentTreeOf(late).nodes.find((n) => n.nodeId === GHOST)?.spend.tokens).toBe(7700);
    expect(late.pending.size).toBe(0);
  });

  it('absent spend is null («неизвестно»), never 0; the CLI total stands in only without usage rows', () => {
    const fold = foldAgents(IDS.taskId, golden());
    const tree = agentTreeOf(fold).nodes;
    const unknown = tree.find((n) => n.nodeId === SUB_UNKNOWN);
    expect(unknown?.spend).toEqual({ tokens: null, windowShare: null });
    expect(tree.find((n) => n.nodeId === BG_ITEM)?.spend.tokens).toBeNull();
    // Субагент без строк расхода, но с итогом CLI — итог.
    const rows = agentsGoldenRows(IDS).filter(
      (r) =>
        !(
          r.kind === 'turn.usage' &&
          (r.data as { parentToolUseId: unknown }).parentToolUseId === SUB
        ),
    );
    const totalOnly = agentTreeOf(foldAgents(IDS.taskId, journalLines([...head, ...rows])));
    expect(totalOnly.nodes.find((n) => n.nodeId === SUB)?.spend.tokens).toBe(9_999);
  });

  it('a line folds once: replays and out-of-order seqs are skipped; the frame names the touched nodes', () => {
    const lines = golden();
    const fold = initAgentsFold(IDS.taskId);
    const touched = lines.map((l) => stepAgents(fold, l));
    expect(touched[6]).toEqual([SUB, IDS.sessionId]);
    expect(stepAgents(fold, lines[3] as JournalLine)).toEqual([]);
    expect(timeless(agentTreeOf(fold).nodes)).toEqual(agentsGoldenTree(IDS));
  });

  it('node detail: calls paged, files, background items; a running subagent of an ended session is lost', () => {
    const fold = foldAgents(IDS.taskId, golden());
    const main = agentDetailOf(fold, IDS.sessionId, null, { text: 'x', truncated: false });
    expect(main?.toolCalls.items.map((c) => c.toolUseId)).toEqual([
      'toolu_read',
      SUB,
      'toolu_bash',
    ]);
    expect(main?.toolCalls.next).toBeNull();
    expect(main?.files).toEqual([TEMP_FILE]);
    expect(main?.bg.map((b) => b.itemId)).toEqual([BG_ITEM]);
    expect(main?.outputTail).toBeNull();
    const bg = agentDetailOf(fold, BG_ITEM, null, { text: 'tail', truncated: true });
    expect(bg?.outputTail).toEqual({ text: 'tail', truncated: true });
    expect(agentDetailOf(fold, 'nope', null, null)).toBeUndefined();
    // Субагент без конца, а сессия кончилась, — потерян вместе с CLI.
    const open = foldAgents(
      IDS.taskId,
      journalLines([
        ...head,
        ...agentsGoldenRows(IDS).filter(
          (r) => !(r.kind === 'agent.ended' && (r.data as { toolUseId: string }).toolUseId === SUB),
        ),
      ]),
    );
    expect(agentTreeOf(open).nodes.find((n) => n.nodeId === SUB)?.status).toBe('lost');
    expect(agentTreeOf(open, { status: 'lost' }).nodes.map((n) => n.nodeId)).toEqual([SUB]);
    expect(agentTreeOf(open, { class: 'L' }).nodes).toEqual([]);
  });
});

/**
 * Порядок строк, которого переходник обычно не даёт, но журнал допускает (конец раньше начала,
 * повтор начала или конца, крах без конца): вид обязан от него не зависеть. Каждый случай —
 * золотые строки, переставленные или повторённые.
 */
const goldenRow = (kind: GoldenRow['kind'], id?: string): GoldenRow => {
  const row = agentsGoldenRows(IDS).find(
    (r) =>
      r.kind === kind && (id === undefined || (r.data as { toolUseId?: string }).toolUseId === id),
  );
  if (!row) throw new Error(`no golden ${kind} ${id ?? ''}`);
  return row;
};
const withData = (row: GoldenRow, patch: object): GoldenRow => ({
  ...row,
  data: { ...(row.data as object), ...patch },
});
const subUsage = (): GoldenRow[] =>
  agentsGoldenRows(IDS).filter(
    (r) =>
      r.kind === 'turn.usage' && (r.data as { parentToolUseId: unknown }).parentToolUseId === SUB,
  );
const nodeOf = (rows: GoldenRow[], nodeId: string) =>
  agentTreeOf(foldAgents(IDS.taskId, journalLines([...head, ...rows]))).nodes.find(
    (n) => n.nodeId === nodeId,
  );

describe('stage 11 agents fold on every input order (P146)', () => {
  it('an end that came before its start waits for it: the node is ended, not running', () => {
    const sub = nodeOf([goldenRow('agent.ended', SUB), goldenRow('agent.spawned', SUB)], SUB);
    expect(sub).toMatchObject({ status: 'completed', returnExcerpt: expect.any(String) });
    const rows = [goldenRow('bg.ended'), goldenRow('bg.started')];
    const fold = foldAgents(IDS.taskId, journalLines([...head, ...rows]));
    expect(openBgItems(fold)).toEqual([]);
    expect(agentTreeOf(fold).nodes.find((n) => n.nodeId === BG_ITEM)?.status).toBe('completed');
  });

  it('a repeated start keeps the node: status, spend and calls survive the duplicate row', () => {
    const spawned = goldenRow('agent.spawned', SUB);
    const sub = nodeOf([spawned, ...subUsage(), goldenRow('agent.ended', SUB), spawned], SUB);
    expect(sub).toMatchObject({ status: 'completed', spend: { tokens: 500 } });
    const bg = [goldenRow('bg.started'), goldenRow('bg.ended'), goldenRow('bg.started')];
    expect(openBgItems(foldAgents(IDS.taskId, journalLines([...head, ...bg])))).toEqual([]);
    // Повтор начала сессии не обнуляет её расход и вызовы.
    const main = agentsGoldenRows(IDS).filter(
      (r) =>
        (r.kind === 'turn.usage' &&
          (r.data as { parentToolUseId: unknown }).parentToolUseId === null) ||
        r.kind === 'tool.started',
    );
    const once = nodeOf(main, IDS.sessionId);
    expect(once?.spend.tokens).toBe(2500);
    expect(nodeOf([...main, head[1] as GoldenRow], IDS.sessionId)).toEqual(once);
  });

  it('a repeated end keeps the first: the core reaped it, a late CLI end does not rename it', () => {
    const rows = [
      goldenRow('bg.started'),
      withData(goldenRow('bg.ended'), { how: 'reaped' }),
      withData(goldenRow('bg.ended'), { how: 'exit' }),
    ];
    expect(nodeOf(rows, BG_ITEM)?.status).toBe('reaped');
  });

  it('a permit refusal that came before its call’s tool.started moves to the call’s node on arrival', () => {
    const call = 'toolu_09SubBash';
    const refusal: GoldenRow = {
      kind: 'decision',
      sessionId: IDS.sessionId,
      stepId: IDS.stepId,
      data: {
        decisionId: '01900000-0000-7000-8000-0000000000f9',
        class: 'permit',
        inputs: [],
        facts: [],
        numbers: {},
        reasons: ['rm -rf outside the copy'],
        output: { allow: false, toolUseId: call, code: 'permit-denied' },
      },
    };
    const started: GoldenRow = {
      kind: 'tool.started',
      sessionId: IDS.sessionId,
      data: {
        sessionId: IDS.sessionId,
        toolUseId: call,
        parentToolUseId: SUB,
        tool: 'Bash',
        target: 'rm',
      },
    };
    const fold = initAgentsFold(IDS.taskId);
    const lines = journalLines([...head, goldenRow('agent.spawned', SUB), refusal, started]);
    const touched = lines.map((l) => stepAgents(fold, l));
    const view = new Map(agentTreeOf(fold).nodes.map((n) => [n.nodeId, n]));
    expect(view.get(SUB)?.counts.refusals).toBe(1);
    expect(view.get(IDS.sessionId)?.counts.refusals).toBe(0);
    expect(fold.nodes.get(SUB)?.refusals.map((r) => r.toolUseId)).toEqual([call]);
    // Кадр строки начала называет оба узла: у сеанса отказ ушёл, у субагента появился.
    expect(touched.at(-1)).toEqual(expect.arrayContaining([IDS.sessionId, SUB]));
  });

  it('a session end re-frames its open subagents: the stream sees «lost» like the tree does', () => {
    const fold = initAgentsFold(IDS.taskId);
    const lines = journalLines([
      ...head,
      goldenRow('agent.spawned', SUB),
      {
        kind: 'session.transition',
        sessionId: IDS.sessionId,
        data: { sessionId: IDS.sessionId, event: 'host-dead', from: 'live', to: 'lost' },
      },
    ]);
    const touched = lines.map((l) => stepAgents(fold, l));
    expect(touched.at(-1)).toEqual([IDS.sessionId, SUB]);
    expect(agentTreeOf(fold).nodes.find((n) => n.nodeId === SUB)?.status).toBe('lost');
  });
});

/**
 * Те же правила над строками ЖИВОГО прогона Claude Code (зона I1: `agents-journal.jsonl` —
 * субагент `sonnet` + фоновая оболочка, проигранные настоящими нормализатором и кранами). Строка
 * расхода субагента пришла ПОСЛЕ его `agent.ended` и с `parentToolUseId` — она его, не сеанса;
 * повтор `msg_stub_1` с окном контекста заменяет, а не прибавляет.
 */
const probe = (): JournalLine[] =>
  journalLines([
    ...head,
    ...agentsJournalRows(IDS).map((r) => ({
      kind: r.kind as JournalLine['kind'],
      ...(r.stepId ? { stepId: r.stepId } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      data: r.data,
    })),
  ]);

const PROBE_SUB = 'toolu_stub_1_0';
const PROBE_BG = 'b1zqng9u1';

describe('stage 11 agents fold over the recorded Claude probe rows (zone I1 seam)', () => {
  it('session, sonnet subagent and background shell: parents, statuses, excerpts and spend per node', () => {
    const fold = foldAgents(IDS.taskId, probe());
    const byId = new Map(agentTreeOf(fold).nodes.map((n) => [n.nodeId, n]));
    expect([...byId.keys()].sort()).toEqual([IDS.sessionId, PROBE_BG, PROBE_SUB].sort());
    expect(byId.get(IDS.sessionId)).toMatchObject({
      kind: 'unit-session',
      parentId: null,
      status: 'running',
      // msg_stub_1/2/4/5 по 12 токенов бюджета; повтор msg_stub_1 не прибавлен.
      spend: { tokens: 48 },
      counts: { children: 2 },
    });
    expect(byId.get(PROBE_SUB)).toMatchObject({
      kind: 'subagent',
      parentId: IDS.sessionId,
      status: 'completed',
      model: 'sonnet',
      background: true,
      // msg_stub_3 (10 + 0 + 1), пришедший после agent.ended, — расход субагента.
      spend: { tokens: 11 },
      briefExcerpt: 'PROBE_SUB answer DONE',
      returnExcerpt: 'DONE PROBE_SUB',
    });
    expect(byId.get(PROBE_BG)).toMatchObject({
      kind: 'background-shell',
      parentId: IDS.sessionId,
      status: 'completed',
      spend: { tokens: null },
    });
    expect(fold.pending.size).toBe(0);
    expect(openBgItems(fold)).toEqual([]);
  });

  it('the observer stays silent on the clean probe: no spend-misattributed, child-outlived-parent or bg signal', () => {
    let state = initObserverFold();
    const fired: string[] = [];
    for (const line of probe()) {
      const step = foldObserver(state, line, { windowOf: () => null, now: () => 0 });
      expect(step.errors).toEqual([]);
      state = step.state;
      fired.push(...step.verdicts.map((v) => v.signal));
    }
    expect(
      fired.filter((s) =>
        ['spend-misattributed', 'child-outlived-parent', 'bg-orphan', 'bg-hang'].includes(s),
      ),
    ).toEqual([]);
  });

  it('the CLI exits mid-agent: the subagent and the open calls end with the session, in the fold itself', () => {
    // Запись оборвана до `agent.ended` и до результата Bash (CLI упал, хост умер): конца нет.
    const rows = probe().slice(0, head.length + 6);
    const lines = journalLines([
      ...rows.map((l) => ({
        kind: l.kind,
        ...(l.stepId ? { stepId: l.stepId } : {}),
        ...(l.sessionId ? { sessionId: l.sessionId } : {}),
        data: l.data as never,
      })),
      {
        kind: 'session.transition',
        sessionId: IDS.sessionId,
        data: { sessionId: IDS.sessionId, event: 'exited', from: 'live', to: 'ended' },
      },
    ]);
    const end = lines.at(-1) as JournalLine;
    const fold = initAgentsFold(IDS.taskId);
    const touched = lines.map((l) => stepAgents(fold, l));
    const sub = fold.nodes.get(PROBE_SUB);
    expect({ status: sub?.status, endedAt: sub?.endedAt }).toEqual({
      status: 'lost',
      endedAt: end.at,
    });
    expect(touched.at(-1)).toEqual([IDS.sessionId, PROBE_SUB]);
    expect(agentTreeOf(fold, { status: 'running' }).nodes).toEqual([]);
    // Bash сеанса без результата: длительность — до конца сеанса, исход неизвестен.
    const bash = fold.calls.get('toolu_stub_2_0');
    expect(bash?.startedAt).not.toBeNull();
    expect({ ms: bash?.ms, isError: bash?.isError }).toEqual({
      ms: end.at - (bash?.startedAt ?? 0),
      isError: null,
    });
  });
});
