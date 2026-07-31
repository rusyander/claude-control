import { describe, it, expect } from 'vitest';
import { STATUS_LETTER, pullBody, splitPath } from './projectGitView';

describe('splitPath: имя файла не должно обрезаться', () => {
  it('делит по последнему слэшу, каталог остаётся со слэшем', () => {
    expect(splitPath('src/features/ProjectGit/ui/Controls.tsx')).toEqual({
      dir: 'src/features/ProjectGit/ui/',
      name: 'Controls.tsx',
    });
  });

  it('файл в корне репозитория — каталога нет', () => {
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });

  it('пробелы и кириллица в пути не режутся', () => {
    expect(splitPath('док и файлы/мой файл.md')).toEqual({
      dir: 'док и файлы/',
      name: 'мой файл.md',
    });
  });
});

describe('pullBody: пустой выбор — это «текущая ветка», а не пустое имя', () => {
  it('без выбора поле branch не уходит вовсе', () => {
    expect(pullBody('/repo', '')).toEqual({ path: '/repo' });
    expect(pullBody('/repo', '   ')).toEqual({ path: '/repo' });
  });

  it('выбранная ветка уходит как есть', () => {
    expect(pullBody('/repo', 'main')).toEqual({ path: '/repo', branch: 'main' });
  });
});

describe('STATUS_LETTER: буквы совпадают с теми, что печатает git', () => {
  it('каждое состояние имеет ровно один символ', () => {
    expect(Object.values(STATUS_LETTER).every((letter) => letter.length === 1)).toBe(true);
    expect(STATUS_LETTER.untracked).toBe('?');
    expect(STATUS_LETTER.conflict).toBe('U');
  });
});
