import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as adapterTypes from '../adapter.types.ts';
import type { SessionSpec } from '../adapter.types.ts';
import { withPlatformDeny } from '../deny-overlay.ts';
import { READ_ONLY_DENIED } from '../read-only.ts';
import {
  bindClaudeEndpoint,
  CLAUDE_CHANNELS,
  classifyClaudeError,
  createClaudeAdapter,
  planClaude as planWithLayer,
  refuseClaude,
  VENDOR_CREDENTIALS,
} from './claude.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { claudeAbsolutePattern, claudePathPatterns } from './path-pattern.ts';
import { claudeDenyRules, keepHumanAllow, mapClaudePermission } from './permission.ts';
import { layerHooks, readUserLayer } from './user-layer.ts';

/** План доверенного репозитория — слой как просили; недоверенная копия (F-86) — своими случаями. */
const planClaude = (spec: SessionSpec, binding?: Parameters<typeof planWithLayer>[1]) =>
  planWithLayer(spec, binding, trustedLayer(spec));

/** Находки ревью core-s2 по переходнику Claude Code: каждая — своим случаем, красным до правки. */

const CHANNEL = CLAUDE_CHANNELS[0]!;
const ENDPOINT = {
  baseUrl: 'http://127.0.0.1:9',
  dialect: 'anthropic-messages' as const,
  model: 'stub-model',
  key: 'k-1',
};
const NONE = { paths: [], commands: [], mcpTools: [], tools: [] };

const tmp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: '44444444-4444-4444-8444-444444444444',
    dir: join(tmpdir(), 'claude-sec-session'),
    cwd: join(tmpdir(), 'claude-sec-work'),
    brief: 'BRIEF',
    deny: NONE,
    platform: { coreHome: join(tmpdir(), 'claude-sec-core'), tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    coreHook: 'node core-hook.mjs',
    ...over,
  };
}

/** `--settings` ядра, как его пишет план (поля, которые читают случаи ниже). */
interface CoreSettings {
  permissions: { allow?: string[]; ask?: string[]; deny: string[]; defaultMode: string };
  env: Record<string, string>;
  disableAllHooks?: boolean;
  hooks: Record<string, unknown[]>;
}

const settingsOf = (plan: { files: Record<string, string> }): CoreSettings =>
  JSON.parse(plan.files['claude/settings.json']!) as CoreSettings;

/** Каталог настроек человека и копия с `.claude` внутри. */
function layered(user: object, project?: object): { pin: Record<string, string>; cwd: string } {
  const root = tmp('claude-sec-layer-');
  const config = join(root, 'cfg');
  const cwd = join(root, 'work');
  mkdirSync(config, { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(config, 'settings.json'), JSON.stringify(user));
  if (project) writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(project));
  return { pin: { CLAUDE_CONFIG_DIR: config }, cwd };
}

function binding() {
  const bound = bindClaudeEndpoint(CHANNEL, ENDPOINT);
  if (!bound.ok) throw new Error('binding refused');
  return bound.binding;
}

