import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudePaths } from '@claude-control/contracts';
import {
  buildConfigBundle,
  parseConfigBundle,
  applyConfigBundle,
  BUNDLE_FORMAT_VERSION,
  type ConfigBundle,
} from './config-bundle.ts';

/**
 * Бандл конфигурации: правила + скиллы + хуки одним JSON-файлом. Проверяем
 * главное — round-trip (собрать в одном каталоге, применить в другом, всё
 * восстановилось), безопасность (traversal в путях файлов скилла отвергается)
 * и неразрушающий импорт (повторное применение без флага не перезаписывает
 * существующий скилл и не плодит дубли хуков).
 *
 * Всё во временных каталогах — настоящий ~/.claude не затрагивается.
 */
describe('config-bundle', () => {
  let dir: string;

  const pathsFor = (root: string): ClaudePaths => ({
    root,
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, '.mcp-secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(root, '..', '.claude.json'),
    appData: join(root, 'claude-control'),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-bundle-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Разложить исходную конфигурацию: CLAUDE.md, один скилл с файлами, один хук. */
  const seedSource = (root: string): void => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# Правила\n\n## ПРАВИЛО: Всегда по-русски\n\nТекст.\n');

    const skillDir = join(root, 'skills', 'my-skill');
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: тест\n---\n\nТело.\n',
    );
    writeFileSync(join(skillDir, 'references', 'guide.md'), '# guide\n');
    // Двоичный файл — должен уехать в base64 и вернуться байт-в-байт.
    writeFileSync(join(skillDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Write', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] },
          ],
        },
      }),
    );
  };

  describe('round-trip export → import', () => {
    it('правила, скиллы (в т.ч. двоичные файлы) и хуки восстанавливаются', () => {
      const src = join(dir, 'src');
      const dst = join(dir, 'dst');
      seedSource(src);
      mkdirSync(dst, { recursive: true });

      const bundle = buildConfigBundle(pathsFor(src), '2026-07-23T00:00:00.000Z');

      // Бандл собрал всё как надо.
      expect(bundle.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
      expect(bundle.rules.claudeMd).toContain('ПРАВИЛО: Всегда по-русски');
      expect(bundle.skills).toHaveLength(1);
      expect(bundle.skills[0]?.name).toBe('my-skill');
      const png = bundle.skills[0]?.files.find((f) => f.path === 'logo.png');
      expect(png?.encoding).toBe('base64');
      expect(bundle.hooks).toEqual([
        { event: 'PostToolUse', matcher: 'Write', command: 'echo hi', timeout: 5 },
      ]);

      // Проходит через JSON (как при переносе файлом) и разбирается обратно.
      const reparsed = parseConfigBundle(JSON.parse(JSON.stringify(bundle)));
      const summary = applyConfigBundle(pathsFor(dst), reparsed, { rulesMode: 'replace' });

      expect(summary.skillsCreated).toEqual(['my-skill']);
      expect(summary.hooksAdded).toBe(1);

      // Правила восстановлены.
      expect(readFileSync(join(dst, 'CLAUDE.md'), 'utf8')).toContain('ПРАВИЛО: Всегда по-русски');
      // Файлы скилла на месте, двоичный — байт-в-байт.
      expect(readFileSync(join(dst, 'skills', 'my-skill', 'references', 'guide.md'), 'utf8')).toBe(
        '# guide\n',
      );
      expect(readFileSync(join(dst, 'skills', 'my-skill', 'logo.png'))).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      );
      // Хук записан в settings.json целевого каталога.
      const written = JSON.parse(readFileSync(join(dst, 'settings.json'), 'utf8'));
      expect(written.hooks.PostToolUse[0].hooks[0].command).toBe('echo hi');
    });

    it('режим append дописывает правила, не затирая существующий CLAUDE.md', () => {
      const dst = join(dir, 'dst');
      mkdirSync(dst, { recursive: true });
      writeFileSync(join(dst, 'CLAUDE.md'), '# Мои правила\n\nСтарый текст.\n');

      const bundle: ConfigBundle = {
        formatVersion: 1,
        exportedAt: '2026-07-23',
        rules: { claudeMd: '## ПРАВИЛО: Новое\n\nИз бандла.' },
        skills: [],
        hooks: [],
      };

      applyConfigBundle(pathsFor(dst), bundle, { rulesMode: 'append' });
      const text = readFileSync(join(dst, 'CLAUDE.md'), 'utf8');
      // И старое, и новое присутствуют — ничего не потеряно.
      expect(text).toContain('Старый текст.');
      expect(text).toContain('ПРАВИЛО: Новое');
      expect(text).toContain('Импортировано из бандла');
    });
  });

  describe('безопасность: traversal в путях отвергается', () => {
    it('файл скилла с ../ за пределами папки отклоняет весь импорт до записи', () => {
      const dst = join(dir, 'dst');
      mkdirSync(dst, { recursive: true });

      const evil: ConfigBundle = {
        formatVersion: 1,
        exportedAt: '',
        rules: { claudeMd: '' },
        skills: [
          {
            name: 'evil',
            files: [{ path: '../../pwned.txt', content: 'x', encoding: 'utf8' }],
          },
        ],
        hooks: [],
      };

      expect(() => applyConfigBundle(pathsFor(dst), evil)).toThrow(/за пределы|запрещ/i);
      // Ничего не создано — ни за пределами, ни внутри.
      expect(existsSync(join(dir, 'pwned.txt'))).toBe(false);
      expect(existsSync(join(dst, 'skills', 'evil'))).toBe(false);
    });

    it('абсолютный путь и небезопасное имя скилла тоже отвергаются', () => {
      const dst = join(dir, 'dst');
      mkdirSync(dst, { recursive: true });
      const base = { formatVersion: 1, exportedAt: '', rules: { claudeMd: '' }, hooks: [] };

      const absFile: ConfigBundle = {
        ...base,
        skills: [{ name: 'ok', files: [{ path: '/etc/x', content: 'x', encoding: 'utf8' }] }],
      };
      expect(() => applyConfigBundle(pathsFor(dst), absFile)).toThrow();

      const badName: ConfigBundle = {
        ...base,
        skills: [{ name: '../escape', files: [] }],
      };
      expect(() => applyConfigBundle(pathsFor(dst), badName)).toThrow(/имя скилла/i);
    });
  });

  describe('неразрушающий повторный импорт', () => {
    it('без флага существующий скилл не перезаписывается, а хук не дублируется', () => {
      const src = join(dir, 'src');
      const dst = join(dir, 'dst');
      seedSource(src);
      mkdirSync(dst, { recursive: true });

      const bundle = parseConfigBundle(
        JSON.parse(JSON.stringify(buildConfigBundle(pathsFor(src), 'x'))),
      );

      // Первый импорт — создаёт.
      const first = applyConfigBundle(pathsFor(dst), bundle);
      expect(first.skillsCreated).toEqual(['my-skill']);
      expect(first.hooksAdded).toBe(1);

      // Правим файл скилла в целевом каталоге — «чужие» изменения.
      writeFileSync(join(dst, 'skills', 'my-skill', 'SKILL.md'), 'ЛОКАЛЬНАЯ ПРАВКА');

      // Повтор без флага: скилл пропущен (не затёрт), хук не задвоился.
      const second = applyConfigBundle(pathsFor(dst), bundle);
      expect(second.skillsSkipped).toEqual(['my-skill']);
      expect(second.skillsCreated).toEqual([]);
      expect(second.hooksAdded).toBe(0);
      expect(second.hooksSkipped).toBe(1);

      // Локальная правка цела.
      expect(readFileSync(join(dst, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe(
        'ЛОКАЛЬНАЯ ПРАВКА',
      );
      // Хук в settings.json по-прежнему один.
      const written = JSON.parse(readFileSync(join(dst, 'settings.json'), 'utf8'));
      expect(written.hooks.PostToolUse[0].hooks).toHaveLength(1);
    });

    it('с флагом overwriteSkills существующий скилл перезаписывается', () => {
      const src = join(dir, 'src');
      const dst = join(dir, 'dst');
      seedSource(src);
      mkdirSync(dst, { recursive: true });
      const bundle = parseConfigBundle(
        JSON.parse(JSON.stringify(buildConfigBundle(pathsFor(src), 'x'))),
      );

      applyConfigBundle(pathsFor(dst), bundle);
      writeFileSync(join(dst, 'skills', 'my-skill', 'SKILL.md'), 'ПРАВКА');

      const again = applyConfigBundle(pathsFor(dst), bundle, { overwriteSkills: true });
      expect(again.skillsCreated).toEqual(['my-skill']);
      // Содержимое вернулось к бандловому.
      expect(readFileSync(join(dst, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain(
        'name: my-skill',
      );
    });
  });

  describe('parseConfigBundle — проверка структуры', () => {
    it('отвергает не-объект и версию новее поддерживаемой', () => {
      expect(() => parseConfigBundle(null)).toThrow();
      expect(() => parseConfigBundle([])).toThrow();
      expect(() =>
        parseConfigBundle({
          formatVersion: BUNDLE_FORMAT_VERSION + 1,
          rules: { claudeMd: '' },
          skills: [],
          hooks: [],
        }),
      ).toThrow(/версия формата/i);
    });

    it('отвергает хук без command и скилл без имени', () => {
      const base = { formatVersion: 1, rules: { claudeMd: '' }, skills: [], hooks: [] };
      expect(() => parseConfigBundle({ ...base, hooks: [{ event: 'Stop' }] })).toThrow(/command/i);
      expect(() => parseConfigBundle({ ...base, skills: [{ files: [] }] })).toThrow(/имя/i);
    });
  });
});
