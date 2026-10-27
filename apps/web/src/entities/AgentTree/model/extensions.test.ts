import { describe, expect, it } from 'vitest';
import type { AgentExtensionSummary, AgentExtensionUse } from '@agentdeck/contracts';
import { extensionChips, extensionTotals, groupByKind, mergeSummaries } from './extensions';

/**
 * Скиллы, хуки и MCP агента в значках узла, строке карточки группы и окне:
 * счёт по видам, слияние агентов группы и что попадает в значки — по ним
 * человек решает, открывать ли окно.
 */
describe('extensions', () => {
  const summary: AgentExtensionSummary[] = [
    { kind: 'skill', name: 'deep-review', count: 2, lastAt: '2026-10-26T10:00:00.000Z' },
    { kind: 'mcp', name: 'gitlab/get_issue', count: 3, totalMs: 900 },
    { kind: 'mcp', name: 'gitlab/list_mrs', count: 1 },
    { kind: 'hook', name: 'git-guard', count: 5, denied: 2 },
    { kind: 'hook', name: 'context-watch', count: 1, errors: 1 },
  ];

  it('итоги складывают срабатывания по видам, отказы и ошибки отдельно', () => {
    expect(extensionTotals(summary)).toEqual({
      skill: 2,
      mcp: 4,
      hook: 6,
      denied: 2,
      errors: 1,
    });
    expect(extensionTotals(undefined)).toEqual({
      skill: 0,
      mcp: 0,
      hook: 0,
      denied: 0,
      errors: 0,
    });
  });

  it('слияние группы суммирует одно имя у разных агентов и берёт позднее время', () => {
    const merged = mergeSummaries([
      [{ kind: 'skill', name: 'deep-review', count: 1, lastAt: '2026-10-26T09:00:00.000Z' }],
      undefined,
      [
        {
          kind: 'skill',
          name: 'deep-review',
          count: 2,
          lastAt: '2026-10-26T11:00:00.000Z',
          totalMs: 40,
        },
        { kind: 'hook', name: 'git-guard', count: 3, denied: 1, errors: 2 },
        { kind: 'hook', name: 'git-guard', count: 1, denied: 1 },
      ],
    ]);
    expect(merged).toEqual([
      {
        kind: 'skill',
        name: 'deep-review',
        count: 3,
        lastAt: '2026-10-26T11:00:00.000Z',
        totalMs: 40,
      },
      { kind: 'hook', name: 'git-guard', count: 4, denied: 2, errors: 2 },
    ]);
  });

  it('слияние не трогает исходные сводки агентов', () => {
    const own: AgentExtensionSummary[] = [{ kind: 'mcp', name: 'jira/get', count: 1 }];
    mergeSummaries([own, own]);
    expect(own[0]?.count).toBe(1);
  });

  it('порядок после слияния: скиллы, MCP, хуки, внутри — по числу', () => {
    const merged = mergeSummaries([
      [
        { kind: 'hook', name: 'h', count: 9 },
        { kind: 'mcp', name: 'a/x', count: 1 },
        { kind: 'mcp', name: 'b/y', count: 4 },
        { kind: 'skill', name: 's', count: 1 },
      ],
    ]);
    expect(merged.map((row) => row.name)).toEqual(['s', 'b/y', 'a/x', 'h']);
  });

  it('значки: скиллы по именам, MCP по серверам, хуки числом, отказы отдельно', () => {
    expect(extensionChips(summary)).toEqual([
      { kind: 'skill', label: 'deep-review', count: 2 },
      { kind: 'mcp', label: 'gitlab', count: 4 },
      { kind: 'hook', label: '', count: 6 },
      { kind: 'denied', label: '', count: 2 },
    ]);
  });

  it('лишние имена уходят в «ещё N»: три скилла и два самых частых сервера', () => {
    const many: AgentExtensionSummary[] = [
      ...['a', 'b', 'c', 'd', 'e'].map((name) => ({ kind: 'skill' as const, name, count: 1 })),
      ...['s1/t', 's2/t', 's3/t'].map((name, index) => ({
        kind: 'mcp' as const,
        name,
        count: index + 1,
      })),
    ];
    const chips = extensionChips(many);
    expect(chips.filter((chip) => chip.kind === 'skill' && !chip.more)).toHaveLength(3);
    expect(chips).toContainEqual({ kind: 'skill', label: '', count: 2, more: true });
    expect(chips.filter((chip) => chip.kind === 'mcp' && !chip.more).map((c) => c.label)).toEqual([
      's3',
      's2',
    ]);
    expect(chips).toContainEqual({ kind: 'mcp', label: '', count: 1, more: true });
  });

  it('ровно три скилла — без «ещё»', () => {
    const three = ['a', 'b', 'c'].map((name) => ({ kind: 'skill' as const, name, count: 1 }));
    expect(extensionChips(three).some((chip) => chip.more)).toBe(false);
  });

  it('нет сводки — нет значков; хуков без отказов — без значка отказов', () => {
    expect(extensionChips(undefined)).toEqual([]);
    expect(extensionChips([{ kind: 'hook', name: 'h', count: 1 }])).toEqual([
      { kind: 'hook', label: '', count: 1 },
    ]);
  });

  it('хронология делится по видам и сохраняет порядок транскрипта', () => {
    const items: AgentExtensionUse[] = [
      { kind: 'hook', name: 'h1', outcome: 'ok' },
      { kind: 'skill', name: 's1', outcome: 'ok' },
      { kind: 'hook', name: 'h2', outcome: 'denied' },
      { kind: 'mcp', name: 'm/1', outcome: 'running' },
    ];
    const groups = groupByKind(items);
    expect(groups.hook.map((item) => item.name)).toEqual(['h1', 'h2']);
    expect(groups.skill.map((item) => item.name)).toEqual(['s1']);
    expect(groups.mcp.map((item) => item.name)).toEqual(['m/1']);
  });
});
