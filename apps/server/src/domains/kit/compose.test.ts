import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QWEN_EXTENSION,
  composeKit,
  composeQwenHome,
  composedRules,
  qwenCommandText,
  type ComposeInput,
} from './compose.ts';
import { listFiles } from './items.ts';
import { builtinKitDir, qwenVariantDir } from './service.ts';

/**
 * Сборка набора, который получает прогон: на маленьком наборе-образце во
 * временном каталоге (встроенный, «моё», цель — всё своё), чтобы каждая
 * проверка видела ровно то, что меняет.
 */

let root: string;
let builtin: string;
let mine: string;
let target: string;

const put = (dir: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
};
const read = (path: string): string => readFileSync(path, 'utf8');

const HOOKS = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/rules.mjs"' }] },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"' }],
      },
    ],
  },
};

function seedKit(dir: string): void {
  put(dir, '.claude-plugin/plugin.json', '{"name":"agentdeck-kit","version":"9.9.9"}');
  put(dir, 'skills/alpha/SKILL.md', '---\ndescription: встроенная альфа\n---\nALPHA-BUILTIN\n');
  put(dir, 'skills/alpha/reference.md', 'сосед альфы\n');
  put(dir, 'skills/beta/SKILL.md', '---\ndescription: бета\n---\nBETA\n');
  put(dir, 'commands/gamma.md', '---\ndescription: гамма\n---\nGAMMA\n');
  put(dir, 'rules/standard.md', '# Rules\n\n- STANDARD-RULE\n');
  put(dir, 'rules/local.md', '# Local\n\n- LOCAL-RULE\n');
  put(dir, 'hooks/hooks.json', `${JSON.stringify(HOOKS, null, 2)}\n`);
  put(dir, 'hooks/guard.mjs', '// guard\n');
  put(dir, 'hooks/rules.mjs', '// rules\n');
}

