import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EnvItem } from '@agentdeck/contracts/portable-env';
import { isServerMessageCode, resolveServerParams } from '@agentdeck/contracts/server-messages';
import { serverMessagesEn } from '../../../../web/src/shared/config/i18n/server-messages/en.ts';
import { serverMessagesRu } from '../../../../web/src/shared/config/i18n/server-messages/ru.ts';
import {
  commandItem,
  envVarOrSecret,
  instructionsItem,
  pluginItem,
  skillItem,
  subagentItem,
} from './normalize-files.ts';
import { normalizeHooks, preservedHookItem } from './normalize-hooks.ts';
import { normalizeMcpServers } from './normalize-mcp.ts';
import { normalizeClaudePermissions, normalizePermissions } from './normalize-permissions.ts';
import { probeEnvironment, writeProbeScripts } from './probe-canon.ts';
import { sourceFactory } from './normalize-types.ts';
import { claudeProvider } from '../../providers/claude.ts';

/**
 * Паспорт переноса под английским интерфейсом. Фраза записи (`intent`) — русская
 * строка сервера; без кода перевода en-экран «Every entry of this kind…» показывал
 * её по-русски. Записи собираются ЗДЕСЬ теми же сборщиками, что и у импорта, с
 * латинскими данными: кириллица в английском показе может прийти только из
 * фразы сервера, а не из имени файла. И обратное направление: русский показ по
 * коду обязан совпасть с русской строкой сервера дословно — иначе словарь и
 * сервер разошлись, и ru-интерфейс показывал бы не ту фразу.
 */

const CYRILLIC = /[А-Яа-яЁё]/;
const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-intent-codes-'));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in params)) throw new Error(`no param ${name} in «${template}»`);
    return String(params[name]);
  });
}

/** Показ записи так же, как `serverFieldText(item, 'intent')`: код с подстановками, иначе строка сервера. */
function shown(item: EnvItem, dictionary: Record<string, string>): string {
  const code = item.intentCode;
  if (!isServerMessageCode(code)) return item.intent;
  const render = (inner: string, params?: Record<string, string | number>) =>
    dictionary[inner] === undefined ? undefined : interpolate(dictionary[inner], params ?? {});
  const params = resolveServerParams(item.intentParams, render);
  if (!params) throw new Error(`${item.id}: nested code unknown to the dictionary`);
  return interpolate(dictionary[code]!, params);
}

