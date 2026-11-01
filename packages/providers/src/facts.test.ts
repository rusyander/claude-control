import { describe, expect, it } from 'vitest';
import {
  bypassLabel,
  contourModelName,
  endpointApiKindOf,
  envRunChannel,
  envVarsChannels,
  fileChannel,
  wireApiOf,
} from './channels.ts';
import { acceptedEffort, effortArgs } from './effort.ts';
import { CLI_RUN_FACTS, cliRunFacts } from './registry.ts';
import type { CliRunFacts } from './types.ts';

/**
 * Оракул — значения каталога панели ДО переезда фактов в пакет (снимок 28.10.2026 по
 * `listProviders()`), записанные здесь буквально, а не взятые из модулей пакета.
 */
interface Expected {
  name: string;
  status: 'verified' | 'experimental';
  binary: [string, string];
  login: CliRunFacts['login'];
  vendorApi: CliRunFacts['vendorApi'];
  cliRunnable: boolean;
  /** Каналы тройкой переменных: [вид API, адрес, модель, приставка, ключ, обход]. */
  vars: [string, string, string?, string?, string?, string?][];
  file?: [string, string, 'chat' | 'responses'];
  run?: boolean;
  vendors?: string[];
  ladder?: string[];
}

const EXPECTED: Record<string, Expected> = {
  claude: {
    name: 'Claude Code',
    status: 'verified',
    binary: ['claude', 'claude.cmd'],
    login: 'account',
    vendorApi: {
      kind: 'anthropic',
      keyVars: ['ANTHROPIC_API_KEY'],
      baseUrl: 'https://api.anthropic.com',
    },
    cliRunnable: true,
    vars: [
      ['anthropic', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', undefined, 'ANTHROPIC_AUTH_TOKEN'],
    ],
    vendors: ['anthropic'],
  },
  codex: {
    name: 'Codex (OpenAI)',
    status: 'experimental',
    binary: ['codex', 'codex.cmd'],
    login: 'account',
    vendorApi: {
      kind: 'openai',
      keyVars: ['OPENAI_API_KEY'],
      baseUrl: 'https://api.openai.com/v1',
    },
    cliRunnable: true,
    vars: [],
    file: ['codex-toml', 'openai-compat', 'responses'],
    vendors: ['openai'],
    ladder: ['gpt-codex-spark', 'gpt-codex'],
  },
  gemini: {
    name: 'Gemini CLI',
    status: 'experimental',
    binary: ['gemini', 'gemini.cmd'],
    login: 'account',
    vendorApi: {
      kind: 'google',
      keyVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      baseUrl: 'https://generativelanguage.googleapis.com',
    },
    cliRunnable: true,
    vars: [
      [
        'google',
        'GOOGLE_GEMINI_BASE_URL',
        'GEMINI_MODEL',
        undefined,
        'GEMINI_API_KEY',
        'security.auth.selectedType ≠ "gemini-api-key"',
      ],
    ],
    vendors: ['google'],
    ladder: ['gemini-flash-lite', 'gemini-flash'],
  },
  qwen: {
    name: 'Qwen Code',
    status: 'experimental',
    binary: ['qwen', 'qwen.cmd'],
    login: 'account',
    vendorApi: { kind: 'openai-compat', keyVars: ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY'] },
    cliRunnable: true,
    vars: [
      ['openai-compat', 'OPENAI_BASE_URL', 'OPENAI_MODEL', undefined, 'OPENAI_API_KEY'],
      ['anthropic', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', undefined, 'ANTHROPIC_API_KEY'],
    ],
    vendors: ['alibaba'],
  },
  continue: {
    name: 'Continue',
    status: 'experimental',
    binary: ['cn', 'cn.cmd'],
    login: 'account',
    vendorApi: { kind: 'none', keyVars: [] },
    cliRunnable: true,
    vars: [],
    file: ['continue-yaml', 'openai-compat', 'chat'],
  },
  goose: {
    name: 'Goose',
    status: 'experimental',
    binary: ['goose', 'goose.cmd'],
    login: 'cli-config',
    vendorApi: { kind: 'none', keyVars: [] },
    cliRunnable: true,
    vars: [],
    run: true,
  },
  kimi: {
    name: 'Kimi Code',
    status: 'experimental',
    binary: ['kimi', 'kimi.cmd'],
    login: 'account',
    vendorApi: {
      kind: 'openai-compat',
      keyVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
      baseUrl: 'https://api.moonshot.ai/v1',
    },
    cliRunnable: true,
    vars: [],
    run: true,
    vendors: ['moonshotai'],
  },
  cursor: {
    name: 'Cursor',
    status: 'experimental',
    binary: ['cursor-agent', 'cursor-agent.cmd'],
    login: 'unknown',
    vendorApi: { kind: 'none', keyVars: [] },
    cliRunnable: false,
    vars: [],
  },
  opencode: {
    name: 'OpenCode',
    status: 'experimental',
    binary: ['opencode', 'opencode.cmd'],
    login: 'cli-config',
    vendorApi: { kind: 'openai-compat', keyVars: [] },
    cliRunnable: true,
    vars: [],
    run: true,
    vendors: ['opencode'],
  },
  aider: {
    name: 'Aider',
    status: 'experimental',
    binary: ['aider', 'aider.cmd'],
    login: 'cli-config',
    vendorApi: {
      kind: 'openai',
      keyVars: ['OPENAI_API_KEY'],
      baseUrl: 'https://api.openai.com/v1',
    },
    cliRunnable: true,
    vars: [
      ['openai-compat', 'AIDER_OPENAI_API_BASE', 'AIDER_MODEL', 'openai/', 'AIDER_OPENAI_API_KEY'],
    ],
  },
};

const facts = (id: string): CliRunFacts => {
  const found = cliRunFacts(id);
  if (!found) throw new Error(`no facts for ${id}`);
  return found;
};

describe('реестр фактов запуска', () => {
  it('держит ровно десять CLI в порядке каталога панели', () => {
    expect(CLI_RUN_FACTS.map((entry) => entry.id)).toEqual(Object.keys(EXPECTED));
  });

  it('чужой id — undefined, а не угаданный CLI', () => {
    expect(cliRunFacts('claude-code')).toBeUndefined();
    expect(cliRunFacts('')).toBeUndefined();
  });
});

describe.each(Object.entries(EXPECTED))('факты %s', (id, want) => {
  const got = facts(id);

  it('имя, статус, бинарь, вход, API вендора', () => {
    expect(got.name).toBe(want.name);
    expect(got.status).toBe(want.status);
    expect([got.binary.command, got.binary.windowsCommand]).toEqual(want.binary);
    expect(got.login).toBe(want.login);
    expect(got.vendorApi).toEqual(want.vendorApi);
    expect(got.cliRunnable).toBe(want.cliRunnable);
  });

  it('каналы адреса совпадают с каталогом до переезда', () => {
    const vars = envVarsChannels(got).map((channel) => [
      endpointApiKindOf(channel.dialect),
      channel.baseUrlVar,
      channel.modelVar,
      channel.modelPrefix,
      channel.keyVar,
      channel.bypass ? bypassLabel(channel.bypass) : undefined,
    ]);
    const trim = (row: unknown[]) => {
      const out = [...row];
      while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
      return out;
    };
    expect(vars.map(trim)).toEqual(want.vars.map(trim));
    const file = fileChannel(got);
    expect(
      file ? [file.format, endpointApiKindOf(file.dialect), wireApiOf(file.dialect)] : undefined,
    ).toEqual(want.file);
    expect(file?.perSession ?? false).toBe(false);
    expect(envRunChannel(got) !== undefined).toBe(want.run ?? false);
  });

  it('вендоры и лестница моделей', () => {
    expect(got.modelVendors).toEqual(want.vendors);
    expect(got.modelLadder).toEqual(want.ladder);
  });
});

describe('окружение одного прогона', () => {
  const input = { baseUrl: 'http://127.0.0.1:5179/run/abc/v1', model: ' ', key: 'placeholder' };
  const input2 = { baseUrl: 'http://127.0.0.1:5179/v1/', model: 'qwen3', key: 'k2' };
  const build = (id: string) => {
    const channel = envRunChannel(facts(id));
    if (!channel) throw new Error(`no run channel for ${id}`);
    return channel.build;
  };

  it('Goose: провайдер openai, хост и путь отдельно, субагенты тем же провайдером', () => {
    expect(build('goose')(input)).toEqual({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'default',
      GOOSE_SUBAGENT_PROVIDER: 'openai',
      GOOSE_SUBAGENT_MODEL: 'default',
      OPENAI_HOST: 'http://127.0.0.1:5179',
      OPENAI_BASE_PATH: 'run/abc/v1/chat/completions',
      OPENAI_API_KEY: 'placeholder',
    });
    expect(build('goose')(input2)).toMatchObject({
      GOOSE_MODEL: 'qwen3',
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'k2',
    });
  });

  it('Kimi: модель целиком из KIMI_MODEL_*', () => {
    expect(build('kimi')(input)).toEqual({
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: 'http://127.0.0.1:5179/run/abc/v1',
      KIMI_MODEL_API_KEY: 'placeholder',
      KIMI_MODEL_NAME: 'default',
    });
    expect(build('kimi')(input2).KIMI_MODEL_NAME).toBe('qwen3');
  });

  it('OpenCode: конфиг строкой, единственный провайдер contour, агенты на нём', () => {
    expect(build('opencode')(input2)).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          contour: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:5179/v1/', apiKey: 'k2' },
            models: { qwen3: {} },
          },
        },
        model: 'contour/qwen3',
        small_model: 'contour/qwen3',
        agent: {
          build: { model: 'contour/qwen3' },
          plan: { model: 'contour/qwen3' },
          general: { model: 'contour/qwen3' },
          explore: { model: 'contour/qwen3' },
        },
        enabled_providers: ['contour'],
      }),
    });
  });

  it('обход у Goose и Kimi назван настройкой, у OpenCode его нет', () => {
    const bypassOf = (id: string) => envRunChannel(facts(id))?.bypass;
    expect(bypassOf('goose')).toEqual({ setting: 'GOOSE_LEAD_PROVIDER' });
    expect(bypassOf('kimi')).toEqual({ setting: '[secondary_model] model' });
    expect(bypassOf('opencode')).toBeUndefined();
  });

  it('модель без имени — default, имя с пробелами — обрезано', () => {
    expect(contourModelName('')).toBe('default');
    expect(contourModelName('   ')).toBe('default');
    expect(contourModelName(' m1 ')).toBe('m1');
  });
});

