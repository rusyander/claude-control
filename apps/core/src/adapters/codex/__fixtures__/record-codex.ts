import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { startStubModel } from '@agentdeck/stub-model';
import type { SessionSpec } from '../../adapter.types.ts';
import {
  EventTap,
  HOOK_LOG,
  liveRoot,
  livePin,
  liveSpec,
} from '../../conformance/__fixtures__/live.ts';
import {
  installRpcScript,
  RPC_TEE,
  withBinFirst,
  rpcFixturePath,
} from '../../conformance/__fixtures__/rpc-replay.ts';
import { CODEX_CHANNELS, codexHookCommand, createCodexAdapter } from '../codex.ts';

/**
 * Запись живого Codex для набора соответствия (`rpc.conformance.test.ts`): настоящий
 * `codex app-server` за записывающей обёрткой, модель — заглушка (ключи не тратятся), хук ядра —
 * подставной `hook-log.mjs` (разрешает; `blocked` — отказывает). Запуск руками, когда меняется
 * версия CLI: `node --experimental-strip-types --no-warnings record-codex.ts`.
 */

/**
 * Запись идёт в публичный репозиторий: имя пользователя и машины (`serverName`, пути профиля) и
 * id установки Codex заменяются нейтральными значениями. Проигрыванию они не нужны.
 */
function scrub(text: string): string {
  const names = [userInfo().username, hostname()].filter((n) => n.length > 2);
  let out = text.replace(
    /"installationId\\":\\"[0-9a-f-]+\\"/g,
    '"installationId\\":\\"00000000-0000-4000-8000-000000000000\\"',
  );
  for (const name of names) out = out.split(name).join('user');
  return out;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface Scenario {
  name: string;
  deny?: true;
  script: (raw: string) => unknown;
  turns: { cmdId: string; text: string }[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'basic',
    script: (raw) => (raw.includes('SECOND_TURN') ? 'ANSWER_TWO' : 'ANSWER_ONE'),
    turns: [
      { cmdId: A, text: 'FIRST_TURN say one' },
      { cmdId: B, text: 'SECOND_TURN say two' },
    ],
  },
  {
    name: 'permit',
    script: (raw) =>
      raw.includes('function_call_output')
        ? 'PERMIT_DONE'
        : { tool: { name: 'exec_command', args: { cmd: 'echo hi' } } },
    turns: [{ cmdId: A, text: 'run a command' }],
  },
  {
    name: 'blocked',
    deny: true,
    script: (raw) =>
      raw.includes('function_call_output')
        ? 'BLOCKED_SEEN'
        : { tool: { name: 'exec_command', args: { cmd: 'git push origin main' } } },
    turns: [{ cmdId: A, text: 'publish' }],
  },
];

const realCodex = join(
  execSync('npm root -g', { encoding: 'utf8' }).trim(),
  '@openai',
  'codex',
  'bin',
  'codex.js',
);
if (!existsSync(realCodex)) throw new Error(`codex.js not found at ${realCodex}`);
const version = execSync('codex --version', { encoding: 'utf8' }).trim();

for (const scenario of SCENARIOS) {
  const live = liveRoot(`codex-rec-${scenario.name}-`);
  const stub = await startStubModel({ script: (ctx) => scenario.script(ctx.request.raw) as never });
  const out = rpcFixturePath('codex', scenario.name);
  const tape = join(live.root, 'tape.jsonl');
  const bin = join(live.root, 'bin');
  installRpcScript(bin, 'codex', RPC_TEE);
  const base = liveSpec(live);
  const pin = livePin(live, { RPC_TEE_REAL: realCodex, RPC_TEE_OUT: tape });
  const spec: SessionSpec = {
    ...base,
    coreHook: `${process.execPath} ${HOOK_LOG} core${scenario.deny ? ' --deny' : ''}`,
    permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    endpoint: {
      channel: CODEX_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'openai-responses',
        model: 'stub-model',
        key: 'stub-key',
      },
    },
    env: { pin: withBinFirst(pin, bin) },
  };
  const adapter = createCodexAdapter({ pollMs: 20 });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  for (const turn of scenario.turns) {
    await adapter.send(launched.handle, turn.text, turn.cmdId);
    for (;;) {
      const ev = await tap.until(
        (e) => e.type === 'permit.request' || e.type === 'turn.ended',
        120_000,
      );
      if (ev.type === 'turn.ended') break;
      if (ev.type === 'permit.request') {
        await adapter.answerPermit!(launched.handle, ev.requestId, { decision: 'accept' });
      }
    }
  }
  await adapter.stop(launched.handle, 'soft');
  await stub.close();
  const meta = { version, hookCommand: codexHookCommand(spec), dir: spec.dir, cwd: spec.cwd };
  writeFileSync(out, scrub(`${JSON.stringify({ meta })}\n${readFileSync(tape, 'utf8')}`));
  console.log(`${scenario.name}: ${tap.seen.map((e) => e.type).join(',')}`);
  rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}
