import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  localLayerRun,
  localLayerStatus,
  mergeFlagSettings,
  withoutMcpConfig,
  withoutProjectSource,
  writeLayerMode,
} from './local-layer.ts';
import { yieldToLocal } from './build.ts';
import { relocate } from './overrides.ts';
import { sectionSha, splitSections } from './sections.ts';
import type { TeamPlace } from './team-layer.ts';

/**
 * Локальный слой: всё командное доезжает (дословно или свежим сжатием), замена
 * хуков действует только против той командной версии, которую улучшает. Что
 * собранные флаги делают с НАСТОЯЩИМ CLI — доказывает `tools/qa/check-local-layer.mjs`.
 */

let base: string;
let root: string;
let place: TeamPlace;

/** Форма собранного settings.json, которую читают проверки. */
type BuiltSettings = {
  permissions?: unknown;
  model?: unknown;
  hooks: { PreToolUse: { hooks: { command: string }[] }[]; PostToolUse?: unknown };
};

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const build = (name: string): string =>
  readFileSync(join(root, '.agent', 'local-layer', 'build', name), 'utf8');
/** mtime вперёд: два письма в одну миллисекунду отпечаток иначе не различил бы. */
const touch = (file: string, text: string): void => {
  write(file, text);
  const later = new Date(Date.now() + 5_000);
  utimesSync(file, later, later);
};

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-local-layer-')));
  root = join(base, 'proj');
  mkdirSync(root, { recursive: true });
  // Дом — настоящий: временный каталог на Windows лежит под ним, и личный
  // `~/.claude/CLAUDE.md` иначе прочёлся бы как `.claude/CLAUDE.md` предка.
  place = {
    home: homedir(),
    configDir: join(base, 'config'),
    caseless: process.platform === 'win32',
  };
  write(join(place.configDir, 'settings.json'), '{}');
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  write(join(root, '.gitignore'), '.agent/\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function teamLayer(): void {
  write(join(root, 'CLAUDE.md'), '# Team\n\nTEAM_MD\n\n## Build\n\nBUILD_SECTION long text here\n');
  write(join(root, 'docs', 'extra.md'), 'IMPORTED_TEXT\n');
  write(join(root, '.claude', 'CLAUDE.md'), 'Also see @../docs/extra.md\n');
  write(join(root, '.claude', 'rules', 'always.md'), '# Always\n\nRULE_ALWAYS\n');
  write(
    join(root, '.claude', 'rules', 'scoped.md'),
    '---\npaths:\n  - "src/**/*.{ts,tsx}"\n---\n# Scoped\n\nRULE_SCOPED\n',
  );
  write(join(root, 'sub', 'CLAUDE.md'), 'NESTED_MD\n');
  write(join(root, 'skipped', 'CLAUDE.md'), 'EXCLUDED_MD\n');
  write(
    join(root, '.claude', 'skills', 'team-skill', 'SKILL.md'),
    '---\nname: team-skill\ndescription: x\n---\nbody\n',
  );
  write(join(root, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\nagent\n');
  write(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { on: { command: 'a' }, off: { command: 'b' } } }),
  );
  write(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'team-model',
      permissions: { deny: ['Bash(rm -rf:*)'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/guard.mjs"' }],
          },
        ],
      },
    }),
  );
  write(
    join(root, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'my-model', enabledMcpjsonServers: ['on'] }),
  );
  write(
    join(place.configDir, 'settings.json'),
    JSON.stringify({ claudeMdExcludes: ['**/proj/skipped/CLAUDE.md'] }),
  );
  git('add', '-A');
  git('commit', '-qm', 'team');
}

describe('без layer.json слоя нет', () => {
  it('ни одного файла, прогон без слоя', () => {
    teamLayer();
    const status = localLayerStatus(root, place);
    expect(status).toMatchObject({ configured: false, used: false, reason: 'no-config' });
    expect(localLayerRun(root, place)).toBeUndefined();
    expect(existsSync(join(root, '.agent', 'local-layer'))).toBe(false);
  });
});

