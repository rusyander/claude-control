import { describe, expect, it } from 'vitest';
import { KIMI_ACP_MODES, KIMI_MODES } from '@agentdeck/contracts/permissions';
import type { SessionSpec } from '../adapter.types.ts';
import {
  bindKimiEndpoint,
  checkKimiSession,
  fillKimiInput,
  KIMI_ACP_MODE,
  KIMI_CHANNELS,
  KIMI_ENV_MODEL,
  KIMI_FILES,
  KIMI_PERMISSION_MODE,
  kimiConfigFile,
  mapKimiPermission,
  planKimi,
  refuseKimi,
} from './index.ts';

/**
 * Kimi Code 2.4.1 без живого CLI: файл сеанса, словарь вызовов и проверка рукопожатия. Живой
 * отказ push хуком — `kimi.p81.live.integration.test.ts` в контейнере.
 */

const endpoint = {
  baseUrl: 'http://127.0.0.1:9',
  dialect: 'openai-chat' as const,
  model: 'stub-model',
  key: 'stub-key',
};

describe('kimi session config', () => {
  it('the core hook runs on every call, a failing hook refuses (exit 2), config mode manual', () => {
    const toml = kimiConfigFile('node "/s/run.ts" hook');
    // Значение config.toml — из набора панели; `default` Kimi 2.4.1 не принимает (живая сверка —
    // kimi.config.live.integration.test.ts через kimi doctor config).
    expect(toml).toContain('default_permission_mode = "manual"');
    expect(KIMI_MODES).toContain(KIMI_PERMISSION_MODE);
    expect(toml).toContain('[[hooks]]\nevent = "PreToolUse"\nmatcher = ""');
    expect(toml).toContain(`command = ${JSON.stringify('node "/s/run.ts" hook || exit 2')}`);
    expect(toml).toMatch(/timeout = 600\b/);
  });

  it('plan: own KIMI_CODE_HOME inside the session dir, the config file there', () => {
    const spec = { dir: '/s/1', coreHook: 'h', mcpServers: {} } as unknown as SessionSpec;
    const plan = planKimi(spec, null, {} as never);
    expect(plan.args).toEqual(['acp']);
    expect(plan.env.KIMI_CODE_HOME?.replace(/\\/g, '/')).toBe('/s/1/kimi-home');
    expect(Object.keys(plan.files)).toEqual([KIMI_FILES.config]);
    expect(plan.files[KIMI_FILES.config]).toContain('"h || exit 2"');
  });

  it('binds the openai-chat endpoint through KIMI_MODEL_* with /v1, refuses another dialect', () => {
    const bound = bindKimiEndpoint(KIMI_CHANNELS[0]!, endpoint);
    expect(bound).toMatchObject({
      ok: true,
      binding: {
        env: {
          KIMI_MODEL_PROVIDER_TYPE: 'openai',
          KIMI_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
          KIMI_MODEL_API_KEY: 'stub-key',
        },
      },
    });
    expect(bindKimiEndpoint(KIMI_CHANNELS[0]!, { ...endpoint, dialect: 'google-genai' })).toEqual({
      ok: false,
      code: 'no_channel',
    });
  });

  it('refuses without the core hook and without an endpoint; a resume is judged by its transcript', () => {
    const ep = { channel: KIMI_CHANNELS[0]!, endpoint };
    expect(refuseKimi({ endpoint: ep } as SessionSpec)).toMatch(/^no core hook/);
    expect(refuseKimi({ coreHook: 'h' } as SessionSpec)).toMatch(/routed endpoint/);
    expect(
      refuseKimi({ coreHook: 'h', endpoint: ep, resume: { conversationId: 'x' } } as never),
    ).toBeNull();
    expect(refuseKimi({ coreHook: 'h', endpoint: ep } as SessionSpec)).toBeNull();
  });

  it('handshake: ACP mode default (not a config value) and the env model, anything else fails the launch', () => {
    expect(KIMI_ACP_MODE).toBe('default');
    expect(KIMI_ACP_MODES).toContain(KIMI_ACP_MODE);
    expect(KIMI_MODES as readonly string[]).not.toContain(KIMI_ACP_MODE);
    const ok = {
      modes: { currentModeId: 'default' },
      configOptions: [{ id: 'model', currentValue: KIMI_ENV_MODEL }],
    };
    expect(checkKimiSession(ok)).toBeNull();
    expect(checkKimiSession({ ...ok, modes: { currentModeId: 'yolo' } })).toMatch(/mode yolo/);
    expect(
      checkKimiSession({ ...ok, configOptions: [{ id: 'model', currentValue: 'kimi-k2' }] }),
    ).toMatch(/model kimi-k2/);
  });
});

describe('kimi call vocabulary over ACP', () => {
  it('input comes from the JSON text of an open call, never from a finished call output', () => {
    const text = (t: string, status = 'in_progress') => ({
      status,
      content: [{ type: 'content', content: { type: 'text', text: t } }],
    });
    expect(fillKimiInput(text('{"command":"git push origin main"}'))).toEqual({
      command: 'git push origin main',
    });
    expect(fillKimiInput(text('Requesting approval to Running: git status'))).toBeNull();
    expect(fillKimiInput(text('{"a":1}', 'completed'))).toBeNull();
    expect(fillKimiInput(text('{broken'))).toBeNull();
  });

  it('asks map to the core vocabulary', () => {
    expect(mapKimiPermission({ tool: 'Bash', input: { command: 'git status' } })).toMatchObject({
      action: 'exec',
      argv: ['git', 'status'],
      argvExact: true,
    });
    expect(mapKimiPermission({ tool: 'Write', input: { path: '/w/a' } })).toMatchObject({
      action: 'edit',
      target: '/w/a',
    });
    expect(mapKimiPermission({ tool: 'Read', input: {} })).toMatchObject({ action: 'other' });
    expect(mapKimiPermission({ tool: 'Grep', input: { pattern: 'x' } })).toMatchObject({
      action: 'read',
      target: '.',
    });
    expect(mapKimiPermission({ tool: 'Agent', input: { subagent_type: 'coder' } })).toMatchObject({
      action: 'subagent',
      target: 'coder',
    });
    expect(mapKimiPermission({ tool: 'FetchURL', input: { url: 'https://x' } })).toMatchObject({
      action: 'net',
    });
  });
});
