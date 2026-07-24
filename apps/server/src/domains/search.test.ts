import { describe, it, expect } from 'vitest';
import type {
  EnvVar,
  Hook,
  McpServer,
  PermissionRule,
  Plugin,
  Rule,
  Skill,
} from '@claude-control/contracts';
import type { ScriptFile } from './scripts.ts';
import { searchEntities, type ProviderSearchInputs, type SearchInputs } from './search.ts';

/**
 * Тесты чистой фильтрации глобального поиска. Данные собираются руками — так
 * проверяется именно логика отбора и сниппетов, без чтения диска и запуска CLI.
 *
 * Ключевое, за чем следим: (1) поиск идёт по всем разделам сразу; (2) регистр не
 * важен; (3) по переменным окружения ищется и показывается ТОЛЬКО имя ключа —
 * значение секрета в результат не утекает; (4) пустой/короткий запрос пуст.
 */

const rule = (over: Partial<Rule>): Rule => ({
  id: 'r1',
  title: 'Правило',
  body: 'тело правила',
  order: 0,
  isEnabled: true,
  groupIds: [],
  scope: 'global',
  ...over,
});

const hook = (over: Partial<Hook>): Hook => ({
  id: 'Stop:abc',
  event: 'Stop',
  command: 'node hook.mjs',
  isEnabled: true,
  groupIds: [],
  source: 'settings',
  ...over,
});

const skill = (over: Partial<Skill>): Skill => ({
  id: 'my-skill',
  name: 'my-skill',
  description: 'описание скилла',
  body: 'тело',
  files: [],
  sizeBytes: 0,
  modifiedAt: '2026-01-01T00:00:00.000Z',
  groupIds: [],
  isEnabled: true,
  ...over,
});

const script = (over: Partial<ScriptFile>): ScriptFile => ({
  id: 'guard.mjs',
  name: 'guard.mjs',
  extension: '.mjs',
  path: '/hooks/guard.mjs',
  sizeBytes: 0,
  modifiedAt: '2026-01-01T00:00:00.000Z',
  isUsed: true,
  ...over,
});

const permission = (over: Partial<PermissionRule>): PermissionRule => ({
  id: 'allow:Bash(ls:*)',
  pattern: 'Bash(ls:*)',
  decision: 'allow',
  groupIds: [],
  source: 'settings',
  ...over,
});

const envVar = (over: Partial<EnvVar>): EnvVar => ({
  id: 'secrets:KEY',
  key: 'KEY',
  value: 'value',
  isSecret: false,
  source: 'secrets',
  ...over,
});

const mcp = (over: Partial<McpServer>): McpServer => ({
  id: 'gitlab',
  name: 'gitlab',
  transport: 'stdio',
  args: [],
  env: {},
  headers: {},
  health: 'unknown',
  isEnabled: true,
  groupIds: [],
  hasOAuth: false,
  ...over,
});

const plugin = (over: Partial<Plugin>): Plugin => ({
  id: 'code-review@official',
  name: 'code-review',
  marketplace: 'official',
  version: '1.0.0',
  scope: 'user',
  isEnabled: true,
  isInstalled: true,
  ...over,
});

const empty: SearchInputs = {
  rules: [],
  hooks: [],
  skills: [],
  scripts: [],
  permissions: [],
  envVars: [],
  mcpServers: [],
  plugins: [],
};

const inputs = (over: Partial<SearchInputs>): SearchInputs => ({ ...empty, ...over });