describe('сборка: всё командное доезжает', () => {
  it('инструкции, правила, навыки, MCP, хуки и права — дословно', () => {
    teamLayer();
    writeLayerMode(root, 'on');
    const run = localLayerRun(root, place);
    expect(run?.status).toMatchObject({
      used: true,
      reason: 'on',
      pathRules: 2,
      skills: ['team-skill'],
    });

    const instructions = build('instructions.md');
    for (const mark of ['TEAM_MD', 'BUILD_SECTION', 'IMPORTED_TEXT', 'RULE_ALWAYS']) {
      expect(instructions).toContain(mark);
    }
    // Правило по путям и вложенный CLAUDE.md — НЕ в начале сессии, а по касанию.
    expect(instructions).not.toContain('RULE_SCOPED');
    expect(instructions).not.toContain('NESTED_MD');
    expect(instructions).not.toContain('EXCLUDED_MD');
    expect(instructions).toContain(`Contents of ${join(root, 'CLAUDE.md')}`);
    expect(run?.append).toBe(instructions);

    const rules = JSON.parse(build('rules.json')) as {
      rules: Array<{ id: string; patterns: string[] }>;
    };
    expect(rules.rules.map((rule) => rule.id).sort()).toEqual([
      '.claude/rules/scoped.md',
      'sub/CLAUDE.md',
    ]);

    const settings = run?.settings as BuiltSettings;
    expect(settings.permissions).toEqual({ deny: ['Bash(rm -rf:*)'] });
    // Локальный файл задаёт модель сам — командная не должна его перебить флагом.
    expect(settings.model).toBeUndefined();
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      'node "$CLAUDE_PROJECT_DIR/scripts/guard.mjs"',
    );
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('path-rules.mjs');

    expect(JSON.parse(build('mcp.json'))).toEqual({ mcpServers: { on: { command: 'a' } } });
    expect(
      existsSync(
        join(root, '.agent', 'local-layer', 'build', 'plugin', 'skills', 'team-skill', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(root, '.agent', 'local-layer', 'build', 'plugin', 'agents', 'helper.md')),
    ).toBe(true);
    expect(run?.args).toEqual([
      '--plugin-dir',
      join(root, '.agent', 'local-layer', 'build', 'plugin'),
      '--mcp-config',
      join(root, '.agent', 'local-layer', 'build', 'mcp.json'),
    ]);
  });

  it('режим «авто» без выгоды не подключает слой', () => {
    teamLayer();
    writeLayerMode(root, 'auto');
    expect(localLayerStatus(root, place)).toMatchObject({ used: false, reason: 'no-gain' });
    expect(localLayerRun(root, place)).toBeUndefined();
  });

  it('пересборка только при изменении командного слоя', () => {
    teamLayer();
    writeLayerMode(root, 'on');
    const first = localLayerStatus(root, place).builtAt;
    expect(localLayerStatus(root, place).builtAt).toBe(first);
    touch(join(root, '.claude', 'rules', 'always.md'), '# Always\n\nRULE_ALWAYS_V2\n');
    const status = localLayerStatus(root, place);
    expect(build('instructions.md')).toContain('RULE_ALWAYS_V2');
    expect(status.builtAt).toBeDefined();
  });
});

describe('сжатие — гибрид: свежее едет сжатым, устаревшее — дословно', () => {
  const compressed = (sha: string): string =>
    `---\nsource: CLAUDE.md\nsection: "## Build"\nsha: ${sha}\n---\n## Build\nSHORT\n`;

  it('свежее сжатие подставлено и даёт выгоду в «авто»', () => {
    teamLayer();
    writeLayerMode(root, 'auto');
    const section = splitSections(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).find(
      (item) => item.heading === '## Build',
    );
    write(
      join(root, '.agent', 'local-layer', 'compressed', 'build.md'),
      compressed(sectionSha(section?.text ?? '')),
    );
    write(
      join(root, 'CLAUDE.md'),
      `# Team\n\nTEAM_MD\n\n## Build\n\nBUILD_SECTION long text here\n${'x'.repeat(600)}\n`,
    );
    // Сжатие сделано с прежнего текста — теперь оно устарело.
    let status = localLayerStatus(root, place);
    expect(status.instructions.pending).toEqual(['CLAUDE.md → ## Build']);
    expect(build('instructions.md')).toContain('BUILD_SECTION');
    expect(status.used).toBe(false);

    const fresh = splitSections(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).find(
      (item) => item.heading === '## Build',
    );
    touch(
      join(root, '.agent', 'local-layer', 'compressed', 'build.md'),
      compressed(sectionSha(fresh?.text ?? '')),
    );
    status = localLayerStatus(root, place);
    expect(status.instructions.compressed).toBe(1);
    expect(status.instructions.pending).toEqual([]);
    expect(build('instructions.md')).toContain('SHORT');
    expect(build('instructions.md')).not.toContain('BUILD_SECTION');
    expect(status).toMatchObject({ used: true, reason: 'gain' });
  });

  it('сжатие без командного оригинала — сирота, не используется', () => {
    teamLayer();
    writeLayerMode(root, 'on');
    write(
      join(root, '.agent', 'local-layer', 'compressed', 'ghost.md'),
      '---\nsource: CLAUDE.md\nsection: "## Gone"\nsha: 0\n---\nGHOST\n',
    );
    const status = localLayerStatus(root, place);
    expect(status.orphans).toHaveLength(1);
    expect(build('instructions.md')).not.toContain('GHOST');
  });
});