describe('диалекты', () => {
  it('вид API эндпоинта и ручка выводятся из диалекта', () => {
    expect(endpointApiKindOf('anthropic-messages')).toBe('anthropic');
    expect(endpointApiKindOf('google-genai')).toBe('google');
    expect(endpointApiKindOf('openai-chat')).toBe('openai-compat');
    expect(endpointApiKindOf('openai-responses')).toBe('openai-compat');
    expect(wireApiOf('openai-responses')).toBe('responses');
    expect(wireApiOf('openai-chat')).toBe('chat');
  });

  it('подпись обхода без требуемого значения — одно имя настройки', () => {
    expect(bypassLabel({ setting: 'X' })).toBe('X');
    expect(bypassLabel({ setting: 'X', requires: 'y' })).toBe('X ≠ "y"');
  });
});

describe('глубина', () => {
  const efforts = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'bogus'];

  it('Claude: --effort для low..max, остальное не передаётся', () => {
    expect(efforts.map((e) => acceptedEffort(facts('claude'), e || undefined))).toEqual([
      undefined,
      undefined,
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      undefined,
    ]);
    expect(effortArgs(facts('claude'), 'high')).toEqual(['--effort', 'high']);
  });

  it('Codex: -c model_reasoning_effort только для low/medium/high', () => {
    expect(efforts.map((e) => effortArgs(facts('codex'), e || undefined))).toEqual([
      [],
      [],
      ['-c', 'model_reasoning_effort=low'],
      ['-c', 'model_reasoning_effort=medium'],
      ['-c', 'model_reasoning_effort=high'],
      [],
      [],
      [],
    ]);
  });

  it('CLI без глубины не получает флага ни при каком значении', () => {
    for (const id of [
      'gemini',
      'qwen',
      'continue',
      'goose',
      'kimi',
      'cursor',
      'opencode',
      'aider',
    ]) {
      expect(facts(id).effort).toBeUndefined();
      expect(effortArgs(facts(id), 'high')).toEqual([]);
    }
  });
});