describe('F-07: the endpoint binding outranks env from human and repo settings', () => {
  it('layer on: our --settings carries the binding env, a source above user/project', () => {
    const settings = settingsOf(planClaude(spec(), binding()));
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_AUTH_TOKEN: 'k-1',
      ANTHROPIC_MODEL: 'stub-model',
    });
  });

  it('layer observe: a human env routing key loses to the binding; a repo routing key is dropped', () => {
    const { pin, cwd } = layered(
      { env: { ANTHROPIC_BASE_URL: 'http://user.example', FOO: 'user' } },
      { env: { ANTHROPIC_BASE_URL: 'http://repo.example', ANTHROPIC_API_KEY: 'x', BAR: 'repo' } },
    );
    const bound = settingsOf(
      planClaude(spec({ cwd, env: { pin }, layer: { hooks: 'observe', skills: 'on' } }), binding()),
    );
    expect(bound.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9');
    expect(bound.env).toMatchObject({ FOO: 'user', BAR: 'repo' });
    // Без привязки (вход человека) адрес репозитория тоже не доходит.
    const unbound = settingsOf(
      planClaude(spec({ cwd, env: { pin }, layer: { hooks: 'observe', skills: 'on' } })),
    );
    expect(unbound.env.ANTHROPIC_BASE_URL).toBe('http://user.example');
    expect(unbound.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('F-08: the human disableAllHooks cannot drop the core hook', () => {
  it('every mode writes disableAllHooks:false in our settings', () => {
    const { pin, cwd } = layered({ disableAllHooks: true });
    for (const mode of ['on', 'observe', 'off'] as const) {
      const settings = settingsOf(
        planClaude(spec({ cwd, env: { pin }, layer: { hooks: mode, skills: 'on' } })),
      );
      expect(settings.disableAllHooks).toBe(false);
      expect(settings.hooks.PreToolUse).toContainEqual({
        matcher: '*',
        hooks: [{ type: 'command', command: 'node core-hook.mjs' }],
      });
    }
  });
});

describe('F-09: other vendor credentials never reach the session', () => {
  it('every vendor key but the bound one is blanked in the binding env', () => {
    const env = binding().env;
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k-1');
    expect(VENDOR_CREDENTIALS.some((name) => !/^(ANTHROPIC|CLAUDE|AWS)_/.test(name))).toBe(true);
    for (const name of VENDOR_CREDENTIALS) {
      if (name !== 'ANTHROPIC_AUTH_TOKEN') expect(env[name], name).toBe('');
    }
  });
});

describe('F-10: no session without the core hook', () => {
  it('refuses at launch, before any spawn; tests opt out explicitly', async () => {
    const unhooked = spec({ coreHook: undefined });
    expect(refuseClaude(unhooked)).toMatch(/no core hook/);
    expect(refuseClaude(unhooked, { unhookedForTests: true })).toBeNull();
    expect(refuseClaude(spec())).toBeNull();
    await expect(createClaudeAdapter().launch(unhooked)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no core hook/),
    });
  });
});

describe('F-12: Claude settings are edit-denied wherever the CLI would read them', () => {
  it('the copy .claude (platform overlay), nested .claude below cwd and the human config dir', () => {
    const copy = tmp('claude-sec-copy-');
    mkdirSync(join(copy, '.git'));
    const config = join(copy, '..', 'claude-sec-cfg');
    const deny = withPlatformDeny(
      { coreHome: join(copy, '..', 'core'), tokenFiles: [] },
      NONE,
      copy,
    );
    const rules = settingsOf(
      planClaude(spec({ cwd: copy, deny, env: { pin: { CLAUDE_CONFIG_DIR: config } } })),
    ).permissions.deny as string[];
    const at = claudeAbsolutePattern(copy);
    expect(rules).toEqual(
      expect.arrayContaining([
        `Edit(${at}/.claude)`,
        `Edit(${at}/.claude/**)`,
        `Edit(${at}/.qwen/**)`,
        `Edit(${at}/.git/**)`,
        `Edit(${at}/**/.claude)`,
        `Edit(${at}/**/.claude/**)`,
        `Edit(${claudeAbsolutePattern(config)}/**)`,
      ]),
    );
    // Чтение настроек не запрещено — только правка.
    expect(rules).not.toContain(`Read(${at}/.claude/**)`);
  });
});

describe('F-31: a denied argv prefix binds every shell tool', () => {
  it('PowerShell gets the same prefix rule as Bash', () => {
    const { rules } = claudeDenyRules({ ...NONE, commands: [['git', 'push']] }, [], '/w');
    expect(rules).toEqual(['Bash(git push:*)', 'PowerShell(git push:*)']);
  });
});

describe('F-32: human allow rules that would answer before the judge are not carried', () => {
  it('open shell allows are dropped, narrow ones kept', () => {
    for (const rule of [
      'Bash',
      'Bash()',
      'Bash(*)',
      'Bash(:*)',
      'Bash(git:*)',
      'Bash(git push:*)',
      'Bash(sh -c:*)',
      'Bash(/usr/bin/git:*)',
      'Bash(g*:*)',
      'Bash(env:*)',
      'PowerShell',
      'PowerShell(pwsh.exe:*)',
      'PowerShell(Invoke-Expression:*)',
    ]) {
      expect(keepHumanAllow(rule), rule).toBe(false);
    }
    for (const rule of [
      'Read',
      'Edit(src/**)',
      'Bash(npm test:*)',
      'PowerShell(Get-ChildItem:*)',
    ]) {
      expect(keepHumanAllow(rule), rule).toBe(true);
    }
  });

  it('repo allow rules are never imported; human allow is filtered', () => {
    const { pin, cwd } = layered(
      { permissions: { allow: ['Read', 'Bash(git:*)', 'Bash(npm test:*)'] } },
      { permissions: { allow: ['WebFetch', 'Bash(npm run x:*)'], deny: ['Write'] } },
    );
    const settings = settingsOf(
      planClaude(spec({ cwd, env: { pin }, layer: { hooks: 'observe', skills: 'on' } })),
    );
    expect(settings.permissions.allow).toEqual(['Read', 'Bash(npm test:*)']);
    // Запрет из репозитория остаётся: он только сужает.
    expect(settings.permissions.deny).toContain('Write');
  });
});

describe('F-33: a hook event name is never shell text in the recorder command', () => {
  it('unknown event names are dropped before the recorder line is built', () => {
    const layer = readUserLayer([]);
    const out = layerHooks(
      {
        ...layer,
        hooks: {
          'x & calc': [{ hooks: [{ type: 'command', command: 'a' }] }],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'b' }] }],
        },
      },
      'observe',
      { command: 'rec', log: 'l' },
      'obs',
    );
    expect(Object.keys(out.hooks)).toEqual(['PreToolUse']);
    expect(JSON.stringify(out)).not.toContain('calc');
  });
});