describe('searchEntities', () => {
  describe('пустой и короткий запрос', () => {
    it('пустой запрос возвращает пустой список', () => {
      expect(searchEntities(inputs({ rules: [rule({})] }), '')).toEqual([]);
    });

    it('запрос из одного символа возвращает пустой список', () => {
      expect(searchEntities(inputs({ rules: [rule({ title: 'a' })] }), 'a')).toEqual([]);
    });

    it('запрос из одних пробелов возвращает пустой список', () => {
      expect(searchEntities(inputs({ rules: [rule({})] }), '   ')).toEqual([]);
    });
  });

  describe('поиск по разным разделам', () => {
    it('находит правило по заголовку', () => {
      const found = searchEntities(inputs({ rules: [rule({ title: 'Язык общения' })] }), 'язык');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'rule', id: 'r1', pagePath: 'rules' });
    });

    it('находит правило по телу', () => {
      const found = searchEntities(
        inputs({ rules: [rule({ title: 'X', body: 'всегда пиши на русском' })] }),
        'русском',
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe('rule');
    });

    it('находит скилл по описанию', () => {
      const found = searchEntities(
        inputs({ skills: [skill({ id: 'a11y', name: 'a11y', description: 'аудит доступности' })] }),
        'доступности',
      );
      expect(found).toEqual([
        expect.objectContaining({ kind: 'skill', id: 'a11y', pagePath: 'skills' }),
      ]);
    });

    it('находит хук по matcher и по команде', () => {
      const byMatcher = searchEntities(
        inputs({ hooks: [hook({ matcher: 'Bash', command: 'node x.mjs' })] }),
        'bash',
      );
      expect(byMatcher[0]).toMatchObject({ kind: 'hook', pagePath: 'hooks' });
      // Заголовок хука содержит событие и matcher.
      expect(byMatcher[0]?.title).toContain('Bash');

      const byCommand = searchEntities(
        inputs({ hooks: [hook({ command: 'prettier --write' })] }),
        'prettier',
      );
      expect(byCommand).toHaveLength(1);
    });

    it('находит скрипт по имени файла', () => {
      const found = searchEntities(inputs({ scripts: [script({ name: 'format.mjs' })] }), 'format');
      expect(found[0]).toMatchObject({ kind: 'script', pagePath: 'scripts' });
    });

    it('находит право по паттерну', () => {
      const found = searchEntities(
        inputs({ permissions: [permission({ pattern: 'Bash(git push:*)' })] }),
        'git push',
      );
      expect(found[0]).toMatchObject({ kind: 'permission', pagePath: 'permissions' });
      expect(found[0]?.snippet).toBe('allow: Bash(git push:*)');
    });

    it('находит право по имени MCP-сервера в паттерне', () => {
      const found = searchEntities(
        inputs({
          permissions: [
            permission({
              id: 'allow:mcp__gitlab__get_project',
              pattern: 'mcp__gitlab__get_project',
              mcpServer: 'gitlab',
              mcpTool: 'get_project',
            }),
          ],
        }),
        'gitlab',
      );
      expect(found).toHaveLength(1);
    });

    it('находит MCP-сервер по имени и по команде', () => {
      const byName = searchEntities(
        inputs({ mcpServers: [mcp({ name: 'telegram' })] }),
        'telegram',
      );
      expect(byName[0]).toMatchObject({ kind: 'mcp', pagePath: 'mcp' });

      const byCommand = searchEntities(
        inputs({ mcpServers: [mcp({ command: 'npx some-server' })] }),
        'some-server',
      );
      expect(byCommand).toHaveLength(1);
    });

    it('находит плагин по имени', () => {
      const found = searchEntities(
        inputs({ plugins: [plugin({ name: 'code-review' })] }),
        'review',
      );
      expect(found[0]).toMatchObject({ kind: 'plugin', pagePath: 'plugins' });
    });

    it('агрегирует совпадения из нескольких разделов в один список', () => {
      const found = searchEntities(
        inputs({
          rules: [rule({ title: 'git flow' })],
          permissions: [permission({ pattern: 'Bash(git push:*)' })],
          mcpServers: [mcp({ name: 'gitlab', command: 'git-mcp' })],
        }),
        'git',
      );
      const kinds = found.map((item) => item.kind);
      expect(kinds).toContain('rule');
      expect(kinds).toContain('permission');
      expect(kinds).toContain('mcp');
    });

    it('ничего не находит, когда совпадений нет', () => {
      expect(searchEntities(inputs({ rules: [rule({ title: 'X' })] }), 'zzz')).toEqual([]);
    });
  });

  describe('регистронезависимость', () => {
    it('находит вне зависимости от регистра запроса и данных', () => {
      const found = searchEntities(inputs({ mcpServers: [mcp({ name: 'GitLab' })] }), 'GITLAB');
      expect(found).toHaveLength(1);
    });
  });

  describe('секреты переменных окружения не утекают', () => {
    it('ищет по имени ключа, но не по значению секрета', () => {
      const secret = envVar({
        id: 'secrets:GITLAB_TOKEN',
        key: 'GITLAB_TOKEN',
        value: 'glpat-super-secret-value',
        isSecret: true,
      });

      const byKey = searchEntities(inputs({ envVars: [secret] }), 'gitlab_token');
      expect(byKey).toHaveLength(1);
      // Сниппет — это имя ключа, значение секрета в него не попадает.
      expect(byKey[0]?.snippet).toBe('GITLAB_TOKEN');
      expect(byKey[0]?.snippet).not.toContain('glpat');

      // Поиск по значению секрета не находит ничего.
      const byValue = searchEntities(inputs({ envVars: [secret] }), 'glpat-super');
      expect(byValue).toEqual([]);
    });
  });

  describe('разделы активного провайдера (Ф11a)', () => {
    const providerInputs = (over: Partial<ProviderSearchInputs> = {}): ProviderSearchInputs => ({
      providerId: 'codex',
      providerName: 'Codex (OpenAI)',
      mcpServers: [],
      envKeys: [],
      ...over,
    });

    it('файл инструкций провайдера ищется по имени и по тексту', () => {
      const provider = providerInputs({
        instructions: { fileName: 'AGENTS.md', content: 'Всегда отвечай по-русски и кратко.' },
      });

      const byName = searchEntities(inputs({ provider }), 'agents.md');
      expect(byName).toHaveLength(1);
      expect(byName[0]).toMatchObject({ kind: 'instructions', pagePath: 'claude-md' });

      const byText = searchEntities(inputs({ provider }), 'по-русски');
      expect(byText).toHaveLength(1);
      expect(byText[0]?.snippet).toContain('по-русски');
    });

    it('MCP-серверы провайдера находятся и ведут на страницу MCP', () => {
      const provider = providerInputs({
        mcpServers: [
          {
            name: 'gitlab',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'gitlab-mcp'],
            env: {},
            headers: {},
          },
        ],
      });

      const found = searchEntities(inputs({ provider }), 'gitlab');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'mcp', pagePath: 'mcp', title: 'gitlab' });
    });

    it('права провайдера находятся по имени ключа и по значению', () => {
      const provider = providerInputs({
        permissions: [
          { key: 'approvalPolicy', value: 'on-request' },
          { key: 'sandboxMode', value: 'workspace-write' },
        ],
      });

      expect(searchEntities(inputs({ provider }), 'sandbox')).toHaveLength(1);
      expect(searchEntities(inputs({ provider }), 'on-request')).toHaveLength(1);
    });

    it('права gemini ищутся по режиму аппрувов и по именам инструментов', () => {
      const provider = providerInputs({
        permissions: [
          { key: 'defaultApprovalMode', value: 'auto_edit' },
          { key: 'excludeTools', value: 'run_shell_command, web_fetch' },
        ],
      });

      expect(searchEntities(inputs({ provider }), 'auto_edit')).toHaveLength(1);
      expect(searchEntities(inputs({ provider }), 'run_shell_command')).toHaveLength(1);
    });

    it('переменные окружения провайдера ищутся ТОЛЬКО по имени ключа', () => {
      // В inputs значений нет вовсе — они отбрасываются ещё у источника.
      const provider = providerInputs({ envKeys: ['OPENAI_API_TYPE', 'AIDER_VOICE_LANGUAGE'] });

      const found = searchEntities(inputs({ provider }), 'openai_api');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'env', title: 'OPENAI_API_TYPE' });
      expect(found[0]?.snippet).toBe('OPENAI_API_TYPE');
    });

    it('без блока провайдера (активен claude) провайдер-результатов нет', () => {
      const found = searchEntities(inputs({ rules: [rule({ title: 'agents' })] }), 'agents');
      expect(found.every((item) => item.kind !== 'instructions')).toBe(true);
    });
  });
});
