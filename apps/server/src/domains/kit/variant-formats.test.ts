import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterAll, describe, expect, it } from 'vitest';
import { array, boolean, enum as zodEnum, number, object, partialRecord, string } from 'zod';
import { builtinKitDir } from './service.ts';

/**
 * Варианты набора для CLI, которые человек ставит руками (`assets/kit/variants/<cli>/`), — против
 * ОПУБЛИКОВАННОГО формата каждого CLI, а не против нашего понимания его:
 *   Gemini CLI — `schemas/settings.schema.json` (`hooks`, `$defs.HookDefinitionArray`) и
 *                docs/hooks/reference.md (поля определения, таймаут в мс), docs/extensions/reference.md;
 *   Goose      — crates/goose/src/hooks/mod.rs (`HookEvent`, `RawHookRule`, `RawCommandAction`:
 *                таймаут в секундах; неверное регулярное выражение матчера молча снимает правило);
 *   Kimi Code  — src/kimi_cli/hooks/config.py (`HookDef`: event из 13, timeout 1..600 с);
 *   OpenCode   — docs/plugins (`chat.message`, `tool.execute.before/after`; имена сверены живым 1.18.35).
 * Схемы строгие: чужой ключ — провал, как и у самих CLI, что отвергают незнакомое. Затем «туда и
 * обратно» (разбор → запись → разбор — то же), каждая команда ведёт к `run.mjs` набора с событием,
 * которое он знает, и своим `--cli=`, каждый инструмент матчера — инструмент диалекта набора.
 *
 * И поддельный CLI на PATH (`tools/qa/fake-hook-cli.mjs`) для двух, кого здесь нет: он читает
 * вариант оттуда, куда его кладёт человек, исполняет команду и толкует ответ по документации CLI —
 * охрана набора срабатывает, безобидный вызов проходит.
 */

const KIT = resolve(process.env.KIT_UNDER_TEST || builtinKitDir());
const VARIANTS = join(dirname(builtinKitDir()), 'variants');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const FAKE = join(REPO, 'tools', 'qa', 'fake-hook-cli.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-variant-formats-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** События, которые принимает `hooks/lib/run.mjs` набора (items.mjs `runEvent`). */
const RUN_EVENTS = new Set(['prompt', 'pre', 'post-any', 'post-edit', 'post-fail', 'stop']);
const CLAUDE_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
  'Agent',
]);
const CMD =
  /^node "(?<root>\$\{extensionPath\}|\$\{PLUGIN_ROOT\}|<kit>)\/hooks\/lib\/run\.mjs" (?<event>[a-z-]+) --cli=(?<cli>[a-z]+)$/;

const read = (...parts: string[]): string => readFileSync(join(VARIANTS, ...parts), 'utf8');

/** Альтернативы матчера `^(a|b)$` — список имён; любой другой вид — как есть одним именем. */
function matcherTools(matcher: string): string[] {
  const m = /^\^\(?([^()]*?)\)?\$$/.exec(matcher);
  return m ? m[1]!.split('|') : [matcher];
}

type Lib = { normalize: (i: unknown) => Array<Record<string, unknown>> };
const lib = async (): Promise<Lib> =>
  (await import(pathToFileURL(join(KIT, 'hooks', 'lib', 'kit-paths.mjs')).href)) as Lib;

/** Общие проверки команды и матчера хука одного CLI. */
async function commandsAndMatchers(
  cli: string,
  root: string,
  entries: Array<{ command: string; matcher?: string }>,
): Promise<void> {
  const { normalize } = await lib();
  expect(entries.length).toBeGreaterThan(0);
  for (const { command, matcher } of entries) {
    const m = CMD.exec(command);
    expect(m, command).not.toBeNull();
    expect(m!.groups!.root).toBe(root);
    expect(m!.groups!.cli).toBe(cli);
    expect(RUN_EVENTS.has(m!.groups!.event!), command).toBe(true);
    if (!matcher) continue;
    expect(() => new RegExp(matcher), matcher).not.toThrow();
    for (const tool of matcherTools(matcher)) {
      const call = normalize({ agentdeck_cli: cli, tool_name: tool, tool_input: {} })[0]!;
      expect(CLAUDE_TOOLS.has(String(call.tool_name)), `${cli}: ${tool} → ${call.tool_name}`).toBe(
        true,
      );
    }
  }
  expect(existsSync(join(KIT, 'hooks', 'lib', 'run.mjs'))).toBe(true);
}

