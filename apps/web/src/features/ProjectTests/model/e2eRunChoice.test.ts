import { describe, expect, it } from 'vitest';
import type { ProjectTestE2eFolder } from '@agentdeck/contracts';
import { e2eRunChoice } from './e2eRunChoice';

const folder = (patch: Partial<ProjectTestE2eFolder> = {}): ProjectTestE2eFolder => ({
  state: 'found',
  dir: 'e2e',
  framework: 'playwright',
  specs: 3,
  excluded: false,
  git: true,
  ...patch,
});
const automation = { command: 'node tools/run.mjs {files}' };

describe('e2eRunChoice — тот же выбор, что у сервера (e2e-run.ts plan)', () => {
  it('папка с тестами и каркасом — её командой, даже если своя команда есть', () => {
    expect(e2eRunChoice({ folder: folder(), automation })).toBe('folder');
    expect(e2eRunChoice({ folder: folder(), automation, files: ['e2e/a.spec.ts'] })).toBe('folder');
  });

  it('файлы группы вне папки e2e — своей командой проекта (F-324)', () => {
    // Сервер: inFolder=false и automation есть → automation.json; клиент раньше
    // считал выбор только по папке и не показывал строку «своя команда».
    expect(
      e2eRunChoice({ folder: folder(), automation, files: ['e2e/a.spec.ts', 'tools/qa/b.mjs'] }),
    ).toBe('own');
  });

  it('файлы вне папки, а своей команды нет — всё равно папкой, как у сервера', () => {
    expect(e2eRunChoice({ folder: folder(), files: ['tools/qa/b.mjs'] })).toBe('folder');
  });

  it('без каркаса или без папки — своя команда, если есть; иначе нечем', () => {
    expect(e2eRunChoice({ folder: folder({ framework: 'unknown' }), automation })).toBe('own');
    expect(e2eRunChoice({ folder: folder({ state: 'missing', dir: undefined }), automation })).toBe(
      'own',
    );
    expect(e2eRunChoice({ folder: folder({ framework: 'unknown' }) })).toBe('none');
    expect(e2eRunChoice({ folder: folder({ state: 'missing', dir: undefined }) })).toBe('none');
  });

  it('пустая папка: со своей командой — она, без неё — команда папки', () => {
    expect(e2eRunChoice({ folder: folder({ specs: 0 }), automation })).toBe('own');
    expect(e2eRunChoice({ folder: folder({ specs: 0 }) })).toBe('folder');
  });

  it('префикс папки сравнивается с косой: e2e-extra/ не лежит в e2e/', () => {
    expect(e2eRunChoice({ folder: folder(), automation, files: ['e2e-extra/a.spec.ts'] })).toBe(
      'own',
    );
    expect(
      e2eRunChoice({ folder: folder({ dir: 'e2e/' }), automation, files: ['e2e/a.spec.ts'] }),
    ).toBe('folder');
  });
});
