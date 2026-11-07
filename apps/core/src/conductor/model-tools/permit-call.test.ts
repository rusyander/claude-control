import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { mapQwenPermission } from '../../adapters/qwen/permission.ts';
import { SDK_PERMIT_CODEC } from '../../adapters/sdk-stream/permit-codec.ts';
import { openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { permitRefusalOf } from '../../observer/waste/facts.ts';
import { createPendingPermits } from '../../policy/permit/pending.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { seedSession } from './__fixtures__/seed.ts';
import { bindingOf } from './binding.ts';
import type { PermitCallDeps } from './model-tools.types.ts';
import { answerPermitCall, FORGED_AUTHORITY } from './permit-call.ts';

/**
 * `agentdeck-permit` (06 §Session permissions, R:S3-09, P41): вопрос о праве законен только
 * как ответ на запрос инструмента, который модель сделала и который ещё не исполнен.
 * Решает `policy/permit` по типизированным фактам; текст команды не запрещает ничего.
 */

const SELF = 'mcp__agentdeck-permit__approve';

function context(copyRoot: string): PermitContext {
  return {
    copyRoot,
    ownedPaths: ['src/**'],
    deny: { paths: [], commands: [['git', 'push']], mcpTools: ['mcp__forge__*'], tools: [] },
    platformPaths: [tempDir('home-')],
    endpointSources: [`${copyRoot}/.env.prod`],
    grantRequired: [{ globs: ['migrations/**'], ops: ['edit'] }],
    grants: [],
  };
}

async function setup(stepKind = 'work') {
  const { task } = await openFresh();
  const seeded = seedSession(task, { stepKind });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const gate = createPendingPermits({ selfToolNames: [SELF] });
  const copyRoot = tempDir('copy-');
  const permitDeps: PermitCallDeps = {
    gate,
    codec: SDK_PERMIT_CODEC,
    mapPermission: mapClaudePermission,
    context: context(copyRoot),
    settleMs: 80,
  };
  const requested = (toolUseId: string, name: string) =>
    gate.observe(seeded.sessionId, {
      type: 'tool.requested',
      toolUseId,
      name,
      input: {},
    } as never);
  const signals = () =>
    readJournalLines(task.dir, task.taskId)
      .lines.filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { signal: string }).signal);
  return { task, b: bound.binding, gate, permitDeps, requested, signals, copyRoot, ...seeded };
}

const raw = (tool: string, toolUseId: string, input: Record<string, unknown> = {}) => ({
  tool_name: tool,
  input,
  tool_use_id: toolUseId,
});