describe('Gemini CLI: расширение по settings.schema.json', () => {
  const GEMINI_EVENTS = [
    'BeforeTool',
    'AfterTool',
    'BeforeAgent',
    'AfterAgent',
    'Notification',
    'SessionStart',
    'SessionEnd',
    'PreCompress',
    'BeforeModel',
    'AfterModel',
    'BeforeToolSelection',
  ] as const;
  const hook = object({
    type: zodEnum(['command']),
    command: string().min(1),
    name: string().optional(),
    timeout: number().optional(),
    description: string().optional(),
  }).strict();
  const definition = object({
    matcher: string().optional(),
    sequential: boolean().optional(),
    hooks: array(hook).min(1),
  }).strict();
  const hooksFile = object({
    hooks: partialRecord(zodEnum(GEMINI_EVENTS), array(definition)),
  }).strict();
  const manifest = object({
    name: string().regex(/^[a-z0-9-]+$/),
    version: string().min(1),
    description: string().optional(),
  }).passthrough();

  it('hooks.json и манифест проходят схему; туда и обратно — то же; таймаут в мс', async () => {
    const raw = read('gemini', 'hooks', 'hooks.json');
    const parsed = hooksFile.parse(JSON.parse(raw));
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(JSON.parse(raw));
    const ext = manifest.parse(JSON.parse(read('gemini', 'gemini-extension.json')));
    // Хуки — не в манифесте (extensions/reference.md: «hooks are not defined in the manifest»).
    expect(ext).not.toHaveProperty('hooks');
    const entries = Object.values(parsed.hooks).flatMap((groups) =>
      groups.flatMap((g) =>
        g.hooks.map((h) => ({ command: h.command, matcher: g.matcher, timeout: h.timeout })),
      ),
    );
    for (const e of entries) expect(e.timeout).toBeGreaterThanOrEqual(1000);
    await commandsAndMatchers('gemini', '${extensionPath}', entries);
  });
});

describe('Goose: плагин Open Plugins по hooks/mod.rs', () => {
  const GOOSE_EVENTS = [
    'PreToolUse',
    'PreToolUseResult',
    'PostToolUse',
    'PostToolUseFailure',
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'BeforeReadFile',
    'AfterFileEdit',
    'BeforeShellExecution',
    'AfterShellExecution',
    'Stop',
  ] as const;
  const action = object({
    type: zodEnum(['command']),
    command: string().min(1),
    timeout: number().int().positive().optional(),
  }).strict();
  const rule = object({ matcher: string().optional(), hooks: array(action).min(1) }).strict();
  const hooksFile = object({ hooks: partialRecord(zodEnum(GOOSE_EVENTS), array(rule)) }).strict();

  it('hooks.json и plugin.json проходят схему; таймаут в секундах; матчеры — регулярные выражения', async () => {
    const raw = read('goose', 'hooks', 'hooks.json');
    const parsed = hooksFile.parse(JSON.parse(raw));
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(JSON.parse(raw));
    expect(
      object({ name: string().min(1) })
        .passthrough()
        .parse(JSON.parse(read('goose', 'plugin.json'))).name,
    ).toBe('agentdeck-kit');
    const entries = Object.values(parsed.hooks).flatMap((rules) =>
      rules.flatMap((r) =>
        r.hooks.map((h) => ({ command: h.command, matcher: r.matcher, timeout: h.timeout })),
      ),
    );
    // Секунды, не мс: 30 000 у Goose — восемь часов ожидания хука.
    for (const e of entries) expect(e.timeout).toBeLessThanOrEqual(600);
    // `*` — неверное выражение: Goose молча снял бы правило.
    for (const e of entries) if (e.matcher) expect(e.matcher).toMatch(/^\^.*\$$/);
    await commandsAndMatchers('goose', '${PLUGIN_ROOT}', entries);
  });
});

describe('Kimi Code: [[hooks]] по kimi_cli/hooks/config.py', () => {
  const KIMI_EVENTS = [
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'UserPromptSubmit',
    'Stop',
    'StopFailure',
    'SessionStart',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'PostCompact',
    'Notification',
  ] as const;
  const hookDef = object({
    event: zodEnum(KIMI_EVENTS),
    command: string().min(1),
    matcher: string().optional(),
    timeout: number().int().min(1).max(600).optional(),
  }).strict();

  it('hooks.toml разбирается в HookDef; туда и обратно — то же', async () => {
    const parsed = parseToml(read('kimi', 'hooks.toml')) as { hooks: unknown[] };
    expect(Object.keys(parsed)).toEqual(['hooks']);
    const hooks = array(hookDef).min(1).parse(parsed.hooks);
    expect(parseToml(stringifyToml({ hooks }))).toEqual(parsed);
    await commandsAndMatchers('kimi', '<kit>', hooks);
  });
});