function everyProducer(): EnvItem[] {
  const source = sourceFactory('claude', 'global', null);
  const home = temp();
  const skillDir = join(home, 'skills', 'demo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nbody');
  writeFileSync(join(skillDir, 'notes.txt'), 'attached');
  const bareSkill = join(home, 'skills', 'bare');
  mkdirSync(bareSkill, { recursive: true });
  writeFileSync(join(bareSkill, 'SKILL.md'), '---\nname: bare\n---\nbody');

  const items: EnvItem[] = [
    instructionsItem({
      source,
      filePath: join(home, 'CLAUDE.md'),
      fileName: 'CLAUDE.md',
      legacy: false,
      raw: '',
      content: { text: 'Be brief.', includes: [] },
    }),
    skillItem({
      source,
      name: 'demo',
      description: 'Reviews code',
      body: 'b',
      dir: skillDir,
      enabled: true,
      raw: '',
    }),
    skillItem({
      source,
      name: 'bare',
      description: '',
      body: 'b',
      dir: bareSkill,
      enabled: true,
      raw: '',
    }),
    skillItem({
      source,
      name: 'cloud',
      description: 'x',
      body: 'b',
      dir: null,
      enabled: true,
      raw: '',
    }),
    skillItem({
      source,
      name: 'synced',
      description: 'x',
      body: 'b',
      dir: bareSkill,
      origin: 'account',
      enabled: true,
      raw: '',
    }),
    commandItem({
      source,
      name: 'ship',
      namespace: 'git',
      description: 'Ships it',
      prompt: 'go $ARGUMENTS',
      file: null,
      raw: '',
    }),
    commandItem({
      source,
      name: 'plain',
      namespace: null,
      description: '',
      prompt: 'go',
      file: null,
      raw: '',
    }),
    subagentItem(source, {
      name: 'helper',
      description: '',
      tools: null,
      disallowedTools: [],
      model: null,
      omitInstructions: false,
      body: 'b',
      filePath: join(home, 'agents', 'helper.md'),
      raw: '',
    }),
    subagentItem(source, {
      name: 'writer',
      description: 'Writes docs',
      tools: null,
      disallowedTools: [],
      model: null,
      omitInstructions: false,
      body: 'b',
      filePath: join(home, 'agents', 'writer.md'),
      raw: '',
    }),
    pluginItem({
      source,
      name: 'kit',
      version: '1.2.0',
      form: 'directory' as never,
      readOnly: false,
      provides: [],
      file: null,
      raw: '',
    }),
    pluginItem({
      source,
      name: 'bare-kit',
      version: null,
      form: 'directory' as never,
      readOnly: false,
      provides: [],
      file: null,
      raw: '',
    }),
    envVarOrSecret({ source, key: 'EDITOR', value: 'vim', file: null, holder: 'file' as never }),
    envVarOrSecret({
      source,
      key: 'OPENAI_API_KEY',
      value: 'sk-abc',
      file: null,
      holder: 'file' as never,
    }),
    preservedHookItem({ source, key: 'weird', value: 'x' }),
    ...normalizeHooks(
      [
        { event: 'PreToolUse', matcher: 'Bash', command: 'node guard.mjs', enabled: true },
        { event: 'Stop', matcher: null, command: 'node stop.mjs', enabled: true },
      ],
      { source, provider: claudeProvider, timeoutUnit: 's', ownMachine: true },
    ).items,
    ...normalizeMcpServers(
      [
        { name: 'files', transport: 'stdio', command: 'npx files' },
        { name: 'web', transport: 'http', url: 'https://mcp.example.com', enabled: false },
        { name: 'inproc', transport: 'sdk' },
      ],
      source,
    ).items,
    ...normalizeClaudePermissions(
      [
        { pattern: 'Bash(ls)', decision: 'allow', isEnabled: true, source: 'settings.json' },
        { pattern: 'Bash(rm:*)', decision: 'deny', isEnabled: false, source: 'settings.json' },
      ],
      source,
    ).items,
  ];

  const permissions = [
    {
      kind: 'codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only',
      sandboxPresent: false,
      usingDefaults: true,
    },
    {
      kind: 'codex',
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      sandboxPresent: false,
      usingDefaults: false,
    },
    {
      kind: 'gemini',
      approvalMode: 'default',
      coreTools: ['ReadFile'],
      excludeTools: ['Shell'],
      usingDefaults: false,
    },
    {
      kind: 'qwen',
      approvalMode: 'yolo',
      allow: ['a'],
      ask: ['b'],
      deny: ['c'],
      usingDefaults: true,
    },
    { kind: 'cursor', allow: ['a'], deny: ['c'], usingDefaults: false },
    { kind: 'continue', allow: ['a'], ask: ['b'], exclude: ['c'], usingDefaults: false },
    {
      kind: 'goose',
      mode: 'approve',
      usingDefaults: false,
      toolPermissions: { alwaysAllow: ['a'], askBefore: ['b'], neverAllow: ['c'] },
    },
    {
      kind: 'kimi',
      mode: 'manual',
      rules: [{ pattern: 'Shell', decision: 'ask' }],
      usingDefaults: true,
    },
    {
      kind: 'opencode',
      entries: [{ tool: 'bash', mode: 'level', level: 'ask' }],
      preserved: [],
      usingDefaults: false,
    },
  ];
  for (const values of permissions) {
    items.push(...normalizePermissions(values as never, source).items);
  }

  const probe = probeEnvironment({
    source: 'claude',
    scope: 'global',
    root: home,
    scripts: writeProbeScripts(temp()),
    capturedAt: new Date(0).toISOString(),
  });
  items.push(...probe.items);
  return items;
}

describe('фраза записи паспорта переводится по коду', () => {
  const items = everyProducer();

  it('собраны записи каждого вида и каждой ветки фразы', () => {
    const kinds = new Set(items.map((item) => item.kind));
    for (const kind of [
      'instructions',
      'skill',
      'command',
      'subagent',
      'plugin',
      'envVar',
      'secret',
      'hook',
      'mcpServer',
      'permission',
    ]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(items.length).toBeGreaterThan(40);
  });

  it('под en ни одна фраза не показывается по-русски', () => {
    const russian = items
      .map((item) => ({
        id: item.id,
        text: shown(item, serverMessagesEn as Record<string, string>),
      }))
      .filter((row) => CYRILLIC.test(row.text));
    expect(russian).toEqual([]);
  });

  it('под ru показ по коду дословно равен строке сервера', () => {
    const drift = items
      .filter((item) => item.intentCode !== undefined)
      .map((item) => ({
        id: item.id,
        server: item.intent,
        shown: shown(item, serverMessagesRu as Record<string, string>),
      }))
      .filter((row) => row.server !== row.shown);
    expect(drift).toEqual([]);
  });
});