const input = (patch: Partial<ComposeInput> = {}): ComposeInput => ({
  builtinDir: builtin,
  mineDir: mine,
  disabled: [],
  yielded: [],
  target,
  ...patch,
});

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-kit-compose-')));
  builtin = join(root, 'builtin');
  mine = join(root, 'mine');
  target = join(root, 'effective', 'hybrid', 'agentdeck-kit');
  seedKit(builtin);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('composeKit: встроенный → поверх «моё» → минус выключенные и уступившие', () => {
  it('без правок — весь встроенный набор и отпечаток', () => {
    expect(composeKit(input())).toBe(target);
    expect(read(join(target, '.claude-plugin', 'plugin.json'))).toContain('agentdeck-kit');
    expect(read(join(target, 'skills', 'alpha', 'SKILL.md'))).toContain('ALPHA-BUILTIN');
    expect(existsSync(join(target, 'skills', 'alpha', 'reference.md'))).toBe(true);
    expect(JSON.parse(read(join(target, 'hooks', 'hooks.json')))).toEqual(HOOKS);
    expect(read(join(target, '.stamp'))).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(`${target}.staging`)).toBe(false);
  });

  it('копия «моё» встроенного файла побеждает; встроенный в приложении не тронут', () => {
    put(mine, 'skills/alpha/SKILL.md', 'ALPHA-MINE\n');
    composeKit(input());
    expect(read(join(target, 'skills', 'alpha', 'SKILL.md'))).toBe('ALPHA-MINE\n');
    expect(read(join(builtin, 'skills', 'alpha', 'SKILL.md'))).toContain('ALPHA-BUILTIN');
  });

  it('навык, команда, агент и правило только из «моё» попадают в сборку — это взятое из глобального', () => {
    put(mine, 'skills/zzz/SKILL.md', 'СВОЙ\n');
    put(mine, 'skills/alpha/extra.md', 'СОСЕДНИЙ\n');
    put(mine, 'agents/helper.md', 'АГЕНТ\n');
    put(mine, 'rules/own.md', 'ПРАВИЛО\n');
    composeKit(input());
    expect(read(join(target, 'skills', 'zzz', 'SKILL.md'))).toBe('СВОЙ\n');
    expect(read(join(target, 'skills', 'alpha', 'extra.md'))).toBe('СОСЕДНИЙ\n');
    expect(read(join(target, 'agents', 'helper.md'))).toBe('АГЕНТ\n');
    expect(read(join(target, 'rules', 'own.md'))).toBe('ПРАВИЛО\n');
  });

  it('хук и манифест плагина без встроенного двойника в сборку не попадают', () => {
    put(mine, 'hooks/x.mjs', 'ЧУЖОЙ\n');
    put(mine, '.claude-plugin/extra.json', '{}\n');
    composeKit(input());
    expect(existsSync(join(target, 'hooks', 'x.mjs'))).toBe(false);
    expect(existsSync(join(target, '.claude-plugin', 'extra.json'))).toBe(false);
  });

  it('выключенный навык уходит папкой — вместе с соседними файлами', () => {
    composeKit(input({ disabled: ['skills/alpha/SKILL.md'] }));
    expect(existsSync(join(target, 'skills', 'alpha'))).toBe(false);
    expect(existsSync(join(target, 'skills', 'beta', 'SKILL.md'))).toBe(true);
  });

  it('выключенные команда и правило уходят файлом', () => {
    composeKit(input({ disabled: ['commands/gamma.md', 'rules/local.md'] }));
    expect(existsSync(join(target, 'commands', 'gamma.md'))).toBe(false);
    expect(existsSync(join(target, 'rules', 'local.md'))).toBe(false);
    expect(existsSync(join(target, 'rules', 'standard.md'))).toBe(true);
  });

  it('выключенный хук: скрипт удалён и вычеркнут из hooks.json, опустевшее событие снято', () => {
    composeKit(input({ disabled: ['hooks/guard.mjs'] }));
    expect(existsSync(join(target, 'hooks', 'guard.mjs'))).toBe(false);
    const hooks = JSON.parse(read(join(target, 'hooks', 'hooks.json'))) as typeof HOOKS;
    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart']);
    expect(hooks.hooks.SessionStart).toEqual(HOOKS.hooks.SessionStart);
    // Встроенный hooks.json не тронут — вычёркивание только в сборке.
    expect(JSON.parse(read(join(builtin, 'hooks', 'hooks.json')))).toEqual(HOOKS);
  });

  it('в группе с двумя хуками вычёркивается только выключенный', () => {
    const shared = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"' },
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/rules.mjs"' },
            ],
          },
        ],
      },
    };
    put(builtin, 'hooks/hooks.json', JSON.stringify(shared));
    composeKit(input({ disabled: ['hooks/guard.mjs'] }));
    const hooks = JSON.parse(read(join(target, 'hooks', 'hooks.json'))) as typeof shared;
    expect(hooks.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/rules.mjs"' }],
      },
    ]);
  });

  it('уступившие в гибриде элементы уходят так же, как выключенные', () => {
    composeKit(input({ yielded: ['skills/beta/SKILL.md', 'commands/gamma.md'] }));
    expect(existsSync(join(target, 'skills', 'beta'))).toBe(false);
    expect(existsSync(join(target, 'commands', 'gamma.md'))).toBe(false);
    expect(existsSync(join(target, 'skills', 'alpha', 'SKILL.md'))).toBe(true);
  });

  it('отпечаток не изменился — сборка не пересобирается', () => {
    composeKit(input());
    writeFileSync(join(target, 'SENTINEL'), 'x');
    composeKit(input());
    expect(existsSync(join(target, 'SENTINEL'))).toBe(true);
  });

  it('правка «моё» пересобирает набор', () => {
    composeKit(input());
    writeFileSync(join(target, 'SENTINEL'), 'x');
    put(mine, 'commands/gamma.md', 'GAMMA-MINE\n');
    composeKit(input());
    expect(existsSync(join(target, 'SENTINEL'))).toBe(false);
    expect(read(join(target, 'commands', 'gamma.md'))).toBe('GAMMA-MINE\n');
  });

  it('новая версия встроенного файла (другая дата) пересобирает набор', () => {
    composeKit(input());
    writeFileSync(join(target, 'SENTINEL'), 'x');
    utimesSync(join(builtin, 'rules', 'standard.md'), new Date(), new Date(Date.now() + 60_000));
    composeKit(input());
    expect(existsSync(join(target, 'SENTINEL'))).toBe(false);
  });

  it('выключение элемента пересобирает набор, включение возвращает его', () => {
    composeKit(input());
    composeKit(input({ disabled: ['skills/beta/SKILL.md'] }));
    expect(existsSync(join(target, 'skills', 'beta'))).toBe(false);
    composeKit(input());
    expect(existsSync(join(target, 'skills', 'beta', 'SKILL.md'))).toBe(true);
  });

  it('путь с кириллицей (профиль Windows по-русски) собирается целиком', () => {
    const cyr = join(root, 'Данные панели');
    const cyrTarget = join(cyr, 'effective', 'ours', 'agentdeck-kit');
    put(join(cyr, 'mine'), 'skills/alpha/SKILL.md', 'ALPHA-MINE\n');
    composeKit(input({ mineDir: join(cyr, 'mine'), target: cyrTarget }));
    expect(read(join(cyrTarget, 'skills', 'alpha', 'SKILL.md'))).toBe('ALPHA-MINE\n');
    expect(existsSync(join(cyrTarget, 'hooks', 'guard.mjs'))).toBe(true);
    // Пересборка поверх прежней: прежний каталог обязан уйти, а не остаться
    // «удалённым» с подменой, которая затем не переименуется.
    composeKit(
      input({ mineDir: join(cyr, 'mine'), target: cyrTarget, disabled: ['hooks/guard.mjs'] }),
    );
    expect(existsSync(join(cyrTarget, 'hooks', 'guard.mjs'))).toBe(false);
    expect(existsSync(`${cyrTarget}.staging`)).toBe(false);
  });

  it('id с выходом из каталога в выключенных (правка state.json руками) набор не стирает', () => {
    composeKit(input({ disabled: ['skills/../SKILL.md', 'skills/..'] }));
    expect(existsSync(join(target, 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.stamp'))).toBe(true);
  });
});

describe('composedRules: правила одним текстом', () => {
  it('без локального варианта — без local.md', () => {
    const text = composedRules(builtin, false);
    expect(text).toContain('STANDARD-RULE');
    expect(text).not.toContain('LOCAL-RULE');
  });

  it('локальный вариант — local.md последним, как у хука SessionStart', () => {
    const text = composedRules(builtin, true);
    expect(text.indexOf('STANDARD-RULE')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('LOCAL-RULE')).toBeGreaterThan(text.indexOf('STANDARD-RULE'));
  });
});

describe('composeQwenHome: свой QWEN_HOME «только набор панели»', () => {
  const variant = (): string => {
    const dir = join(root, 'variant-qwen');
    put(dir, 'qwen-extension.json', '{"name":"agentdeck-kit","version":"9.9.9"}\n');
    return dir;
  };
  const ext = (home: string, ...rel: string[]): string =>
    join(home, 'extensions', QWEN_EXTENSION, ...rel);

  it('правила в QWEN.md; навыки, команды и хуки — расширением, без rules/', () => {
    put(builtin, 'commands/gamma.md', '---\ndescription: гамма\n---\nGAMMA $ARGUMENTS\n');
    composeKit(input({ disabled: ['skills/beta/SKILL.md'] }));
    const home = composeQwenHome(target, join(root, 'qwen-home'), true, variant());
    expect(read(join(home, 'QWEN.md'))).toContain('LOCAL-RULE');
    expect(JSON.parse(read(ext(home, 'qwen-extension.json')))).toMatchObject({
      name: 'agentdeck-kit',
    });
    expect(existsSync(ext(home, 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(ext(home, 'skills', 'beta'))).toBe(false);
    expect(read(ext(home, 'commands', 'gamma.md'))).toContain('GAMMA {{args}}');
    expect(read(ext(home, 'commands', 'gamma.md'))).not.toContain('$ARGUMENTS');
    expect(JSON.parse(read(ext(home, 'hooks', 'hooks.json')))).toEqual(HOOKS);
    expect(existsSync(ext(home, 'hooks', 'guard.mjs'))).toBe(true);
    expect(existsSync(ext(home, 'rules'))).toBe(false);
    expect(existsSync(ext(home, '.stamp'))).toBe(false);
    expect(existsSync(join(home, 'skills'))).toBe(false);
    expect(existsSync(join(home, 'settings.json'))).toBe(false);
    expect(existsSync(`${ext(home)}.staging`)).toBe(false);
  });

  it('снятый хук пропадает и скриптом, и из hooks.json расширения', () => {
    composeKit(input({ disabled: ['hooks/guard.mjs'] }));
    const home = composeQwenHome(target, join(root, 'qwen-home'), false, variant());
    expect(existsSync(ext(home, 'hooks', 'guard.mjs'))).toBe(false);
    expect(read(ext(home, 'hooks', 'hooks.json'))).not.toContain('guard.mjs');
    expect(read(ext(home, 'hooks', 'hooks.json'))).toContain('rules.mjs');
  });

  it('команда «моё» побеждает встроенную и тоже получает {{args}}; снятая — отсутствует', () => {
    put(builtin, 'commands/delta.md', 'DELTA $ARGUMENTS\n');
    put(mine, 'commands/gamma.md', 'GAMMA-MINE $ARGUMENTS\n');
    composeKit(input({ disabled: ['commands/delta.md'] }));
    const home = composeQwenHome(target, join(root, 'qwen-home'), false, variant());
    expect(read(ext(home, 'commands', 'gamma.md'))).toBe('GAMMA-MINE {{args}}\n');
    expect(existsSync(ext(home, 'commands', 'delta.md'))).toBe(false);
  });

  it('повторная сборка убирает навык, снятый между прогонами, и прежние skills/ дома', () => {
    composeKit(input());
    const home = join(root, 'qwen-home');
    put(home, 'skills/old/SKILL.md', 'OLD\n');
    composeQwenHome(target, home, false, variant());
    expect(existsSync(ext(home, 'skills', 'beta', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'skills'))).toBe(false);
    composeKit(input({ disabled: ['skills/beta/SKILL.md'] }));
    composeQwenHome(target, home, false, variant());
    expect(existsSync(ext(home, 'skills', 'beta'))).toBe(false);
    expect(read(join(home, 'QWEN.md'))).not.toContain('LOCAL-RULE');
  });

  it('правила варианта — в QWEN.md после правил набора и до local.md', () => {
    composeKit(input());
    const dir = variant();
    put(dir, 'rules/tools.md', 'QWEN-TOOLS-RULE\n');
    const text = read(join(composeQwenHome(target, join(root, 'qwen-home'), true, dir), 'QWEN.md'));
    expect(text.indexOf('QWEN-TOOLS-RULE')).toBeGreaterThan(text.indexOf('STANDARD-RULE'));
    expect(text.indexOf('LOCAL-RULE')).toBeGreaterThan(text.indexOf('QWEN-TOOLS-RULE'));
    // В расширение правила варианта не едут: Qwen считал бы их условными правилами.
    expect(existsSync(ext(join(root, 'qwen-home'), 'rules'))).toBe(false);
  });

  it('variants/qwen/rules/tools.md называет только инструменты, что есть в Qwen Code 0.25', () => {
    // Список инструментов, который qwen-code 0.25 отдал в init живого прогона 06.10
    // (`.agent/provider-formats.agent.md`); выдуманное имя модель позвала бы впустую.
    const QWEN_025 = new Set(
      'read_mcp_resource read_file zoom_image grep_search list_agents task_stop send_message skill search_memory glob record_artifact loop_wakeup get_goal update_goal tool_call agent notebook_edit run_shell_command report_findings enter_worktree exit_worktree monitor web_fetch tool_search manage_memory write_file edit'.split(
        ' ',
      ),
    );
    const text = read(join(qwenVariantDir(), 'rules', 'tools.md'));
    const named = [...text.matchAll(/→ `([a-z_]+)`/g)].map((match) => match[1] ?? '');
    expect(named.length).toBeGreaterThanOrEqual(9);
    expect(named.filter((name) => !QWEN_025.has(name))).toEqual([]);
  });

  it('variants/qwen — та же замена над командами встроенного набора и его манифест', () => {
    const kit = builtinKitDir();
    const qwen = qwenVariantDir();
    for (const name of listFiles(join(kit, 'commands'))) {
      expect(read(join(qwen, 'commands', name)), name).toBe(
        qwenCommandText(read(join(kit, 'commands', name))),
      );
    }
    const plugin = JSON.parse(read(join(kit, '.claude-plugin', 'plugin.json'))) as {
      name: string;
      version: string;
    };
    expect(JSON.parse(read(join(qwen, 'qwen-extension.json')))).toMatchObject({
      name: plugin.name,
      version: plugin.version,
    });
  });
});
