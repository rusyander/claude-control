import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { McpServerEntry, SessionSpec } from '../adapter.types.ts';
import { createAdapterRegistry } from '../index.ts';
import {
  bindCodexEndpoint,
  CODEX_CHANNELS,
  CODEX_FILES,
  CODEX_NONE_FEATURES,
  planCodex,
} from '../codex/codex.ts';
import {
  GOOSE_FILES,
  GOOSE_NONE_EXTENSIONS,
  GOOSE_OFF_EXTENSIONS,
  planGoose,
} from '../goose/goose.ts';
import { KIMI_FILES, KIMI_NONE_SENTINEL, planKimi } from '../kimi/kimi.ts';
import { OPENCODE_FILES, planOpencode } from '../opencode/opencode.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';

/**
 * `toolsNone` (s10 p10, вопрос «ask» без инструментов): переходник объявляет его только там, где
 * план снимает каждый встроенный инструмент ключом самого CLI; живое доказательство —
 * `tools-none.live.integration.test.ts`. Здесь — строки соответствия: кто объявил, и что именно
 * пишет план сеанса `none` против обычного (обычный сеанс этих ключей не несёт).
 */

const TOOLS_NONE = ['claude', 'codex', 'goose', 'kimi', 'opencode', 'qwen'];

const probe: McpServerEntry = { command: 'node', args: ['probe.mjs'] };

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  const cwd = join(tmpdir(), 'tools-none-work');
  return {
    sessionId: '44444444-4444-4444-8444-444444444444',
    dir: join(tmpdir(), 'tools-none-session'),
    cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(cwd, '..', 'tools-none-core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'off', skills: 'off' },
    env: { pin: {} },
    coreHook: 'node hook.mjs core',
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'ask',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    ...over,
  };
}

const none = (over: Partial<SessionSpec> = {}): SessionSpec => spec({ tools: 'none', ...over });

describe('adapter conformance — tools none (s10 p10)', () => {
  it('toolsNone is declared by exactly the adapters whose plan removes every built-in', () => {
    const declared = createAdapterRegistry()
      .all()
      .filter((a) => a.toolsNone)
      .map((a) => a.id)
      .sort();
    expect(declared).toEqual(TOOLS_NONE);
  });

  it('codex: web_search disabled, every listed feature off inside the one [features] table, request_user_input off', () => {
    const bound = bindCodexEndpoint(CODEX_CHANNELS[0]!, {
      baseUrl: 'http://127.0.0.1:9',
      dialect: 'openai-responses',
      model: 'stub-model',
      key: 'k',
    });
    if (!bound.ok) throw new Error(bound.code);
    const configOf = (s: SessionSpec): string | undefined =>
      planCodex(s, bound.binding, trustedLayer(s)).files[CODEX_FILES.config];
    const text = configOf(none({ economy: { compactWindow: 100000 } }))!;
    expect(text.match(/^\[features\]$/gm)).toHaveLength(1);
    const doc = parseToml(text) as {
      web_search?: string;
      model_auto_compact_token_limit?: number;
      model_provider?: string;
      features: Record<string, boolean>;
      tools?: { experimental_request_user_input?: { enabled?: boolean } };
    };
    expect(doc.web_search).toBe('disabled');
    for (const name of CODEX_NONE_FEATURES) expect(doc.features[name], name).toBe(false);
    expect(doc.features).toMatchObject({ plugins: false, apps: false });
    expect(doc.tools?.experimental_request_user_input?.enabled).toBe(false);
    // Остальное не потеряно: адрес привязки и рычаг экономии на месте.
    expect(doc.model_provider).toBeTruthy();
    expect(doc.model_auto_compact_token_limit).toBeGreaterThan(0);
    // Обычный сеанс: файла плана нет (берётся файл привязки) — и в нём ни одного ключа `none`.
    const plain = configOf(spec()) ?? bound.binding.files[CODEX_FILES.config]!;
    expect(plain).not.toMatch(/web_search|shell_tool|experimental_request_user_input/);
  });

  it('goose: every platform extension is off; a normal session turns off only skills and summon', () => {
    const offOf = (s: SessionSpec): string[] => {
      const text = planGoose(s, null, trustedLayer(s)).files[GOOSE_FILES.config]!;
      const doc = parseYaml(text) as { extensions: Record<string, { enabled: boolean }> };
      return Object.entries(doc.extensions)
        .filter(([, e]) => e.enabled === false)
        .map(([name]) => name)
        .sort();
    };
    expect(offOf(none())).toEqual([...GOOSE_NONE_EXTENSIONS].sort());
    expect(offOf(spec())).toEqual([...GOOSE_OFF_EXTENSIONS].sort());
    for (const name of GOOSE_OFF_EXTENSIONS) expect(GOOSE_NONE_EXTENSIONS).toContain(name);
  });

  it('opencode: permission "*" deny, the step MCP servers allowed after it; a normal session keeps its ask rules', () => {
    const permissionOf = (s: SessionSpec): Record<string, string> =>
      (
        JSON.parse(planOpencode(s, null, trustedLayer(s)).files[OPENCODE_FILES.config]!) as {
          permission: Record<string, string>;
        }
      ).permission;
    const got = permissionOf(none({ mcpServers: { 'probe-carried': probe } }));
    expect(Object.entries(got)).toEqual([
      ['*', 'deny'],
      ['probe-carried_*', 'allow'],
    ]);
    expect(permissionOf(none())).toEqual({ '*': 'deny' });
    expect(permissionOf(spec())).not.toHaveProperty('*');
  });

  it('kimi: [tools] enabled lists only the step MCP servers (a sentinel when none); a normal session has no [tools]', () => {
    const toolsOf = (s: SessionSpec): { enabled?: string[] } | undefined =>
      (
        parseToml(planKimi(s, null, trustedLayer(s)).files[KIMI_FILES.config]!) as {
          tools?: { enabled?: string[] };
        }
      ).tools;
    expect(toolsOf(none({ mcpServers: { 'probe-carried': probe } }))).toEqual({
      enabled: ['mcp__probe-carried__*'],
    });
    expect(toolsOf(none())).toEqual({ enabled: [KIMI_NONE_SENTINEL] });
    expect(toolsOf(spec())).toBeUndefined();
  });
});
