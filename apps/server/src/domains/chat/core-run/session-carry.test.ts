import { describe, expect, it } from 'vitest';
import {
  LOCAL_LAYER_INSTRUCTIONS_MAX,
  SESSION_APPEND_MAX,
  SESSION_SYSTEM_PROMPT_MAX,
} from '@agentdeck/contracts/core/session-carry';
import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import { LOCAL_GATEWAY_RUN_ENV, localRunEnv } from '../../local-models/run-env.ts';
import type { RunOptions } from '../run-options/run-options.ts';
import {
  appendOf,
  buildCarry,
  carriedEnvOf,
  carryOfRunOptions,
  carryOfTestsRoute,
  parsePanelArgs,
} from './session-carry.ts';

/**
 * Перенос слоя панели в поля сеанса ядра (G6): известные флаги наших слоёв — типизированными
 * полями, каждый прочий — отказом по имени (сырых флагов ядро не берёт); переменные — только из
 * списка, значения отдельно от полей. Итог судит та же схема оценки, что у живого ядра.
 */

const FIELDS = {
  title: 't',
  request: 'r',
  repos: [{ path: 'C:/p', baseRef: null }],
  scenario: { preset: 'chat' },
  launchPolicy: 'confirm',
  ciWait: false,
};

describe('parsePanelArgs', () => {
  it('known flags become fields; repeated sources and tools intersect; the inert flag is dropped', () => {
    const got = parsePanelArgs([
      '--plugin-dir',
      'C:/k/a',
      '--plugin-dir',
      'C:/k/a',
      '--plugin-dir',
      'C:/k/b',
      '--setting-sources',
      'user,project,local',
      '--setting-sources',
      'project, local',
      '--tools',
      'Read,Grep,Bash',
      '--tools',
      'Grep,Read',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--exclude-dynamic-system-prompt-sections',
    ]);
    expect(got).toEqual({
      ok: true,
      parsed: {
        plugins: ['C:/k/a', 'C:/k/b'],
        settingSources: ['project', 'local'],
        builtinTools: ['Read', 'Grep'],
        skills: 'off',
        mcp: 'core',
      },
    });
  });

  it.each([
    '--settings',
    '--permission-mode',
    '--mcp-config',
    '--dangerously-skip-permissions',
    '--allowedTools',
    '--add-dir',
    '--append-system-prompt',
  ])('%s is refused by name — no raw CLI flag reaches the core', (flag) => {
    expect(parsePanelArgs([flag, 'x'])).toEqual({
      ok: false,
      reason: `panel flag ${flag} has no core session field — the core takes no raw CLI flags`,
    });
  });

  it('a value flag without its value, an unknown source, empty intersections — refused', () => {
    expect(parsePanelArgs(['--plugin-dir'])).toEqual({
      ok: false,
      reason: 'panel flag --plugin-dir has no value',
    });
    expect(parsePanelArgs(['--setting-sources', 'user,policy'])).toEqual({
      ok: false,
      reason: 'panel flag --setting-sources: unknown policy',
    });
    expect(
      parsePanelArgs(['--setting-sources', 'user', '--setting-sources', 'project']),
    ).toMatchObject({ ok: false, reason: /narrow to none/ });
    expect(parsePanelArgs(['--tools', 'Read', '--tools', 'Bash'])).toMatchObject({
      ok: false,
      reason: /intersect to none/,
    });
  });
});

describe('appendOf / carriedEnvOf', () => {
  it('append = tests line + profile line + kit block; the system-prompt layer drops only ours', () => {
    const parts = { workspaceNote: ' T ', profileNote: 'P', platformAppend: 'K' };
    expect(appendOf(parts)).toBe('T\n\nP\n\nK');
    expect(appendOf({ ...parts, platformDropAppend: true })).toBe('K');
    expect(appendOf({})).toBe('');
  });

  it('only listed variables travel; the tests mark always; empty values skipped', () => {
    expect(
      carriedEnvOf({
        AGENTDECK_KIT_VARIANT: 'ours',
        AGENTDECK_TESTS_PROJECT: 'C:/p',
        QWEN_HOME: 'C:/kit/qwen',
        CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '1',
        BASH_MAX_OUTPUT_LENGTH: '',
        ANTHROPIC_BASE_URL: 'http://contour',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        CLAUDE_CONFIG_DIR: 'C:/real',
      }),
    ).toEqual({
      AGENTDECK_TESTS_NOTE: '1',
      AGENTDECK_KIT_VARIANT: 'ours',
      AGENTDECK_TESTS_PROJECT: 'C:/p',
      QWEN_HOME: 'C:/kit/qwen',
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '1',
    });
  });

  // s10 G13 p7 (run ff6ff1f1, 9 reds): окно, резерв ответа и сроки локальной модели не доезжали до
  // сеанса ядра — Claude Code считал окно облачным. Прежняя панель клала их окружением процесса.
  it('the local-model route env (window, timeouts, limits) and gateway tool search travel whole', () => {
    const local = { ...localRunEnv(65_536, 120), ...LOCAL_GATEWAY_RUN_ENV };
    const got = carriedEnvOf({ ...local, ANTHROPIC_BASE_URL: 'http://contour' });
    expect(got).toEqual({ AGENTDECK_TESTS_NOTE: '1', ...local });
    expect(Object.keys(got)).toHaveLength(Object.keys(local).length + 1);
  });
});