describe('agentdeck-permit', () => {
  it('P41 a permit call answering no pending request is refused and journals forged-authority', async () => {
    const s = await setup();
    // Выдуманный id: запроса модели нет.
    const none = await answerPermitCall(s.task, s.b, raw('Bash', 'toolu_x'), s.permitDeps);
    expect(none).toMatchObject({ kind: 'forged', reply: { behavior: 'deny' } });
    // Без id вызова вопрос ничему не отвечает.
    const noId = await answerPermitCall(
      s.task,
      s.b,
      { tool_name: 'Bash', input: {} },
      s.permitDeps,
    );
    expect(noId.kind).toBe('forged');
    // Имя не совпало с запрошенным.
    s.requested('toolu_1', 'Read');
    const renamed = await answerPermitCall(s.task, s.b, raw('Bash', 'toolu_1'), s.permitDeps);
    expect(renamed.kind).toBe('forged');
    // Модель позвала сам сервер права как инструмент.
    s.requested('toolu_2', SELF);
    const self = await answerPermitCall(s.task, s.b, raw(SELF, 'toolu_2'), s.permitDeps);
    expect(self.kind).toBe('forged');
    // Вызов уже исполнен.
    s.requested('toolu_3', 'Read');
    s.gate.observe(s.sessionId, {
      type: 'tool.result',
      toolUseId: 'toolu_3',
      isError: false,
      cliInitiated: false,
    });
    const finished = await answerPermitCall(s.task, s.b, raw('Read', 'toolu_3'), s.permitDeps);
    expect(finished.kind).toBe('forged');
    expect(s.signals()).toEqual(Array(5).fill(FORGED_AUTHORITY));
    expect(
      readJournalLines(s.task.dir, s.task.taskId).lines.some((l) => l.kind === 'decision'),
    ).toBe(false);
    s.task.close();
  });

  it('P41 a pending request is answered once; a replayed answer is forged', async () => {
    const s = await setup();
    s.requested('toolu_r', 'Read');
    const first = await answerPermitCall(
      s.task,
      s.b,
      raw('Read', 'toolu_r', { file_path: 'src/a.ts' }),
      s.permitDeps,
    );
    expect(first).toMatchObject({
      kind: 'decided',
      allow: true,
      reply: { behavior: 'allow', updatedInput: { file_path: 'src/a.ts' } },
    });
    const replay = await answerPermitCall(
      s.task,
      s.b,
      raw('Read', 'toolu_r', { file_path: 'src/a.ts' }),
      s.permitDeps,
    );
    expect(replay.kind).toBe('forged');
    const decisions = readJournalLines(s.task.dir, s.task.taskId).lines.filter(
      (l) => l.kind === 'decision',
    );
    expect(decisions.map((l) => (l.data as { class: string }).class)).toEqual(['permit']);
    s.task.close();
  });

  it('stage 8: the permit decision row names the CLI call id and tool, so a hook refusal and a permit refusal of one call count once', async () => {
    const s = await setup();
    s.requested('toolu_p', 'Bash');
    const got = await answerPermitCall(
      s.task,
      s.b,
      raw('Bash', 'toolu_p', { command: 'git push' }),
      s.permitDeps,
    );
    expect(got).toMatchObject({ kind: 'decided', allow: false });
    const line = readJournalLines(s.task.dir, s.task.taskId).lines.find(
      (l) => l.kind === 'decision',
    )!;
    const refusal = permitRefusalOf(line);
    expect(refusal).toMatchObject({ toolUseId: 'toolu_p', tool: 'Bash', action: 'exec' });
    s.task.close();
  });

  it('a permit call that arrives before the stream shows the request waits for it', async () => {
    const s = await setup();
    const pending = answerPermitCall(s.task, s.b, raw('Read', 'toolu_late'), {
      ...s.permitDeps,
      settleMs: 2_000,
    });
    setTimeout(() => s.requested('toolu_late', 'Read'), 30);
    expect(await pending).toMatchObject({ kind: 'decided', allow: true });
    s.task.close();
  });

  it.each(['intake', 'plan', 'split', 'research'])(
    'a %s step is read-only: edit and shell are denied on the permit road, read passes',
    async (kind) => {
      const s = await setup(kind);
      s.requested('toolu_e', 'Edit');
      const edit = await answerPermitCall(
        s.task,
        s.b,
        raw('Edit', 'toolu_e', { file_path: 'src/a.ts' }),
        s.permitDeps,
      );
      expect(edit).toMatchObject({ kind: 'decided', allow: false, reply: { behavior: 'deny' } });
      s.requested('toolu_x', 'Bash');
      const shell = await answerPermitCall(
        s.task,
        s.b,
        raw('Bash', 'toolu_x', { command: 'ls' }),
        s.permitDeps,
      );
      expect(shell).toMatchObject({ kind: 'decided', allow: false });
      s.requested('toolu_r', 'Read');
      const read = await answerPermitCall(
        s.task,
        s.b,
        raw('Read', 'toolu_r', { file_path: 'src/a.ts' }),
        s.permitDeps,
      );
      expect(read).toMatchObject({ kind: 'decided', allow: true });
      const outputs = readJournalLines(s.task.dir, s.task.taskId)
        .lines.filter((l) => l.kind === 'decision')
        .map((l) => (l.data as unknown as { output: { allow: boolean; code?: string } }).output);
      expect(outputs.map((o) => [o.allow, o.code])).toEqual([
        [false, 'read-only-step'],
        [false, 'read-only-step'],
        [true, undefined],
      ]);
      s.task.close();
    },
  );

  it('a denied edit renders the CLI deny form; an edit outside owned paths is allowed with an ownership signal', async () => {
    const s = await setup();
    s.requested('toolu_m', 'Edit');
    const grant = await answerPermitCall(
      s.task,
      s.b,
      raw('Edit', 'toolu_m', { file_path: 'migrations/001.sql' }),
      s.permitDeps,
    );
    expect(grant).toMatchObject({ kind: 'decided', allow: false, reply: { behavior: 'deny' } });
    s.requested('toolu_o', 'Edit');
    const owned = await answerPermitCall(
      s.task,
      s.b,
      raw('Edit', 'toolu_o', { file_path: 'docs/readme.md' }),
      s.permitDeps,
    );
    expect(owned).toMatchObject({ kind: 'decided', allow: true });
    expect(s.signals()).toEqual(['ownership']);
    s.task.close();
  });

  it.each([
    ['claude', 'Bash', mapClaudePermission],
    ['qwen', 'run_shell_command', mapQwenPermission],
  ] as const)(
    'a %s shell call is denied by the argv prefix of the platform deny set, never by its text',
    async (_cli, shell, mapPermission) => {
      const s = await setup();
      const deps = { ...s.permitDeps, mapPermission };
      const call = async (id: string, command: string) => {
        s.requested(id, shell);
        return answerPermitCall(s.task, s.b, raw(shell, id, { command }), deps);
      };
      expect(await call('toolu_p1', 'git push origin main')).toMatchObject({
        kind: 'decided',
        allow: false,
        reply: { behavior: 'deny' },
      });
      expect(await call('toolu_p2', "GIT_TRACE=1 'git'  push --force")).toMatchObject({
        allow: false,
      });
      // Те же слова не первыми — не публикация.
      expect(await call('toolu_p3', 'echo git push')).toMatchObject({ allow: true });
      expect(await call('toolu_p4', 'git status')).toMatchObject({ allow: true });
      s.task.close();
    },
  );

  it.each([
    ['claude', 'Bash', mapClaudePermission],
    ['qwen', 'run_shell_command', mapQwenPermission],
  ] as const)(
    'P28 a %s shell call cannot hide git push behind global options, an alias, a wrapper or a path',
    async (_cli, shell, mapPermission) => {
      const s = await setup();
      const deps = { ...s.permitDeps, mapPermission };
      let n = 0;
      const call = async (command: string) => {
        const id = `toolu_h${++n}`;
        s.requested(id, shell);
        return answerPermitCall(s.task, s.b, raw(shell, id, { command }), deps);
      };
      for (const command of [
        'git -c remote.origin.pushurl=https://x/y.git push',
        'git -C ../copy push origin',
        'git --git-dir=.git --work-tree . push',
        "git -c 'alias.ship=push --force' ship",
        'git -c "alias.s=!git push origin" s',
        'env -i git push',
        'command git push',
        '/usr/bin/git push',
        'echo ok && git push',
        '(cd sub; git push)',
        'git config alias.p push',
        'git --config-env=alias.p=ALIAS p',
        'eval "git push"',
        'echo $(git push)',
      ]) {
        expect(await call(command), command).toMatchObject({
          kind: 'decided',
          allow: false,
          reply: { behavior: 'deny' },
        });
      }
      expect(await call('git -C push status')).toMatchObject({ allow: true });
      expect(await call('git -c alias.f=fetch f')).toMatchObject({ allow: true });
      s.task.close();
    },
  );
});