describe('замена хуков действует только против той версии, что улучшает', () => {
  const guard = (body: string): string =>
    [
      "import { dirname } from 'node:path';",
      "import { realpathSync } from 'node:fs';",
      "import { helper } from './lib.mjs';",
      'const ROOT = dirname(dirname(import.meta.filename));',
      `export const body = '${body}';`,
      'export const self = () => realpathSync(process.argv[1]) === realpathSync(import.meta.filename);',
      'console.log(ROOT, helper());',
      '',
    ].join('\n');

  function withOverride(): string {
    teamLayer();
    write(join(root, 'scripts', 'guard.mjs'), guard('slow'));
    write(join(root, 'scripts', 'lib.mjs'), 'export const helper = () => 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'guard');
    git('checkout', '-qb', 'fast');
    write(join(root, 'scripts', 'guard.mjs'), guard('fast'));
    git('commit', '-qam', 'fast guard');
    const ref = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '-');
    write(
      join(root, '.agent', 'local-layer', 'layer.json'),
      JSON.stringify({
        mode: 'auto',
        overrides: [{ ref, entries: ['scripts/guard.mjs'], why: 'faster' }],
      }),
    );
    return ref;
  }

  it('действует: копия перенесена, команда хука смотрит в неё', () => {
    withOverride();
    const run = localLayerRun(root, place);
    expect(run?.status.overrides[0]).toMatchObject({
      state: 'active',
      improved: ['scripts/guard.mjs'],
    });
    expect(run?.status.reason).toBe('gain');
    const copy = join(root, '.agent', 'local-layer', 'build', 'overrides', 'scripts', 'guard.mjs');
    const text = readFileSync(copy, 'utf8');
    expect(text).toContain("'fast'");
    // Корень — путь оригинала; сравнение «запущен ли я сам» осталось своим.
    expect(text).toContain(
      JSON.stringify(join(root, 'scripts', 'guard.mjs').replaceAll('\\', '/')),
    );
    expect(text).toContain('realpathSync(import.meta.filename)');
    expect(existsSync(join(dirname(copy), 'lib.mjs'))).toBe(true);
    const command = (run?.settings as BuiltSettings).hooks.PreToolUse[0]?.hooks[0]?.command;
    expect(command).toBe(`node "${copy.replaceAll('\\', '/')}"`);
    // Перенесённая копия запускается и видит корень оригинала.
    const out = execFileSync(process.execPath, [copy], { encoding: 'utf8' });
    expect(out.trim()).toBe(`${root.replaceAll('\\', '/')} 1`);
  });

  // Linux/macOS: хук, вызванный прямо, без бита исполнения падал с кодом 126.
  it.skipIf(process.platform === 'win32')('исполняемый командный файл — копия тоже', () => {
    withOverride();
    chmodSync(join(root, 'scripts', 'guard.mjs'), 0o755);
    localLayerRun(root, place);
    const copy = join(root, '.agent', 'local-layer', 'build', 'overrides', 'scripts');
    expect(statSync(join(copy, 'guard.mjs')).mode & 0o111).not.toBe(0);
    expect(statSync(join(copy, 'lib.mjs')).mode & 0o111).toBe(0);
  });

  it('ветка правит файл, который замена не трогает, — в копии командная правка', () => {
    withOverride();
    touch(join(root, 'scripts', 'lib.mjs'), "export { helper } from './lib2.mjs';\n");
    write(join(root, 'scripts', 'lib2.mjs'), 'export const helper = () => 2;\n');
    const run = localLayerRun(root, place);
    expect(run?.status.overrides[0]).toMatchObject({
      state: 'active',
      improved: ['scripts/guard.mjs'],
    });
    const copy = join(root, '.agent', 'local-layer', 'build', 'overrides', 'scripts', 'guard.mjs');
    // Новый командный импорт тоже в копии: замыкание идёт по выбранному тексту.
    expect(existsSync(join(dirname(copy), 'lib2.mjs'))).toBe(true);
    const out = execFileSync(process.execPath, [copy], { encoding: 'utf8' });
    expect(out.trim()).toBe(`${root.replaceAll('\\', '/')} 2`);
  });

  it('файл правили и ветка, и замена — конфликт, замена снята', () => {
    withOverride();
    touch(join(root, 'scripts', 'guard.mjs'), guard('branch'));
    const status = localLayerStatus(root, place);
    expect(status.overrides[0]?.state).toBe('stale');
    expect(status.overrides[0]?.detail).toContain('scripts/guard.mjs');
    expect(status.used).toBe(false);
  });

  it('MR влит — замена отработала и снимается сама', () => {
    const ref = withOverride();
    git('merge', '-q', '--ff-only', ref);
    touch(join(root, 'scripts', 'guard.mjs'), guard('fast'));
    const status = localLayerStatus(root, place);
    expect(status.overrides[0]?.state).toBe('retired');
    expect(status.used).toBe(false);
  });

  it('обращение к своему месту в другой форме — перенос не доказан', () => {
    expect(relocate("import.meta.resolve('./x.mjs')", '/r/scripts/a.mjs').unsafe).toEqual([
      'import.meta.resolve',
    ]);
    expect(relocate("new URL('./d.json', import.meta.url)", '/r/scripts/a.mjs').text).toContain(
      'file:///',
    );
  });
});

