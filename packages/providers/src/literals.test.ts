import { describe, expect, it } from 'vitest';
import { CLI_LITERALS, deriveLiterals } from './literals.ts';
import type { CliRunFacts } from './types.ts';

describe('литералы для линта P108', () => {
  it('id, вендоры, бинари и семейства моделей — из реестра, отсортированы', () => {
    expect(CLI_LITERALS.adapterIds).toEqual([
      'aider',
      'claude',
      'codex',
      'continue',
      'cursor',
      'gemini',
      'goose',
      'kimi',
      'opencode',
      'qwen',
    ]);
    expect(CLI_LITERALS.vendorNames).toEqual([
      'alibaba',
      'anthropic',
      'google',
      'moonshotai',
      'openai',
      'opencode',
    ]);
    expect(CLI_LITERALS.binaryNames).toContain('cursor-agent.cmd');
    expect(CLI_LITERALS.binaryNames).toContain('cn');
    expect(CLI_LITERALS.binaryNames).toHaveLength(20);
    expect(CLI_LITERALS.modelFamilyPrefixes).toEqual([
      'gemini-flash',
      'gemini-flash-lite',
      'gpt-codex',
      'gpt-codex-spark',
    ]);
  });

  it('переменные окружения собраны со всех каналов, ключей и пределов', () => {
    const vars = CLI_LITERALS.envVarNames;
    // Ключи вендора, тройки переменных, канал окружения прогона (по результату build),
    // пределы через окружение и переменная файла настроек.
    for (const name of [
      'DASHSCOPE_API_KEY',
      'AIDER_OPENAI_API_BASE',
      'AIDER_MODEL',
      'ANTHROPIC_AUTH_TOKEN',
      'GOOGLE_GEMINI_BASE_URL',
      'GOOSE_SUBAGENT_PROVIDER',
      'OPENAI_BASE_PATH',
      'KIMI_MODEL_NAME',
      'OPENCODE_CONFIG_CONTENT',
      'MAX_MCP_OUTPUT_TOKENS',
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
    ]) {
      expect(vars).toContain(name);
    }
    expect(new Set(vars).size).toBe(vars.length);
    expect([...vars].sort()).toEqual(vars);
  });

  it('новый CLI расширяет список сам, без правки линта', () => {
    const extra: CliRunFacts = {
      id: 'newcli',
      name: 'New',
      status: 'experimental',
      binary: { command: 'newcli', windowsCommand: 'newcli.cmd' },
      login: 'unknown',
      vendorApi: { kind: 'none', keyVars: [] },
      cliRunnable: true,
      channels: [
        { via: 'env', form: 'vars', dialect: 'openai-chat', baseUrlVar: 'NEWCLI_BASE' },
        { via: 'env', form: 'run', dialect: 'openai-chat', build: () => ({ NEWCLI_RUN: 'x' }) },
        {
          via: 'file',
          dialect: 'openai-chat',
          format: 'continue-yaml',
          place: 'x',
          perSession: false,
        },
      ],
      modelVendors: ['newvendor'],
      modelLadder: ['new-small'],
    };
    const literals = deriveLiterals([extra]);
    expect(literals).toEqual({
      adapterIds: ['newcli'],
      vendorNames: ['newvendor'],
      binaryNames: ['newcli', 'newcli.cmd'],
      envVarNames: ['NEWCLI_BASE', 'NEWCLI_RUN'],
      modelFamilyPrefixes: ['new-small'],
    });
  });
});