describe('F-34 / F-95: a settings file of the wrong shape is unreadable, never a throw or junk', () => {
  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"x"'],
    ['env as a string', '{"env":"abc"}'],
    ['permissions null', '{"permissions":null}'],
    ['hooks array', '{"hooks":[]}'],
  ])('%s', (_, body) => {
    const file = join(tmp('claude-sec-bad-'), 'settings.json');
    writeFileSync(file, body);
    const layer = readUserLayer([file]);
    expect(layer.unreadable).toEqual([file]);
    expect(layer.env).toEqual({});
  });
});

describe('F-35: unreadable human settings refuse an observe/off session', () => {
  it('names the file; layer on is untouched (the CLI reads its own files)', () => {
    const root = tmp('claude-sec-broken-');
    writeFileSync(join(root, 'settings.json'), '{broken');
    const pin = { CLAUDE_CONFIG_DIR: root };
    for (const mode of ['observe', 'off'] as const) {
      expect(refuseClaude(spec({ env: { pin }, layer: { hooks: mode, skills: 'on' } }))).toMatch(
        /unreadable/,
      );
    }
    expect(refuseClaude(spec({ env: { pin } }))).toBeNull();
  });
});

describe('F-36: a relative deny path resolves from the session cwd', () => {
  it('becomes the absolute rule of cwd/rel', () => {
    const cwd = join(tmpdir(), 'claude-sec-rel');
    const { rules } = claudeDenyRules({ ...NONE, paths: ['rel/x'] }, [], cwd);
    expect(rules).toContain(`Read(${claudeAbsolutePattern(join(cwd, 'rel', 'x'))})`);
    expect(rules.some((rule) => rule.includes('//rel/x'))).toBe(false);
  });
});

describe('F-37 / F-127 / F-126: every spelling of a denied path is covered', () => {
  const matches = (path: string, pattern: string): boolean => posix.matchesGlob(path, pattern);

  it('glob specials in a name are literal-safe; the \\\\?\\ prefix is the drive form', () => {
    expect(claudeAbsolutePattern('C:\\x\\Core[1]Home')).toBe('//c/x/Core?1?Home');
    expect(matches('//c/x/Core[1]Home', '//c/x/Core?1?Home')).toBe(true);
    expect(claudeAbsolutePattern('\\\\?\\C:\\x\\home')).toBe('//c/x/home');
    expect(claudeAbsolutePattern('\\\\.\\C:\\x\\home')).toBe('//c/x/home');
  });

  it('8.3 short names and any case match the tolerant form', () => {
    const forms = claudePathPatterns('C:\\Users\\me\\.agentdeck\\core-token.txt');
    const hit = (path: string): boolean => forms.some((form) => matches(path, form));
    expect(hit('//c/Users/me/.agentdeck/core-token.txt')).toBe(true);
    expect(hit('//c/Users/me/AGENTD~1/CORE-T~1.TXT')).toBe(true);
    expect(hit('//C/USERS/ME/.AGENTDECK/CORE-TOKEN.TXT')).toBe(true);
    expect(hit('//c/Users/me/.agentdeck/other.txt')).toBe(false);
    expect(hit('//c/Users/you/.agentdeck/core-token.txt')).toBe(false);
  });

  it('the admin share of this machine is listed for localhost and 127.0.0.1', () => {
    const forms = claudePathPatterns('C:\\core');
    expect(forms).toEqual(expect.arrayContaining(['///localhost/C$/core', '///127.0.0.1/C$/core']));
    // POSIX — одна форма.
    expect(claudePathPatterns('/home/core')).toEqual(['//home/core']);
  });
});