describe('правило по путям приходит при первом касании, один раз', () => {
  it('хук отдаёт «Contents of …» и молчит на повторе', () => {
    teamLayer();
    writeLayerMode(root, 'on');
    localLayerRun(root, place);
    const script = fileURLToPath(
      new URL('../../../assets/local-layer/path-rules.mjs', import.meta.url),
    );
    const index = join(root, '.agent', 'local-layer', 'build', 'rules.json');
    const session = `t-${Date.now()}`;
    const fire = (file: string): string =>
      spawnSync(process.execPath, [script, index], {
        input: JSON.stringify({
          session_id: session,
          cwd: root,
          tool_name: 'Read',
          tool_input: { file_path: file },
        }),
        encoding: 'utf8',
      }).stdout;
    expect(fire(join(root, 'README.md'))).toBe('');
    const first = fire(join(root, 'src', 'a', 'b.tsx'));
    expect(first).toContain('RULE_SCOPED');
    expect(first).not.toContain('paths:');
    expect(fire(join(root, 'src', 'c.ts'))).toBe('');
    expect(fire('sub/x.md')).toContain('NESTED_MD');
  });
});

describe('флаги прогона', () => {
  it('источник project снимается, остальное остаётся', () => {
    expect(withoutProjectSource([])).toEqual(['--setting-sources', 'user,local']);
    expect(withoutProjectSource(['--setting-sources', 'project,local'])).toEqual([
      '--setting-sources',
      'local',
    ]);
    // Маршрут уже без project — подменять нечего.
    expect(withoutProjectSource(['--setting-sources', 'local'])).toBeUndefined();
    expect(withoutProjectSource(['--setting-sources', 'project'])).toBeUndefined();
  });

  it('strict-MCP: слой не добавляет .mcp.json', () => {
    expect(withoutMcpConfig(['--plugin-dir', 'p', '--mcp-config', 'm'])).toEqual([
      '--plugin-dir',
      'p',
    ]);
  });

  it('настройки: хуки и права складываются, профиль сверху', () => {
    const merged = mergeFlagSettings(
      { model: 'a', hooks: { Stop: [1] }, permissions: { deny: ['x'] } },
      { model: 'b', hooks: { Stop: [2], Pre: [3] }, permissions: { deny: ['y'] } },
    );
    expect(merged).toEqual({
      model: 'b',
      hooks: { Stop: [1, 2], Pre: [3] },
      permissions: { deny: ['x', 'y'] },
    });
    expect(
      yieldToLocal({ env: { A: '1', B: '2' }, list: [1] }, { env: { A: 'x' }, list: [2] }),
    ).toEqual({
      env: { B: '2' },
      list: [1],
    });
  });
});