describe('OpenCode: прослойка-плагин по docs/plugins', () => {
  it('экспорт — функция плагина; хуки — только документированные имена, каждый — функция', async () => {
    const mod = (await import(
      pathToFileURL(join(VARIANTS, 'opencode', 'plugins', 'agentdeck-kit.js')).href
    )) as Record<string, (ctx: { directory: string }) => Promise<Record<string, unknown>>>;
    const plugins = Object.values(mod);
    expect(plugins).toHaveLength(1);
    const hooks = await plugins[0]!({ directory: dir });
    expect(Object.keys(hooks).sort()).toEqual([
      'chat.message',
      'tool.execute.after',
      'tool.execute.before',
    ]);
    for (const fn of Object.values(hooks)) expect(typeof fn).toBe('function');
  });
});

describe('поддельный CLI на PATH исполняет вариант так, как его исполнил бы CLI', () => {
  const IS_WIN = process.platform === 'win32';
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['gemini', 'kimi']) {
    if (IS_WIN) writeFileSync(join(bin, `${name}.cmd`), `@node "${FAKE}" --as ${name} %*\r\n`);
    else
      writeFileSync(join(bin, name), `#!/bin/sh\nexec node "${FAKE}" --as ${name} "$@"\n`, {
        mode: 0o755,
      });
  }
  /** Чужой файл вне временных папок: охранник временные пропускает. */
  const TARGET = IS_WIN ? 'C:/agentdeck-qa-absent/x.ts' : '/agentdeck-qa-absent/x.ts';

  /** Дом с вариантом, поставленным по его README; запуск CLI по имени из PATH. */
  function call(cli: 'gemini' | 'kimi', home: string, tool: string, input: object) {
    const file = join(home, `input-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(input));
    const res = spawnSync(cli, ['tool', tool, `@${file}`], {
      cwd: home,
      encoding: 'utf8',
      shell: true,
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: [bin, process.env.PATH ?? process.env.Path ?? ''].join(delimiter),
        HOME: home,
        USERPROFILE: home,
        AGENTDECK_KIT_STATE: join(home, 'kit-state'),
        AGENTDECK_KIT_CLI: '',
        AGENTDECK_KIT_VARIANT: '',
        AGENTDECK_HEAVY_QUEUE_DIR: '',
      },
    });
    const line = res.stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(line || '{}') as { verdict?: string; reason?: string; hooks?: number };
  }

  it('Gemini: расширение в ~/.gemini/extensions — sed -i отказан охранником, echo прошёл', () => {
    const home = join(dir, 'gemini-home');
    const ext = join(home, '.gemini', 'extensions', 'agentdeck-kit');
    cpSync(KIT, ext, { recursive: true });
    cpSync(join(VARIANTS, 'gemini'), ext, { recursive: true });
    const sed = call('gemini', home, 'run_shell_command', { command: `sed -i 's/a/b/' ${TARGET}` });
    expect(sed.verdict).toBe('blocked');
    expect(sed.reason).toContain('inline-edit-guard');
    const echo = call('gemini', home, 'run_shell_command', { command: 'echo ok' });
    expect(echo).toMatchObject({ verdict: 'ran' });
    expect(echo.hooks).toBeGreaterThan(0);
  });

  it('Kimi: вариант дописан в ~/.kimi/config.toml с путём набора — sed -i отказан, echo прошёл', () => {
    const home = join(dir, 'kimi-home');
    const kit = join(dir, 'kimi-kit');
    cpSync(KIT, kit, { recursive: true });
    mkdirSync(join(home, '.kimi'), { recursive: true });
    const toml = read('kimi', 'hooks.toml').replaceAll('<kit>', kit.replaceAll('\\', '/'));
    writeFileSync(join(home, '.kimi', 'config.toml'), `default_model = "x"\n\n${toml}`);
    const sed = call('kimi', home, 'Shell', { command: `sed -i 's/a/b/' ${TARGET}` });
    expect(sed.verdict).toBe('blocked');
    expect(sed.reason).toContain('inline-edit-guard');
    const echo = call('kimi', home, 'Shell', { command: 'echo ok' });
    expect(echo).toMatchObject({ verdict: 'ran' });
    expect(echo.hooks).toBeGreaterThan(0);
  });
});
