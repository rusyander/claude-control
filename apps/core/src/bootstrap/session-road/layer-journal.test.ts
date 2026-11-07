import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { LayerRun } from '../../adapters/adapter.types.ts';
import { CLAUDE_LAYER } from '../../adapters/claude/claude.ts';
import { deps, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { resume, type LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { currentConfigDigest, writeCoreConfig } from '../../platform/core-config/write.ts';
import {
  HOOKS_LOG,
  journalLayerObserved,
  journalLayerStart,
  panelTrusted,
  type LayerStartInput,
} from './layer-journal.ts';

/**
 * Слой человека в журнале сеанса (P87, G-b): `layer.changed` только на смене хеша (и первым
 * сеансом CLI), решение `layer-run`, сигнал `layer-loss` на каждую потерю, сводка `observe`.
 * Опись — настоящая (`claude`) по файлам временного дома.
 */

function lines(task: LiveTask): JournalLine[] {
  return readFileSync(join(task.dir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JournalLine);
}

const run = (over: Partial<LayerRun> = {}): LayerRun => ({
  asked: 'observe',
  ran: 'observe',
  repoLayer: true,
  trust: 'panel',
  ...over,
});

/** Сеанс в свёртке: `layer.changed` ищет CLI по сессии строки. */
function startSession(task: LiveTask, stepId: string, sessionId: string): void {
  task.append({
    kind: 'session.started',
    actor: 'core',
    stepId,
    sessionId,
    data: {
      sessionId,
      stepId,
      adapter: 'claude',
      cliVersion: '1',
      route: { kind: 'stub', id: 'stub-1' },
      hops: [],
      credentialKind: 'none',
      modelAsked: null,
      modelServed: null,
      effort: null,
      hostPid: 1,
      hostStart: 'start-1',
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
}

async function stand() {
  const opened = await openFresh();
  let task = opened.task;
  const root = tempDir('layer-journal-');
  const config = join(root, 'cfg');
  const cwd = join(root, 'work');
  const dir = join(root, 'session');
  for (const d of [config, cwd, dir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(config, 'CLAUDE.md'), 'one\n');
  const base = (
    layer: LayerRun,
    sessionId = newId(),
    spec: LayerStartInput['spec'] = {},
  ): LayerStartInput => {
    const stepId = newId();
    startSession(task, stepId, sessionId);
    return {
      spec,
      task,
      stepId,
      sessionId,
      dir,
      cli: 'claude',
      caps: { skillControl: true },
      inventoryOf: CLAUDE_LAYER.inventory,
      pin: { CLAUDE_CONFIG_DIR: config, HOME: root, USERPROFILE: root },
      cwd,
      skills: 'on',
      layer,
    };
  };
  /** Перезапуск ядра: задача открывается заново из журнала, память прежнего процесса пропала. */
  const reopen = async (): Promise<void> => {
    task.close();
    const again = await resume(opened.dir, opened.taskId, deps());
    if (!again.ok) throw new Error(again.reason);
    task = again.task;
  };
  return {
    get task() {
      return task;
    },
    root,
    config,
    dir,
    base,
    reopen,
  };
}

describe('journalLayerStart', () => {
  it('the start inventory lists hooks of the session plugins (panel kit) and hashes their file', async () => {
    const s = await stand();
    const kit = join(s.root, 'kit');
    mkdirSync(join(kit, 'hooks'), { recursive: true });
    mkdirSync(join(kit, '.claude-plugin'), { recursive: true });
    writeFileSync(join(kit, '.claude-plugin', 'plugin.json'), '{"name":"agentdeck-kit"}');
    const group = { matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'node run.mjs' }] };
    writeFileSync(
      join(kit, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [group] } }),
    );
    const on = run({ asked: 'on', ran: 'on' });
    const bare = journalLayerStart(s.base(on));
    const withKit = journalLayerStart(s.base(on, newId(), { carry: { plugins: [kit] } }));
    expect(bare?.hooks.map((h) => h.key)).toEqual([]);
    expect(withKit?.hooks.map((h) => [h.key, h.matcher])).toEqual([
      ['agentdeck-kit:PreToolUse.0.0', 'Agent|Task'],
    ]);
    // Набор в сеансе — другой слой: хеш другой, `layer.changed` пишется.
    expect(withKit?.hash).not.toBe(bare?.hash);
    expect(lines(s.task).filter((l) => l.kind === 'layer.changed')).toHaveLength(2);
  });

  it('layer.changed on the first session of a CLI and on a changed hash only; decision every session', async () => {
    const s = await stand();
    journalLayerStart(s.base(run()));
    journalLayerStart(s.base(run()));
    writeFileSync(join(s.config, 'CLAUDE.md'), 'two\n');
    journalLayerStart(s.base(run()));
    const all = lines(s.task);
    const changed = all.filter((l) => l.kind === 'layer.changed');
    expect(changed).toHaveLength(2);
    const hashes = changed.map((l) => (l as JournalLine<'layer.changed'>).data.userLayerHash);
    expect(hashes[0]).not.toBe(hashes[1]);
    const decisions = all.filter(
      (l) => l.kind === 'decision' && (l as JournalLine<'decision'>).data.class === 'layer-run',
    ) as JournalLine<'decision'>[];
    expect(decisions).toHaveLength(3);
    expect(decisions[2]!.data.output).toMatchObject({
      asked: { hooks: 'observe', skills: 'on' },
      ran: { hooks: 'observe', skills: 'on' },
      inventoryHash: hashes[1],
    });
  });

  it('a core restart does not rewrite layer.changed for an unchanged layer: the last hash comes from the fold', async () => {
    const s = await stand();
    journalLayerStart(s.base(run()));
    await s.reopen();
    journalLayerStart(s.base(run()));
    expect(lines(s.task).filter((l) => l.kind === 'layer.changed')).toHaveLength(1);
    // Смена слоя после перезапуска — строка есть: свёртка помнит хеш, а не глушит смену.
    writeFileSync(join(s.config, 'CLAUDE.md'), 'three\n');
    journalLayerStart(s.base(run()));
    expect(lines(s.task).filter((l) => l.kind === 'layer.changed')).toHaveLength(2);
  });

  it('each loss is a warn layer-loss signal; observe opens an empty hooks log, off does not', async () => {
    const s = await stand();
    const sessionId = newId();
    journalLayerStart(
      s.base(
        run({ detail: 'observe: y', losses: ['skill x carries its own hooks, not re-supplied'] }),
        sessionId,
      ),
    );
    const signals = lines(s.task)
      .filter((l) => l.kind === 'signal')
      .map((l) => (l as JournalLine<'signal'>).data);
    expect(signals).toEqual([
      {
        signal: 'layer-loss',
        severity: 'warn',
        subject: sessionId,
        detail: 'skill x carries its own hooks, not re-supplied',
      },
    ]);
    expect(readFileSync(join(s.dir, HOOKS_LOG), 'utf8')).toBe('');
    const off = await stand();
    journalLayerStart(off.base(run({ asked: 'off', ran: 'off' })));
    expect(existsSync(join(off.dir, HOOKS_LOG))).toBe(false);
  });
});

describe('journalLayerObserved', () => {
  it('aggregates the recorder log per hook; an unreadable line counts as an error; no log → nothing', async () => {
    const s = await stand();
    const sessionId = newId();
    writeFileSync(
      join(s.dir, HOOKS_LOG),
      [
        { hook: 'PreToolUse.0.0', event: 'PreToolUse', decision: 'allow' },
        { hook: 'PreToolUse.0.0', event: 'PreToolUse', decision: 'wouldBlock' },
        { hook: 'Stop.0.0', event: 'Stop', decision: 'error' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n{broken\n',
    );
    journalLayerObserved(s.task, sessionId, s.dir);
    const observed = lines(s.task).filter((l) => l.kind === 'layer.observed');
    expect(observed.map((l) => (l as JournalLine<'layer.observed'>).data)).toEqual([
      {
        sessionId,
        observations: [
          { hook: 'PreToolUse.0.0', event: 'PreToolUse', calls: 2, wouldBlock: 1, errors: 0 },
          { hook: 'Stop.0.0', event: 'Stop', calls: 1, wouldBlock: 0, errors: 1 },
          { hook: 'unreadable', event: 'unknown', calls: 1, wouldBlock: 0, errors: 1 },
        ],
      },
    ]);
    const none = await stand();
    journalLayerObserved(none.task, sessionId, none.dir);
    expect(lines(none.task).filter((l) => l.kind === 'layer.observed')).toEqual([]);
  });

  it('a log that exists but cannot be read is an error row, never "no log" (F25)', async () => {
    const s = await stand();
    const sessionId = newId();
    // Каталог на месте журнала: путь есть, чтение падает (EISDIR).
    mkdirSync(join(s.dir, HOOKS_LOG));
    journalLayerObserved(s.task, sessionId, s.dir);
    const observed = lines(s.task).filter((l) => l.kind === 'layer.observed');
    expect(observed.map((l) => (l as JournalLine<'layer.observed'>).data.observations)).toEqual([
      [{ hook: 'unreadable', event: 'unknown', calls: 1, wouldBlock: 0, errors: 1 }],
    ]);
  });
});

describe('panelTrusted', () => {
  it('reads config.trustedRepos: listed source → mark, other → none, no config → none', () => {
    const root = tempDir('trust-');
    const layout = { config: join(root, 'config.json') };
    const repo = join(root, 'Repo');
    expect(panelTrusted(layout, repo, 'win32')).toEqual({ mark: false });
    const wrote = writeCoreConfig(
      layout,
      { trustedRepos: [repo] },
      currentConfigDigest(layout),
      newId(),
      { by: 'nonce+peer', warnings: [], at: 1_000 },
    );
    expect(wrote.kind).toBe('applied');
    expect(panelTrusted(layout, repo.toLowerCase(), 'win32')).toEqual({ mark: true });
    expect(panelTrusted(layout, join(root, 'other'), 'win32')).toEqual({ mark: false });
  });
});
