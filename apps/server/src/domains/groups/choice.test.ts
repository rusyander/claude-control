import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { projectKey } from '../../lib/app-store/group-sources.ts';
import { pickableGroups } from '../chat/group-auto-pick.ts';
import { effectiveChoice, pairsIn, readChoice, writeChoice } from './choice.ts';

/**
 * Выбор стороны пары — у КАЖДОЙ пары свой (F-113). Один слот на проект значил:
 * глобальная сторона второй пары молча возвращала первую к проектной, и каталог
 * разбора шёл за ней. Файл данных панели — настоящий, во временном каталоге.
 */

const proj = join(tmpdir(), 'cc-choice-proj');
const origin = (groupId: string): Group['origin'] => ({
  scope: { kind: 'project', path: proj, provider: 'claude' },
  groupId,
  hash: 'h',
  copiedAt: '2026-09-28T00:00:00.000Z',
});
const group = (id: string, patch: Partial<Group>): Group => ({
  id,
  name: id,
  description: '',
  color: 'accent',
  icon: 'folder',
  members: [],
  env: {},
  projectPaths: [],
  isEnabled: true,
  order: 0,
  ...patch,
});
const groups: Group[] = [
  group('pa', { scope: { kind: 'project', path: proj, provider: 'claude' } }),
  group('pb', { scope: { kind: 'project', path: proj, provider: 'claude' } }),
  group('ga', { origin: origin('pa') }),
  group('gb', { origin: origin('pb') }),
];

describe('выбор стороны пары — по паре, не по проекту', () => {
  let appData: string;
  const effective = (): Record<string, string> =>
    Object.fromEntries(
      pairsIn(groups, proj).map((pair) => [
        pair.project.id,
        effectiveChoice(readChoice(appData, proj), pair),
      ]),
    );
  const stored = (): unknown =>
    (
      JSON.parse(readFileSync(join(appData, 'group-sources.json'), 'utf8')) as {
        choices: Record<string, unknown>;
      }
    ).choices[projectKey(proj)];

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-choice-'));
  });
  afterEach(() => rmSync(appData, { recursive: true, force: true }));

  it('глобальная сторона второй пары не возвращает первую к проектной', () => {
    writeChoice(appData, groups, proj, 'global:ga');
    writeChoice(appData, groups, proj, 'global:gb');
    expect(effective()).toEqual({ pa: 'global:ga', pb: 'global:gb' });
    const catalog = pickableGroups(groups, proj, readChoice(appData, proj)).map((e) => e.key);
    expect(catalog).toEqual(['global:ga', 'global:gb']);
  });

  it('проектная сторона одной пары не трогает глобальную другой', () => {
    writeChoice(appData, groups, proj, 'global:ga');
    writeChoice(appData, groups, proj, 'global:gb');
    writeChoice(appData, groups, proj, 'project:pb');
    expect(effective()).toEqual({ pa: 'global:ga', pb: 'project:pb' });
    expect(stored()).toEqual({ pa: 'global:ga', pb: 'project:pb' });
  });

  it('запись v1 (один слот на проект) читается как выбор своей пары и переписывается по парам', () => {
    mkdirSync(appData, { recursive: true });
    writeFileSync(
      join(appData, 'group-sources.json'),
      JSON.stringify({ version: 1, choices: { [projectKey(proj)]: 'global:ga' } }),
      'utf8',
    );
    expect(effective()).toEqual({ pa: 'global:ga', pb: 'project:pb' });
    writeChoice(appData, groups, proj, 'global:gb');
    expect(stored()).toEqual({ pa: 'global:ga', pb: 'global:gb' });
  });

  it('null снимает выбор всех пар проекта', () => {
    writeChoice(appData, groups, proj, 'global:ga');
    writeChoice(appData, groups, proj, 'global:gb');
    writeChoice(appData, groups, proj, null);
    expect(effective()).toEqual({ pa: 'project:pa', pb: 'project:pb' });
    expect(stored()).toBeUndefined();
  });

  it('ключ группы, которая не сторона пары этого проекта, — отказ', () => {
    const other = [...groups, group('lone', {})];
    expect(() => writeChoice(appData, other, proj, 'global:lone')).toThrow();
  });
});
