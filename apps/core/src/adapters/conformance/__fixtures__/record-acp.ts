import { execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { gooseRunFacts } from '@agentdeck/providers/goose';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
import { startStubModel } from '@agentdeck/stub-model';
import type { AdapterChannelSummary, SessionSpec } from '../../adapter.types.ts';
import { createGooseAdapter, GOOSE_CHANNELS } from '../../goose/index.ts';
import { createOpencodeAdapter, OPENCODE_CHANNELS } from '../../opencode/index.ts';
import type { RpcAdapter } from '../../rpc-stdio/rpc-adapter.ts';
import { EventTap, HOOK_LOG, liveRoot, livePin, liveSpec } from './live.ts';
import { installRpcScript, RPC_TEE, rpcFixturePath, withBinFirst } from './rpc-replay.ts';
import { dirname, join } from 'node:path';

/**
 * Запись живых goose и opencode (ACP по stdio) для набора соответствия `rpc.conformance.test.ts`:
 * настоящий CLI за записывающей обёрткой `rpc-tee.mjs`, модель — stub-model (ключи не тратятся),
 * хук ядра — подставной `hook-log.mjs` (разрешает; `blocked` — отказывает). Вопросы о праве
 * запись разрешает: отказ в `blocked` — дело хука. Запуск руками при смене версии CLI:
 * `AGENTDECK_LIVE_BASE=… node --experimental-strip-types --no-warnings record-acp.ts [goose|opencode]`.
 */

/** Запись идёт в публичный репозиторий: имя пользователя и машины заменяются. */
function scrub(text: string): string {
  const names = [userInfo().username, hostname()].filter((n) => n.length > 2);
  let out = text;
  for (const name of names) out = out.split(name).join('user');
  return out;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface Cli {
  id: string;
  make: () => RpcAdapter;
  channel: AdapterChannelSummary;
  /** Вызов оболочки в ответе модели openai-chat. */
  shell: (command: string) => { tool: { name: string; args: Record<string, string> } };
}

const CLIS: Cli[] = [
  {
    id: gooseRunFacts.id,
    make: () => createGooseAdapter({ pollMs: 20 }),
    channel: GOOSE_CHANNELS[0]!,
    shell: (command) => ({ tool: { name: 'developer__shell', args: { command } } }),
  },
  {
    id: opencodeRunFacts.id,
    make: () => createOpencodeAdapter({ pollMs: 20 }),
    channel: OPENCODE_CHANNELS[0]!,
    shell: (command) => ({ tool: { name: 'bash', args: { command, description: 'run' } } }),
  },
];

interface Scenario {
  name: 'basic' | 'permit' | 'blocked';
  deny?: true;
  script: (cli: Cli, raw: string) => unknown;
  turns: { cmdId: string; text: string }[];
}

const toolDone = (raw: string): boolean => raw.includes('"role":"tool"');

const SCENARIOS: Scenario[] = [
  {
    name: 'basic',
    script: (_cli, raw) => (raw.includes('SECOND_TURN') ? 'ANSWER_TWO' : 'ANSWER_ONE'),
    turns: [
      { cmdId: A, text: 'FIRST_TURN say one' },
      { cmdId: B, text: 'SECOND_TURN say two' },
    ],
  },
  {
    name: 'permit',
    script: (cli, raw) => (toolDone(raw) ? 'PERMIT_DONE' : cli.shell('echo hi')),
    turns: [{ cmdId: A, text: 'run a command' }],
  },
  {
    name: 'blocked',
    deny: true,
    script: (cli, raw) => (toolDone(raw) ? 'BLOCKED_SEEN' : cli.shell('git push origin main')),
    turns: [{ cmdId: A, text: 'publish' }],
  },
];

/** Настоящий исполняемый файл CLI (не обёртка npm): его запускает `rpc-tee`. */
function realBinary(command: string): string {
  const found = execSync(process.platform === 'win32' ? `where ${command}` : `which ${command}`, {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const exe = found.find((f) => /\.exe$/i.test(f));
  if (exe) return exe;
  const shim = found[0];
  if (!shim) throw new Error(`${command} not found`);
  // Обёртка npm opencode-ai: настоящий файл — в пакете рядом с обёрткой (префикс npm бывает
  // не тем, что печатает `npm root -g`, — nvm и пользовательский префикс).
  return join(
    dirname(shim),
    'node_modules',
    'opencode-ai',
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode',
  );
}

const only = process.argv[2];
for (const cli of CLIS.filter((c) => !only || c.id === only)) {
  const real = realBinary(cli.id);
  const version = execSync(`"${real}" --version`, { encoding: 'utf8' }).trim().split(/\s+/).pop()!;
  for (const scenario of SCENARIOS) {
    const live = liveRoot(`${cli.id}-rec-${scenario.name}-`);
    const stub = await startStubModel({
      script: (ctx) => scenario.script(cli, ctx.request.raw) as never,
    });
    const out = rpcFixturePath(cli.id, scenario.name);
    const tape = join(live.root, 'tape.jsonl');
    const bin = join(live.root, 'bin');
    installRpcScript(bin, cli.id, RPC_TEE);
    const base = liveSpec(live);
    const keep: Record<string, string> = {};
    for (const name of ['TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
      if (process.env[name] !== undefined) keep[name] = process.env[name]!;
    }
    const pin = livePin(live, { ...keep, RPC_TEE_REAL: real, RPC_TEE_OUT: tape });
    const q = (p: string): string => `"${p}"`;
    const spec: SessionSpec = {
      ...base,
      coreHook: `${q(process.execPath)} ${q(HOOK_LOG)} core${scenario.deny ? ' --deny' : ''}`,
      permitServer: { name: 'agentdeck-permit', tool: 'permit' },
      endpoint: {
        channel: cli.channel,
        endpoint: {
          baseUrl: stub.baseUrl,
          dialect: 'openai-chat',
          model: 'stub-model',
          key: 'stub-key',
        },
      },
      env: { pin: withBinFirst(pin, bin) },
    };
    const adapter = cli.make();
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
    const meta = {
      cli: cli.id,
      version,
      recorded: new Date().toISOString().slice(0, 10),
      how: `${cli.id} acp, own home per session, hook-log core hook, stub-model openai-chat`,
      hookCommand: spec.coreHook,
      dir: spec.dir,
      cwd: spec.cwd,
    };
    writeFileSync(out, scrub(`${JSON.stringify({ meta })}\n${readFileSync(tape, 'utf8')}`));
    console.log(`${cli.id} ${scenario.name}: ${tap.seen.map((e) => e.type).join(',')}`);
    rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
  }
}
