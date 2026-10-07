import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProvider } from '../registry.ts';
import {
  CONTINUE_EDIT_TOOLS,
  continueConfigArgs,
  continueEditArgs,
  continueOneShotArgs,
} from './continue-args.ts';

const HOME = join('/h', '.continue');
const FILE = join(HOME, 'config.yaml');
const present = { home: HOME, env: {}, exists: (path: string) => path === FILE };
const absent = { home: HOME, env: {}, exists: () => false };

describe('continue-args: права под «Разрешить правки»', () => {
  it('выключено — все четыре инструмента правки исключены, оболочка тоже', () => {
    expect(continueEditArgs(false)).toEqual([
      '--exclude',
      'Write',
      '--exclude',
      'Edit',
      '--exclude',
      'MultiEdit',
      '--exclude',
      'Bash',
    ]);
  });

  it('включено — те же четыре разрешены, без `--auto`', () => {
    const args = continueEditArgs(true);
    expect(args).toEqual(CONTINUE_EDIT_TOOLS.flatMap((tool) => ['--allow', tool]));
    expect(args).not.toContain('--auto');
    expect(args).not.toContain('--readonly');
  });

  it('не задано (окно ассистента) — argv как до переключателя', () => {
    expect(continueEditArgs(undefined)).toEqual([]);
  });
});

describe('continue-args: --config на свой файл человека', () => {
  it('файл есть — `--config <файл>`', () => {
    expect(continueConfigArgs(present)).toEqual(['--config', FILE]);
  });

  it('файла нет — флага нет (вход в Continue Hub не ломаем)', () => {
    expect(continueConfigArgs(absent)).toEqual([]);
  });

  it('CONTINUE_GLOBAL_DIR задан — флага нет: чей файл прочтёт cn, панель не знает', () => {
    expect(continueConfigArgs({ ...present, env: { CONTINUE_GLOBAL_DIR: '/other' } })).toEqual([]);
  });
});

describe('continue-args: argv целиком', () => {
  it('опции до `-p`, промпт — последним отдельным элементом', () => {
    const prompt = '--exclude Bash; rm -rf /';
    const args = continueOneShotArgs(prompt, { allowEdits: false }, present);
    expect(args.slice(-2)).toEqual(['-p', prompt]);
    expect(args.slice(0, 2)).toEqual(['--config', FILE]);
    expect(args.filter((arg) => arg === '--exclude')).toHaveLength(4);
  });

  it('без файла и без переключателя — ровно прежний `-p <промпт>`', () => {
    expect(continueOneShotArgs('hi', undefined, absent)).toEqual(['-p', 'hi']);
  });

  it('каталог подключён к этим argv (переключатель меняет запуск)', () => {
    const oneShot = getProvider('continue').assistant?.oneShotArgs;
    expect(oneShot?.('x', { allowEdits: false })).toEqual(
      expect.arrayContaining(['--exclude', 'Bash']),
    );
    expect(oneShot?.('x', { allowEdits: true })).toEqual(
      expect.arrayContaining(['--allow', 'Write']),
    );
    expect(getProvider('continue').assistant?.editsControl).toBe('flag');
  });
});
