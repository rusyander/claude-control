import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEGACY_BRAND_NAME,
  LEGACY_BRAND_PASCAL,
  LEGACY_BRAND_SLUG,
  MIGRATION_MARKER,
  brandEnv,
  legacyEnvName,
  migrateDir,
  panelHomeFile,
  resolveBrandDir,
} from './brand.mjs';
import * as ContractsBrand from '@agentdeck/contracts/brand';

/**
 * Прежнее имя в тесте записано ИНАЧЕ, чем в `brand.mjs` (задом наперёд, а не из
 * частей): история репозитория переписывается заменой слова, литерала в дереве
 * нет, а тест обязан поймать ошибку в сборке имени, а не повторить её.
 */
const OLD_SLUG = [...'lortnoc-edualc'].reverse().join('');
const OLD_ENV = `${OLD_SLUG.replace('-', '_').toUpperCase()}_`;

describe('прежнее имя', () => {
  it('собирается ровно в то слово, под которым панель писала данные', () => {
    expect(LEGACY_BRAND_SLUG).toBe(OLD_SLUG);
    expect(LEGACY_BRAND_NAME).toBe([...'lortnoC edualC'].reverse().join(''));
    expect(LEGACY_BRAND_PASCAL).toBe([...'lortnoCedualC'].reverse().join(''));
    expect(legacyEnvName('URL')).toBe(`${OLD_ENV}URL`);
  });

  it('метки блоков ответа модели под прежним именем по-прежнему узнаются (contracts)', () => {
    expect(ContractsBrand.LEGACY_BRAND_SLUG).toBe(OLD_SLUG);
    expect(ContractsBrand.LEGACY_BRAND_NAME).toBe(LEGACY_BRAND_NAME);
    expect(ContractsBrand.isBlockLang(`${OLD_SLUG}:split`, 'split')).toBe(true);
    expect(new RegExp(ContractsBrand.blockLangPattern('plan')).test(`${OLD_SLUG}:plan`)).toBe(true);
  });
});

/**
 * Переезд со старого имени продукта — на настоящей файловой системе во временном
 * каталоге: смысл функции целиком в том, что остаётся на диске.
 */

describe('переменные панели', () => {
  it('новое имя главнее прежнего, прежнее — запасное, пустое — как отсутствие', () => {
    const old = `${OLD_ENV}URL`;
    expect(brandEnv('URL', { AGENTDECK_URL: 'new', [old]: 'old' })).toBe('new');
    expect(brandEnv('URL', { [old]: 'old' })).toBe('old');
    expect(brandEnv('URL', { AGENTDECK_URL: '  ', [old]: 'old' })).toBe('old');
    expect(brandEnv('URL', {})).toBeUndefined();
  });
});

describe('переезд каталога', () => {
  let root: string;
  let legacy: string;
  let fresh: string;
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'brand-'));
    legacy = join(root, OLD_SLUG);
    fresh = join(root, 'agentdeck');
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seedLegacy = () => {
    mkdirSync(join(legacy, 'backups', 'скилл копия'), { recursive: true });
    writeFileSync(join(legacy, 'state.json'), '{"a":1}');
    writeFileSync(join(legacy, 'backups', 'скилл копия', 'SKILL.md'), 'текст');
  };

  it('копирует всё дерево, прежний каталог оставляет с пометкой', () => {
    seedLegacy();
    expect(migrateDir(legacy, fresh, log)).toBe('migrated');
    expect(readFileSync(join(fresh, 'state.json'), 'utf8')).toBe('{"a":1}');
    expect(readFileSync(join(fresh, 'backups', 'скилл копия', 'SKILL.md'), 'utf8')).toBe('текст');
    expect(readFileSync(join(legacy, 'state.json'), 'utf8')).toBe('{"a":1}');
    expect(existsSync(join(legacy, MIGRATION_MARKER))).toBe(true);
    expect(existsSync(join(fresh, MIGRATION_MARKER))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['agentdeck', OLD_SLUG]);
    expect(logs).toHaveLength(1);
  });

  it('новый каталог не пуст — он главнее, ничего не сливается', () => {
    seedLegacy();
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'state.json'), '{"b":2}');
    expect(migrateDir(legacy, fresh, log)).toBe('kept');
    expect(readFileSync(join(fresh, 'state.json'), 'utf8')).toBe('{"b":2}');
    expect(existsSync(join(fresh, 'backups'))).toBe(false);
    expect(existsSync(join(legacy, MIGRATION_MARKER))).toBe(false);
  });

  it('пустой новый каталог (создан кем-то раньше) не мешает переезду', () => {
    seedLegacy();
    mkdirSync(fresh);
    expect(migrateDir(legacy, fresh, log)).toBe('migrated');
    expect(existsSync(join(fresh, 'state.json'))).toBe(true);
  });

  it('прежнего нет — переносить нечего', () => {
    expect(migrateDir(legacy, fresh, log)).toBe('none');
    expect(existsSync(fresh)).toBe(false);
  });

  it('повторный запуск ничего не переносит заново', () => {
    seedLegacy();
    migrateDir(legacy, fresh, log);
    const marker = statSync(join(legacy, MIGRATION_MARKER)).mtimeMs;
    writeFileSync(join(legacy, 'later.txt'), 'x');
    expect(migrateDir(legacy, fresh, log)).toBe('kept');
    expect(existsSync(join(fresh, 'later.txt'))).toBe(false);
    expect(statSync(join(legacy, MIGRATION_MARKER)).mtimeMs).toBe(marker);
  });

  it('брошенная полукопия прошлого процесса убирается, свежая чужая — нет', () => {
    seedLegacy();
    const stale = join(root, 'agentdeck.migrating-1-1');
    const busy = join(root, 'agentdeck.migrating-2-2');
    mkdirSync(stale);
    writeFileSync(join(stale, 'half.txt'), 'x');
    mkdirSync(busy);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, old, old);
    expect(migrateDir(legacy, fresh, log)).toBe('migrated');
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(busy)).toBe(true);
  });

  it('копия не удалась — работаем с прежним каталогом и говорим об этом', () => {
    seedLegacy();
    // Родитель нового каталога — файл: ни копия, ни переименование невозможны.
    const blocker = join(root, 'file');
    writeFileSync(blocker, '');
    const target = join(blocker, 'agentdeck');
    expect(resolveBrandDir(legacy, target, log)).toBe(legacy);
    expect(logs.join('\n')).toContain('не удалось перенести');
    expect(existsSync(join(legacy, MIGRATION_MARKER))).toBe(false);
  });

  it('решение запоминается в процессе: второй вызов не трогает диск', () => {
    seedLegacy();
    expect(resolveBrandDir(legacy, fresh, log)).toBe(fresh);
    rmSync(fresh, { recursive: true, force: true });
    expect(resolveBrandDir(legacy, fresh, log)).toBe(fresh);
    expect(existsSync(fresh)).toBe(false);
  });

  it('файл домашнего каталога ищется под новым именем, затем под прежним', () => {
    const home = root;
    expect(panelHomeFile('api-token', home)).toBe(join(home, '.agentdeck', 'api-token'));
    mkdirSync(join(home, `.${OLD_SLUG}`));
    writeFileSync(join(home, `.${OLD_SLUG}`, 'api-token'), 'x');
    expect(panelHomeFile('api-token', home)).toBe(join(home, `.${OLD_SLUG}`, 'api-token'));
    mkdirSync(join(home, '.agentdeck'));
    writeFileSync(join(home, '.agentdeck', 'api-token'), 'y');
    expect(panelHomeFile('api-token', home)).toBe(join(home, '.agentdeck', 'api-token'));
  });
});
