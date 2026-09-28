import { describe, expect, it } from 'vitest';
import type { PathEntry, PathStep } from '@agentdeck/contracts';
import { inProject } from './describe';
import { entrySource, sourceFile, type SourcePaths } from './stepSource';

const PATHS: SourcePaths = {
  skills: 'C:/Users/me/.claude/skills',
  settings: 'C:/Users/me/.claude/settings.json',
  claudeMd: 'C:/Users/me/.claude/CLAUDE.md',
  appData: 'C:/Users/me/.claude/agentdeck',
  hooks: 'C:/Users/me/.claude/hooks',
};

const PROJECT = { kind: 'project' as const, path: 'C:/work/site', provider: 'claude' };

const resourceEntry = (type: 'rule' | 'hook' | 'script', id: string): PathEntry => ({
  kind: 'custom',
  step: {
    id: 's',
    anchor: 'review',
    order: 0,
    kind: 'resource',
    title: { ru: 't', en: 't' },
    prompt: { ru: '', en: '' },
    source: 'ru',
    resource: { type, id },
    createdAt: '',
  } satisfies PathStep,
});

const fileFor = (
  type: 'rule' | 'hook' | 'script',
  id: string,
  scope?: typeof PROJECT | { kind: 'project'; path: string; provider: string },
): string | undefined =>
  sourceFile(
    entrySource(resourceEntry(type, id), {
      group: { scope, members: [] },
      ourSkills: new Set(),
    }),
    PATHS,
    'C:/Users/me/.claude/hooks/global-script.mjs',
  );

describe('файл ресурса шага: область группы (F-77)', () => {
  it('проектная группа — правило, хук и скрипт в .claude проекта', () => {
    expect(fileFor('rule', 'docs-style', PROJECT)).toBe('C:/work/site/.claude/rules/docs-style.md');
    expect(fileFor('hook', 'Stop:docs', PROJECT)).toBe('C:/work/site/.claude/settings.json');
    expect(fileFor('script', 'lint.mjs', PROJECT)).toBe('C:/work/site/.claude/hooks/lint.mjs');
  });

  it('глобальная группа — общие CLAUDE.md, скрипт хука и каталог скриптов', () => {
    expect(fileFor('rule', 'docs-style')).toBe(PATHS.claudeMd);
    expect(fileFor('hook', 'Stop:docs')).toBe('C:/Users/me/.claude/hooks/global-script.mjs');
    expect(fileFor('script', 'lint.mjs')).toBe('C:/Users/me/.claude/hooks/lint.mjs');
  });

  it('проект другой CLI — пути нет, а не выдуманный общий', () => {
    const codex = { kind: 'project' as const, path: 'C:/work/site', provider: 'codex' };
    expect(fileFor('rule', 'docs-style', codex)).toBeUndefined();
    expect(fileFor('hook', 'Stop:docs', codex)).toBeUndefined();
  });
});

describe('сводка ресурса проекта спрашивается в проекте (F-76)', () => {
  it('у сводки появляется проект, у текста — нет', () => {
    const summary = { kind: 'summary' as const, type: 'rule' as const, id: 'docs-style' };
    expect(inProject(summary, 'C:/work/site')).toEqual({ ...summary, project: 'C:/work/site' });
    expect(inProject(summary, undefined)).toEqual(summary);
    expect(inProject({ kind: 'text', text: 'x' }, 'C:/work/site')).toEqual({
      kind: 'text',
      text: 'x',
    });
  });
});