describe('пределы локальной модели и событие окна', () => {
  it('Claude: одиннадцать переменных окружения в порядке записи, событие rate_limit_event', () => {
    expect(facts('claude').limitsChannel).toEqual({
      via: 'env',
      vars: [
        'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
        'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
        'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
        'CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS',
        'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
        'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS',
        'API_TIMEOUT_MS',
        'CLAUDE_CODE_RETRY_WATCHDOG',
        'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
        'MAX_MCP_OUTPUT_TOKENS',
      ],
    });
    expect(facts('claude').windowEvent).toEqual({ type: 'rate_limit_event' });
  });

  it('Qwen: файл настроек переменной QWEN_CODE_SYSTEM_SETTINGS_PATH, ключи model.generationConfig', () => {
    expect(facts('qwen').limitsChannel).toEqual({
      via: 'settings-file',
      fileVar: 'QWEN_CODE_SYSTEM_SETTINGS_PATH',
      path: ['model', 'generationConfig'],
      keys: { window: 'contextWindowSize', timeout: 'timeout', idle: 'streamIdleTimeoutMs' },
    });
  });

  it('у остальных ни канала пределов, ни события окна — не задокументированы', () => {
    for (const entry of CLI_RUN_FACTS.filter((f) => f.id !== 'claude' && f.id !== 'qwen')) {
      expect(entry.limitsChannel).toBeUndefined();
    }
    for (const entry of CLI_RUN_FACTS.filter((f) => f.id !== 'claude')) {
      expect(entry.windowEvent).toBeUndefined();
    }
  });
});
