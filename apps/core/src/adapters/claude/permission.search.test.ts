import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeDir } from '../../platform/os-kind.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { mapClaudePermission } from './permission.ts';

/**
 * Цель поиска Claude Code — КОРЕНЬ поиска, а не регулярное выражение (как `searchTarget` Qwen,
 * F-13): Grep ищет в `path` (без него — в cwd) по маске `glob`; Glob — маска `pattern` от `path`.
 * Судья видит то место, которое CLI прочтёт.
 */

const HOME = homeDir();
const CORE_HOME = join(HOME, '.agentdeck-core-claude-test');
const COPY = join(HOME, 'work', 'copy');

const ctx = (copyRoot: string): PermitContext => ({
  copyRoot,
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [CORE_HOME],
  endpointSources: [],
  grantRequired: [],
  grants: [],
});

const target = (tool: string, input: Record<string, unknown>) =>
  mapClaudePermission({ tool, input }).target;
const judge = (tool: string, input: Record<string, unknown>, copyRoot = COPY) =>
  decidePermit(mapClaudePermission({ tool, input }), ctx(copyRoot)).allow;

describe('claude adapter — search tools hand the judge the search root', () => {
  it('Grep: the regex is never the target; path (or cwd) joined with the glob mask is', () => {
    expect(target('Grep', { pattern: 'token' })).toBe('.');
    expect(target('Grep', { pattern: 'token', path: '/srv/x' })).toBe('/srv/x');
    expect(target('Grep', { pattern: 'token', path: 'src', glob: '*.ts' })).toBe(
      join('src', '*.ts'),
    );
    expect(target('Grep', { pattern: 'token', glob: '../../**' })).toBe(join('.', '../../**'));
    const abs = join(CORE_HOME, '**');
    expect(target('Grep', { pattern: 'token', path: 'src', glob: abs })).toBe(abs);
  });

  it('Glob: the pattern is the mask from path, not dropped when path is given', () => {
    expect(target('Glob', { pattern: '**/*.ts' })).toBe(join('.', '**/*.ts'));
    expect(target('Glob', { pattern: '**/*.ts', path: 'src' })).toBe(join('src', '**/*.ts'));
    const abs = join(CORE_HOME, '*');
    expect(target('Glob', { pattern: abs, path: 'src' })).toBe(abs);
  });

  it('the judge refuses a Grep over a root above the core home, and a Glob mask that climbs into it', () => {
    // Grep без path ищет в cwd: cwd = дом человека — предок дома ядра (F-13 у Qwen).
    expect(judge('Grep', { pattern: 'token' }, HOME)).toBe(false);
    expect(judge('Grep', { pattern: 'token', path: '.', glob: '../../**' })).toBe(false);
    expect(judge('Glob', { pattern: '../../.agentdeck-core-claude-test/**', path: '.' })).toBe(
      false,
    );
    // Внутри копии поиск разрешён, как раньше.
    expect(judge('Grep', { pattern: 'token', path: 'src', glob: '*.ts' })).toBe(true);
    expect(judge('Glob', { pattern: 'src/**/*.ts' })).toBe(true);
  });
});