describe('policy/permit decidePermit', () => {
  const root = tempDir('copy-');
  const ctx = context(root);
  const ask = (a: Partial<PermissionAsk>): PermissionAsk => ({
    action: 'read',
    target: '',
    tool: 'T',
    display: '',
    ...a,
  });

  it('a step permit: read-only kinds refuse edit and exec, an unknown kind is read-only, work passes to the path and argv rules', () => {
    const edit = ask({ action: 'edit', target: 'src/a.ts' });
    const exec = ask({ action: 'exec', target: 'ls', argv: ['ls'] });
    for (const kind of ['intake', 'plan', 'split', 'review', 'research', 'nope']) {
      expect(decidePermit(edit, ctx, kind), kind).toMatchObject({
        allow: false,
        code: 'read-only-step',
        humanPoint: null,
      });
      expect(decidePermit(exec, ctx, kind), kind).toMatchObject({ code: 'read-only-step' });
      expect(decidePermit(ask({ target: 'src/a.ts' }), ctx, kind), kind).toMatchObject({
        allow: true,
      });
    }
    expect(decidePermit(edit, ctx, 'work')).toMatchObject({ allow: true });
    expect(decidePermit(exec, ctx, 'fix')).toMatchObject({ allow: true });
    // Вид шага не отменяет прочих правил: работа всё равно не толкает ветку сама.
    expect(decidePermit(ask({ action: 'exec', argv: ['git', 'push'] }), ctx, 'work')).toMatchObject(
      { code: 'platform-step' },
    );
    // Без вида шага (оверлей, хук ядра) правило вида молчит.
    expect(decidePermit(edit, ctx)).toMatchObject({ allow: true });
  });

  it('decides by typed facts: paths, argv prefix, MCP deny set, unknown class', () => {
    expect(decidePermit(ask({ action: 'read', target: 'src/a.ts' }), ctx)).toMatchObject({
      allow: true,
    });
    expect(decidePermit(ask({ action: 'read', target: ctx.platformPaths[0] }), ctx)).toMatchObject({
      allow: false,
      code: 'platform-path',
    });
    expect(decidePermit(ask({ action: 'read', target: '.env.prod' }), ctx)).toMatchObject({
      allow: false,
      code: 'endpoint-source',
      humanPoint: 3,
    });
    expect(decidePermit(ask({ action: 'edit', target: '../outside.ts' }), ctx)).toMatchObject({
      allow: false,
      code: 'outside-copy',
    });
    expect(decidePermit(ask({ action: 'edit', target: 'migrations/1.sql' }), ctx)).toMatchObject({
      allow: false,
      code: 'grant-required',
      humanPoint: 5,
    });
    const granted = { ...ctx, grants: [{ globs: ['migrations/**'], ops: ['edit' as const] }] };
    expect(
      decidePermit(ask({ action: 'edit', target: 'migrations/1.sql' }), granted),
    ).toMatchObject({ allow: true, signal: 'ownership' });
    expect(decidePermit(ask({ action: 'edit', target: 'src/a.ts' }), ctx)).toMatchObject({
      allow: true,
      signal: null,
    });
    expect(
      decidePermit(ask({ action: 'exec', target: 'git', argv: ['git', 'push', 'origin'] }), ctx),
    ).toMatchObject({ allow: false, code: 'platform-step' });
    // Текст команды ничего не запрещает: `echo git push` — не публикация.
    expect(
      decidePermit(ask({ action: 'exec', target: 'echo', argv: ['echo', 'git', 'push'] }), ctx),
    ).toMatchObject({ allow: true });
    expect(decidePermit(ask({ action: 'mcp', target: 'mcp__forge__merge' }), ctx)).toMatchObject({
      allow: false,
      code: 'denied-tool',
    });
    expect(decidePermit(ask({ action: 'mcp', target: 'mcp__docs__read' }), ctx)).toMatchObject({
      allow: true,
    });
    expect(decidePermit(ask({ action: 'net', target: 'https://x' }), ctx)).toMatchObject({
      allow: true,
    });
    expect(decidePermit(ask({ action: 'other', target: 'Weird' }), ctx)).toMatchObject({
      allow: false,
      code: 'unknown-action',
    });
  });
});
