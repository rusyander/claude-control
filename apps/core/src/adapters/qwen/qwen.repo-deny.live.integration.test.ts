import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { LayerRun } from '../adapter.types.ts';
import {
  EventTap,
  HOOK_LOG,
  liveRoot,
  liveSpec,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { createQwenAdapter, QWEN_CHANNELS } from './qwen.ts';

/**
 * F-86 на живом Qwen Code над заглушкой модели: недоверенная копия идёт в безопасном режиме CLI
 * (`.qwen/settings.json` репозитория CLI не читает), но запреты репозитория — `permissions.deny` и
 * `tools.exclude` его файла (JSONC, с комментарием) — ядро читает данными и кладёт в системные
 * настройки сеанса. Ядро на каждый вопрос отвечает «да»: остановить команду-метку и чтение
 * `/secret.txt` может только запрет. Контроль — та же копия без запретов: метка исполняется,
 * секрет читается.
 */

const present = hasCli(qwenRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];
const SECRET = 'REPO_DENY_SECRET_q81c';
const MARKER = 'repo-deny-marker';

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

interface Run {
  layer: LayerRun;
  markerRan: boolean;
  secretRead: boolean;
}

async function run(prefix: string, repoSettings: string | null): Promise<Run> {
  const live = liveRoot(prefix);
  roots.push(live);
  const source = join(live.root, 'source');
  if (repoSettings !== null) {
    mkdirSync(join(source, '.qwen'), { recursive: true });
    writeFileSync(join(source, '.qwen', 'settings.json'), repoSettings);
  }
  writeFileSync(join(live.cwd, 'secret.txt'), `${SECRET}\n`);
  const stub = await startStubModel({
    script: {
      steps: [
        { tool: { name: 'run_shell_command', args: { command: `mkdir ${MARKER}` } } },
        { tool: { name: 'read_file', args: { file_path: join(live.cwd, 'secret.txt') } } },
        'DONE_MARKER',
      ],
    },
  });
  stubs.push(stub);
  const adapter = createQwenAdapter();
  const spec = liveSpec(live, {
    coreHook: `node ${HOOK_LOG} core --log ${live.logs.core}`,
    permitServer: { name: 'agentdeck-permit', tool: 'approve' },
    endpoint: {
      channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
      endpoint: { baseUrl: stub.baseUrl, dialect: 'openai-chat', model: 'stub-model', key: 'k' },
    },
  });
  spec.trust = { sourceRepo: source, panelMark: false };
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'make the marker, read the secret', crypto.randomUUID());
    for (;;) {
      const event = await tap.until(
        (e) => e.type === 'permit.request' || e.type === 'turn.ended',
        150_000,
      );
      if (event.type === 'turn.ended') {
        expect(event.text).toBe('DONE_MARKER');
        break;
      }
      if (event.type !== 'permit.request') continue;
      const input = (event.raw as { input?: Record<string, unknown> }).input ?? {};
      await adapter.answerPermit?.(launched.handle, event.requestId, {
        behavior: 'allow',
        updatedInput: input,
      });
    }
  } finally {
    await adapter.stop(launched.handle, 'tree');
  }
  return {
    layer: launched.layer,
    markerRan: existsSync(join(live.cwd, MARKER)),
    secretRead: stub.bodies.join('\n').includes(SECRET),
  };
}

describe.skipIf(!present)('qwen adapter on the real CLI — F-86 repo deny in a copy', () => {
  it('F-86 control: an untrusted copy whose source repo denies nothing runs the marker and reads the secret', async () => {
    const result = await run('qwen-f86-deny-ctl-', null);
    expect(result.layer).toMatchObject({ repoLayer: false, trust: 'none' });
    expect(result.markerRan).toBe(true);
    expect(result.secretRead).toBe(true);
  }, 240_000);

  it("F-86: an untrusted copy keeps the source repo's permissions.deny and tools.exclude (JSONC)", async () => {
    const settings = [
      '{',
      '  // repo deny rules: data for the core, never loaded as settings',
      '  "permissions": { "deny": ["run_shell_command(mkdir:*)"] },',
      '  /* tools.exclude merges into the deny list */',
      '  "tools": { "exclude": ["read_file(/secret.txt)"] }',
      '}',
    ].join('\n');
    const result = await run('qwen-f86-deny-', settings);
    expect(result.layer).toMatchObject({ repoLayer: false, trust: 'none' });
    expect(result.markerRan).toBe(false);
    expect(result.secretRead).toBe(false);
    expect(result.layer.detail).toMatch(/2 repo deny rules carried/);
  }, 240_000);
});