describe('carryOfRunOptions / carryOfTestsRoute — the contour system prompt (s10 G13 p7)', () => {
  const CONTOUR = 'Agent prompt.\n\n{"tool":"x"}\n\nPreamble.';

  it('the chat run carries platformSystemPrompt trimmed as session.systemPrompt; the schema takes it', () => {
    const options = {
      prompt: 'p',
      cwd: 'C:/p',
      platformSystemPrompt: `  ${CONTOUR}\n`,
      platformEnv: localRunEnv(65_536),
    } as RunOptions;
    const got = carryOfRunOptions(options);
    if (!got.ok) throw new Error(got.reason);
    expect(got.carry.session.systemPrompt).toBe(CONTOUR);
    expect(got.carry.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('65536');
    expect(estimateFieldsSchema.safeParse({ ...FIELDS, session: got.carry.session }).success).toBe(
      true,
    );
    // Пустой промпт контура (контур без своего промпта) — поля нет.
    const plain = carryOfRunOptions({ ...options, platformSystemPrompt: '  ' });
    expect(plain.ok && 'systemPrompt' in plain.carry.session).toBe(false);
  });

  it('the tests route carries its systemPrompt the same way', () => {
    const got = carryOfTestsRoute({ env: {}, systemPrompt: CONTOUR });
    if (!got.ok) throw new Error(got.reason);
    expect(got.carry.session.systemPrompt).toBe(CONTOUR);
  });

  it('a contour prompt over the core limit is refused, not cut; the schema refuses it too', () => {
    const long = 'x'.repeat(SESSION_SYSTEM_PROMPT_MAX + 1);
    expect(buildCarry({ append: '', args: [], env: {}, systemPrompt: long })).toMatchObject({
      ok: false,
      reason: /contour system prompt is 32001 chars, the core takes up to 32000/,
    });
    expect(
      estimateFieldsSchema.safeParse({ ...FIELDS, session: { systemPrompt: long } }).success,
    ).toBe(false);
  });
});

describe('buildCarry', () => {
  it('the result passes the core estimate schema; env names in fields, values beside', () => {
    const got = buildCarry({
      append: 'A',
      args: ['--plugin-dir', 'C:/k/a', '--disable-slash-commands'],
      env: { AGENTDECK_TESTS_NOTE: '1' },
    });
    if (!got.ok) throw new Error(got.reason);
    expect(got.carry.session).toEqual({
      append: 'A',
      plugins: ['C:/k/a'],
      skills: 'off',
      env: ['AGENTDECK_TESTS_NOTE'],
    });
    expect(estimateFieldsSchema.safeParse({ ...FIELDS, session: got.carry.session }).success).toBe(
      true,
    );
  });

  it('nothing to carry — no empty fields', () => {
    const got = buildCarry({ append: '', args: [], env: {} });
    expect(got).toEqual({ ok: true, carry: { session: {}, env: {} } });
  });

  it('an append over the core limit is refused, not cut', () => {
    const got = buildCarry({ append: 'x'.repeat(SESSION_APPEND_MAX + 1), args: [], env: {} });
    expect(got).toMatchObject({ ok: false, reason: /the core takes up to 32000/ });
  });

  it('the local layer rides session.localLayer; one that does not fit the schema is refused by name; an empty one makes no field', () => {
    const localLayer = { plugin: 'C:/p/.agent/local-layer/build/plugin', instructions: 'TEAM' };
    const got = buildCarry({
      append: '',
      args: ['--setting-sources', 'user,local'],
      env: {},
      localLayer,
    });
    if (!got.ok) throw new Error(got.reason);
    expect(got.carry.session).toEqual({ localLayer, settingSources: ['user', 'local'] });
    expect(estimateFieldsSchema.safeParse({ ...FIELDS, session: got.carry.session }).success).toBe(
      true,
    );
    const long = buildCarry({
      append: '',
      args: [],
      env: {},
      localLayer: { instructions: 'x'.repeat(LOCAL_LAYER_INSTRUCTIONS_MAX + 1) },
    });
    expect(long).toMatchObject({
      ok: false,
      reason: /^the project local layer does not fit the core session: instructions /,
    });
    expect(buildCarry({ append: '', args: [], env: {}, localLayer: {} })).toEqual({
      ok: true,
      carry: { session: {}, env: {} },
    });
  });
});
