import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../../providers/registry.ts';
import { readZip } from '../../lib/zip.ts';
import { buildEnvironmentArchive, parseEnvironmentArchive } from './archive.ts';
import { collectProviderFiles } from './collect.ts';
import { applyEnvironmentImport, planEnvironmentImport } from './import.ts';

/**
 * Перенос окружения: что уезжает в архив, чего в нём быть НЕ должно и как он
 * разворачивается обратно.
 *
 * Главные инварианты, которые тут закреплены:
 *   - секреты не переносятся ни файлом, ни значением ключа — вместо них
 *     чек-лист с одними именами;
 *   - история и кэши не переносятся: архив это настройка, а не хвост работы;
 *   - импорт СНАЧАЛА показывает план и пишет только отмеченное, каждую
 *     перезапись кладя в резервную копию;
 *   - архив одного провайдера не разворачивается в другого, а путь из чужой
 *     описи не может увести запись за пределы конфигурации.
 *
 * Провайдер берётся настоящий (Kimi и Claude), пути уводятся во временный
 * каталог переменной окружения — так проверяется ровно та раскладка, что
 * объявлена в каталоге провайдеров.
 */
describe('Перенос окружения: экспорт', () => {
  let home: string;
  const stamp = '2026-07-25T10:00:00.000Z';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-env-kimi-'));
    process.env.KIMI_CODE_HOME = home;
  });
  afterEach(() => {
    delete process.env.KIMI_CODE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('собирает конфигурацию провайдера, а секретные значения заменяет меткой', () => {
    writeFileSync(
      join(home, 'config.toml'),
      [
        '# конфигурация',
        'model = "kimi-k2"',
        'default_permission_mode = "auto"',
        '',
        '[providers.moonshot]',
        'api_key = "sk-РЕАЛЬНЫЙ-КЛЮЧ"',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(home, 'mcp.json'),
      JSON.stringify({ mcpServers: { github: { url: 'https://x', headers: { token: 'ghp_x' } } } }),
      'utf8',
    );
    writeFileSync(join(home, 'AGENTS.md'), '# мои правила\n', 'utf8');

    const built = buildEnvironmentArchive(getProvider('kimi'), stamp, undefined);
    const files = new Map(readZip(built.zip).map((entry) => [entry.path, entry.data.toString()]));

    expect([...files.keys()].sort()).toEqual([
      'MANIFEST.json',
      'README.md',
      'files/loc-0/AGENTS.md',
      'files/loc-0/config.toml',
      'files/loc-0/mcp.json',
    ]);

    // Ключ провайдера и заголовок MCP не уехали, а комментарий и прочие ключи целы.
    const toml = files.get('files/loc-0/config.toml')!;
    expect(toml).not.toContain('sk-РЕАЛЬНЫЙ-КЛЮЧ');
    expect(toml).toContain('__REDACTED__');
    expect(toml).toContain('# конфигурация');
    expect(toml).toContain('model = "kimi-k2"');
    expect(files.get('files/loc-0/mcp.json')).not.toContain('ghp_x');

    // Заменённые ключи названы в чек-листе — пользователь знает, что вводить.
    const checklist = built.manifest.checklist.flatMap((item) => item.keys);
    expect(checklist).toContain('providers.moonshot.api_key');
    expect(built.manifest.provider.id).toBe('kimi');
  });

  it('файл переменных окружения не переносится, а его ключи попадают в чек-лист', () => {
    const qwenHome = mkdtempSync(join(tmpdir(), 'cc-env-qwen-'));
    process.env.QWEN_HOME = qwenHome;
    try {
      writeFileSync(join(qwenHome, 'settings.json'), '{"theme":"dark"}', 'utf8');
      writeFileSync(
        join(qwenHome, '.env'),
        'OPENAI_API_KEY=секрет\nexport PROXY=http://x\n',
        'utf8',
      );

      const collected = collectProviderFiles(getProvider('qwen'));

      expect(collected.files.map((file) => file.relative)).toEqual(['settings.json']);
      const envItem = collected.checklist.find((item) => item.reason === 'env-file');
      expect(envItem?.keys).toEqual(['OPENAI_API_KEY', 'PROXY']);
    } finally {
      delete process.env.QWEN_HOME;
      rmSync(qwenHome, { recursive: true, force: true });
    }
  });

  it('пустая конфигурация даёт архив из одной описи и README, а не ошибку', () => {
    const built = buildEnvironmentArchive(getProvider('kimi'), stamp, undefined);
    expect(built.manifest.entries).toEqual([]);
    expect(readZip(built.zip).map((entry) => entry.path)).toEqual(['MANIFEST.json', 'README.md']);
  });
});

describe('Перенос окружения: что не уезжает у Claude', () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    // Раскладка как в жизни: `~/.claude` с конфигурацией и `~/.claude.json`
    // рядом с ним — второй файл лежит ВНЕ каталога и переносится отдельно.
    home = mkdtempSync(join(tmpdir(), 'cc-env-home-'));
    root = join(home, '.claude');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# правила\n', 'utf8');
    writeFileSync(join(root, 'settings.json'), '{"model":"opus"}', 'utf8');
    writeFileSync(join(root, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}', 'utf8');
    writeFileSync(join(root, '.mcp-secrets.env'), 'TOKEN=x\n', 'utf8');

    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# skill\n', 'utf8');

    // История диалогов и данные панели — не настройка, их переносить нельзя.
    mkdirSync(join(root, 'projects', 'c--work'), { recursive: true });
    writeFileSync(join(root, 'projects', 'c--work', 'session.jsonl'), '{"a":1}\n', 'utf8');
    mkdirSync(join(root, 'claude-control', 'backups'), { recursive: true });
    writeFileSync(join(root, 'claude-control', 'state.json'), '{"groups":[]}', 'utf8');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('правила и скиллы едут, доступ, секреты, история и данные панели — нет', () => {
    const collected = collectProviderFiles(getProvider('claude'), root);
    const packed = collected.files.map((file) => file.relative).sort();

    expect(packed).toContain('CLAUDE.md');
    expect(packed).toContain('settings.json');
    expect(packed).toContain('skills/demo/SKILL.md');
    expect(packed.some((path) => path.includes('credentials'))).toBe(false);
    expect(packed.some((path) => path.includes('mcp-secrets'))).toBe(false);
    expect(packed.some((path) => path.startsWith('projects/'))).toBe(false);
    expect(packed.some((path) => path.startsWith('claude-control/'))).toBe(false);

    // Пропущенное названо явно: пользователь видит, чего в архиве нет.
    const reasons = new Set(collected.skipped.map((item) => item.reason));
    expect(reasons.has('secret')).toBe(true);
    expect(reasons.has('excluded')).toBe(true);
  });

  it('из ~/.claude.json берутся только MCP-серверы, история и аккаунт остаются дома', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { local: { command: 'node' } },
        projects: { 'c--work': { history: ['мой приватный запрос'] } },
        oauthAccount: { emailAddress: 'user@example.com' },
      }),
      'utf8',
    );

    const built = buildEnvironmentArchive(getProvider('claude'), '2026-07-25T10:00:00.000Z', root);

    const entry = built.manifest.entries.find((item) => item.relative === '.claude.json');
    expect(entry?.applyMode).toBe('json-merge');
    expect(entry?.mergeKeys).toEqual(['mcpServers']);

    const packed = readZip(built.zip).find((item) => item.path === entry!.archivePath)!;
    const payload = JSON.parse(packed.data.toString()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['mcpServers']);
    expect(packed.data.toString()).not.toContain('мой приватный запрос');
    expect(packed.data.toString()).not.toContain('user@example.com');
  });

  it('вливание MCP не трогает остальные ключи целевого ~/.claude.json', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { local: { command: 'node' } } }),
      'utf8',
    );
    const zip = buildEnvironmentArchive(
      getProvider('claude'),
      '2026-07-25T10:00:00.000Z',
      root,
    ).zip;

    // На «новой машине» в файле свои проекты и свой сервер.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { other: { command: 'python' } },
        projects: { 'd--other': { history: ['чужой запрос'] } },
      }),
      'utf8',
    );

    const parsed = parseEnvironmentArchive(zip);
    const entry = parsed.manifest.entries.find((item) => item.relative === '.claude.json')!;
    applyEnvironmentImport(parsed, getProvider('claude'), {
      selection: [entry.archivePath],
      override: root,
      backupDir: join(home, 'backups'),
    });

    const result = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result.mcpServers).toEqual({ local: { command: 'node' } });
    expect(result.projects).toEqual({ 'd--other': { history: ['чужой запрос'] } });
  });
});