describe('F-126 / F-127 follow-up: device prefixes, share deny paths and the 8.3 hash name', () => {
  const matches = (path: string, pattern: string): boolean => posix.matchesGlob(path, pattern);
  const hitter =
    (path: string) =>
    (spelling: string): boolean =>
      claudePathPatterns(path).some((form) => matches(spelling, form));

  // Строки — как CLI сравнивает путь модели (живые пробы V5/V6): `\\?\C:\x` → `//?/C:/x`,
  // `\\?\UNC\localhost\C$\x` → `//?/UNC/localhost/C$/x`; правило `//…` = путь от корня.
  it('\\\\?\\C:\\ and \\\\?\\UNC\\<this host>\\C$\\ spellings of a drive path are denied', () => {
    const hit = hitter('C:\\Users\\me\\.agentdeck\\core-token.txt');
    expect(hit('///?/C:/Users/me/.agentdeck/core-token.txt')).toBe(true);
    expect(hit('///?/c:/USERS/ME/AGENTD~1/CORE-T~1.TXT')).toBe(true);
    expect(hit('///?/UNC/localhost/C$/Users/me/.agentdeck/core-token.txt')).toBe(true);
    expect(hit('///?/unc/127.0.0.1/c$/Users/me/.agentdeck/core-token.txt')).toBe(true);
    expect(hit('///?/UNC/elsewhere/C$/Users/me/.agentdeck/core-token.txt')).toBe(false);
    expect(hit('///?/D:/Users/me/.agentdeck/core-token.txt')).toBe(false);
  });

  it('the 8.3 hash short name of any one segment is denied, its siblings are not', () => {
    const hit = hitter('C:\\Users\\me\\.agentdeck\\core-token.txt');
    expect(hit('//c/Users/me/AGC9C9~1/core-token.txt')).toBe(true);
    expect(hit('//c/Users/me/AGC9C9~1/CO1A2B~1.TXT')).toBe(false); // два хэш-имени — остаток
    // `*` CLI сверяет и с именем на точку (живая проба V7), matchesGlob — нет: здесь без точки.
    expect(hit('//c/Users/me/AGENTD~1/CO1A2B~1.TXT')).toBe(true);
    expect(hit('///localhost/c$/USERS/ME/AGC9C9~1/CORE-T~1.TXT')).toBe(true);
    expect(hit('//c/Users/me/XYC9C9~1/core-token.txt')).toBe(false);
    expect(hit('//c/Users/me/AGC9C9~1/other.txt')).toBe(false);
  });

  it('a deny path on a network share gets case, 8.3 and \\\\?\\UNC\\ forms too', () => {
    const hit = hitter('\\\\files\\Team Share\\agentdeck-home\\core-token.txt');
    expect(hit('///files/Team Share/agentdeck-home/core-token.txt')).toBe(true);
    expect(hit('///FILES/team share/AGENTD~1/CORE-T~1.TXT')).toBe(true);
    expect(hit('///?/UNC/files/Team Share/agentdeck-home/core-token.txt')).toBe(true);
    expect(hit('///files/Other/agentdeck-home/core-token.txt')).toBe(false);
  });
});

describe('F-02 (adapter half): argv the parser may misread is marked inexact', () => {
  it('escapes, expansions, globs and braces → argvExact false; plain text → true', () => {
    const exact = (tool: string, command: string): boolean | undefined =>
      mapClaudePermission({ tool, input: { command } }).argvExact;
    for (const command of [
      'gi\\t push origin main',
      "$'\\x67it' push",
      'git p\\ush',
      'git pu[s]h',
      'git {push,}',
      'git push>out',
      '$(echo git) push',
      '`echo git` push',
    ]) {
      expect(exact('Bash', command), command).toBe(false);
    }
    expect(exact('Bash', 'git push origin main && npm test | tee x')).toBe(true);
    expect(exact('PowerShell', 'g`it push')).toBe(false);
    expect(exact('PowerShell', '& "git" push')).toBe(false);
    expect(exact('PowerShell', 'git push origin main')).toBe(true);
  });
});

describe('F-95: resume id and missing-conversation classification', () => {
  it('a resume id that reads as a flag is refused', () => {
    expect(refuseClaude(spec({ resume: { conversationId: '--settings=x' } }))).toMatch(/resume id/);
    expect(refuseClaude(spec({ resume: { conversationId: 'conv-9' } }))).toBeNull();
  });

  it('only a whole error line means the conversation is gone', () => {
    const line = 'No conversation found with session ID: 4b2c-11';
    expect(classifyClaudeError(line)).toBe('fresh-required');
    expect(classifyClaudeError(`a; ${line}`)).toBe('fresh-required');
    expect(classifyClaudeError(`hook said: "${line}" and more`)).toBeNull();
    expect(classifyClaudeError('model error')).toBeNull();
  });
});

describe('F-96: the read-only tool set lives in a runtime module', () => {
  it('the types module carries no runtime value', () => {
    expect(READ_ONLY_DENIED).toEqual(['write', 'edit', 'shell']);
    expect(Object.keys(adapterTypes)).toEqual([]);
  });
});
