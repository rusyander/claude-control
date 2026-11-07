import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { codexRunFacts } from '@agentdeck/providers/codex';
import { gooseRunFacts } from '@agentdeck/providers/goose';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import type { Dialect } from '@agentdeck/contracts/core/routes';
import type { AdapterChannelSummary, CliAdapter } from '../../adapters/index.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../../adapters/claude/claude.ts';
import { CODEX_CHANNELS, createCodexAdapter } from '../../adapters/codex/codex.ts';
import { CODEX_HOME_DIR } from '../../adapters/codex/transcript.ts';
import { createGooseAdapter, GOOSE_CHANNELS } from '../../adapters/goose/goose.ts';
import { createOpencodeAdapter, OPENCODE_CHANNELS } from '../../adapters/opencode/opencode.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../../adapters/qwen/qwen.ts';
import {
  liveRoot,
  livePin,
  liveSpec,
  type LiveRoot,
} from '../../adapters/conformance/__fixtures__/live.ts';
import {
  realCoreHook,
  startFakeCore,
  type FakeCore,
} from '../../adapters/conformance/__fixtures__/p81-stand.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { probeOnStub } from './context.ts';

/**
 * Проба базы не оставляет разговора (s11 w3): настоящий CLI на заглушке модели, одноразовый дом
 * (HOME/USERPROFILE/APPDATA — хранилища транскриптов CLI под ним) и рабочая папка. После пробы ни
 * один файл дома и рабочей папки не несёт метку пробы: иначе панель, которая читает хранилище CLI,
 * показывает её строкой «AGENTDECK_BASE_PROBE <id>» в списке чатов человека. Замер при этом жив —
 * первый запрос к заглушке несёт метку (проба не «прошла» потому, что не запускалась).
 */

const MARK = 'AGENTDECK_BASE_PROBE';
/** Транскрипты CLI — строки JSON и базы: больше этого файлы дома (кэши, бинарники) не читаются. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

interface Cli {
  id: string;
  present: boolean;
  make: () => CliAdapter;
  channel: AdapterChannelSummary | undefined;
  dialect: Dialect;
  /** Хранилище разговоров CLI внутри каталога сеанса (флаг CLI обязан оставить его без пробы). */
  store?: (dir: string) => string;
}

const CLIS: Cli[] = [
  {
    id: 'claude',
    present: hasCli(claudeRunFacts.binary.command),
    make: () => createClaudeAdapter(),
    channel: CLAUDE_CHANNELS[0],
    dialect: 'anthropic-messages',
  },
  {
    id: 'qwen',
    present: hasCli(qwenRunFacts.binary.command),
    make: () => createQwenAdapter({ pollMs: 20 }),
    channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat'),
    dialect: 'openai-chat',
  },
  {
    id: 'codex',
    present: hasCli(codexRunFacts.binary.command),
    make: () => createCodexAdapter({ pollMs: 20 }),
    channel: CODEX_CHANNELS[0],
    dialect: 'openai-responses',
    // Дом Codex — свой у сеанса; эфемерная нить не кладёт туда даже файл разговора.
    store: (dir) => join(dir, CODEX_HOME_DIR, 'sessions'),
  },
  {
    id: 'goose',
    present: hasCli(gooseRunFacts.binary.command),
    make: () => createGooseAdapter({ pollMs: 20 }),
    channel: GOOSE_CHANNELS[0],
    dialect: 'openai-chat',
  },
  {
    id: 'opencode',
    present: hasCli(opencodeRunFacts.binary.command),
    make: () => createOpencodeAdapter({ pollMs: 20 }),
    channel: OPENCODE_CHANNELS[0],
    dialect: 'openai-chat',
  },
];

/** Файлы под `root`, чьё содержимое несёт метку пробы. */
function marked(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path);
      else if (st.size <= MAX_SCAN_BYTES && readFileSync(path).includes(MARK)) out.push(path);
    }
  };
  walk(root);
  return out;
}

let core: FakeCore;
const roots: LiveRoot[] = [];

beforeAll(async () => {
  if (CLIS.some((c) => c.present)) core = await startFakeCore();
}, 60_000);

afterAll(async () => {
  await core?.close();
  for (const r of roots) rmSync(r.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

for (const cli of CLIS) {
  describe.skipIf(!cli.present || !cli.channel)(
    `${cli.id} on the real CLI — the base probe leaves no conversation`,
    () => {
      it('the probe measures (the stub saw the mark) and no file under the throwaway home or the work folder carries it', async () => {
        const live = liveRoot(`probe-trace-${cli.id}-`);
        roots.push(live);
        const base = liveSpec(live);
        const keep: Record<string, string> = {};
        for (const name of ['TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
          const value = process.env[name];
          if (value !== undefined) keep[name] = value;
        }
        const spec = {
          ...base,
          tools: 'none' as const,
          coreHook: realCoreHook(base.dir),
          env: { pin: livePin(live, keep) },
          core: { ...base.core, coreUrl: core.url },
        };
        const trace = await probeOnStub(
          cli.make(),
          spec,
          { channel: cli.channel!, dialect: cli.dialect },
          180_000,
        );
        expect(
          trace.bodies.some((b) => b.includes(trace.brief)),
          `${trace.bodies.length} bodies`,
        ).toBe(true);
        const left = [
          ...marked(live.home),
          ...marked(live.cwd),
          ...(cli.store ? marked(cli.store(spec.dir)) : []),
        ].map((p) => relative(live.root, p));
        expect(left).toEqual([]);
      }, 400_000);
    },
  );
}