describe('Перенос окружения: импорт', () => {
  let source: string;
  let target: string;
  let backupDir: string;
  const stamp = '2026-07-25T10:00:00.000Z';

  /** Собирает архив из каталога `source` и готовит его к развороту в `target`. */
  const archiveFromSource = (): Buffer => {
    process.env.KIMI_CODE_HOME = source;
    try {
      return buildEnvironmentArchive(getProvider('kimi'), stamp, undefined).zip;
    } finally {
      process.env.KIMI_CODE_HOME = target;
    }
  };

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), 'cc-env-src-'));
    target = mkdtempSync(join(tmpdir(), 'cc-env-dst-'));
    backupDir = join(target, 'backups');
    process.env.KIMI_CODE_HOME = target;

    writeFileSync(join(source, 'AGENTS.md'), '# правила источника\n', 'utf8');
    writeFileSync(join(source, 'config.toml'), 'default_permission_mode = "auto"\n', 'utf8');
  });
  afterEach(() => {
    delete process.env.KIMI_CODE_HOME;
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it('план различает новое, совпадающее и отличающееся', () => {
    // На целевой машине один файл такой же, другой изменён, третьего нет.
    writeFileSync(join(target, 'config.toml'), 'default_permission_mode = "auto"\n', 'utf8');
    writeFileSync(join(target, 'AGENTS.md'), '# СВОИ правила\n', 'utf8');
    writeFileSync(join(source, 'mcp.json'), '{"mcpServers":{}}', 'utf8');

    const plan = planEnvironmentImport(
      parseEnvironmentArchive(archiveFromSource()),
      getProvider('kimi'),
    );
    const byName = new Map(plan.entries.map((entry) => [entry.relative, entry.status]));

    expect(byName.get('config.toml')).toBe('same');
    expect(byName.get('AGENTS.md')).toBe('differs');
    expect(byName.get('mcp.json')).toBe('new');
    expect(plan.counts).toEqual({ new: 1, same: 1, differs: 1, unresolved: 0 });
    // Пути пересчитаны под ЭТУ машину, а не взяты из архива.
    expect(plan.entries[0]!.targetPath?.startsWith(target)).toBe(true);
  });

  it('пишет только отмеченное и кладёт перезаписанное в резервную копию', () => {
    writeFileSync(join(target, 'AGENTS.md'), '# СВОИ правила\n', 'utf8');
    const parsed = parseEnvironmentArchive(archiveFromSource());

    const summary = applyEnvironmentImport(parsed, getProvider('kimi'), {
      selection: ['files/loc-0/AGENTS.md'],
      backupDir,
    });

    expect(readFileSync(join(target, 'AGENTS.md'), 'utf8')).toBe('# правила источника\n');
    // config.toml не отмечали — его на целевой машине как не было, так и нет.
    expect(existsSync(join(target, 'config.toml'))).toBe(false);
    expect(summary.written).toHaveLength(1);
    expect(summary.backupPaths).toHaveLength(1);
    expect(readFileSync(summary.backupPaths[0]!, 'utf8')).toBe('# СВОИ правила\n');
  });

  it('архив другого провайдера развернуть нельзя', () => {
    const parsed = parseEnvironmentArchive(archiveFromSource());
    expect(() => planEnvironmentImport(parsed, getProvider('codex'))).toThrow(/собран для/);
  });

  it('путь из чужой описи не выводит запись за пределы конфигурации', () => {
    const parsed = parseEnvironmentArchive(archiveFromSource());
    parsed.manifest.entries[0]!.relative = '../../захват.txt';

    const plan = planEnvironmentImport(parsed, getProvider('kimi'));
    expect(plan.entries[0]!.status).toBe('unresolved');
    expect(plan.entries[0]!.problem).toMatch(/за пределы/);

    expect(() =>
      applyEnvironmentImport(parsed, getProvider('kimi'), {
        selection: [parsed.manifest.entries[0]!.archivePath],
        backupDir,
      }),
    ).toThrow(/некуда положить/);
    expect(existsSync(join(target, '..', 'захват.txt'))).toBe(false);
  });

  it('место, которого нет на этой машине, оставляет запись нерешённой', () => {
    const parsed = parseEnvironmentArchive(archiveFromSource());
    parsed.manifest.entries[0]!.locationIndex = 7;

    const plan = planEnvironmentImport(parsed, getProvider('kimi'));
    expect(plan.entries[0]!.status).toBe('unresolved');
    expect(plan.entries[0]!.problem).toMatch(/места №7/);
  });

  it('подсунутый zip без описи отвергается', () => {
    expect(() => parseEnvironmentArchive(Buffer.from('не архив'))).toThrow();
  });
});
