import { describe, expect, it } from 'vitest';
import {
  CORE_MCP_SERVER,
  MODEL_TOOL_NAMES,
  PERMIT_MCP_SERVER,
  SESSION_STEP_KINDS,
  toolPlanFor,
} from '@agentdeck/contracts/core/model-tools';
import { claudeDenyRules } from '../../adapters/claude/permission.ts';
import { READ_ONLY_DENIED } from '../../adapters/read-only.ts';
import { COMPACT_RESERVE_TOKENS, MIN_HEADROOM_TOKENS, mcpListFor } from './mcp.ts';
import type { McpListInput, McpOffer, McpRouteFact } from './mcp.types.ts';

/**
 * Строгий список MCP по виду шага (P73): сессия ревью видит только читающие инструменты, список
 * совпадает с видом; сервер человека — только выбранный для вида и только в запас окна.
 */

const cloud: McpRouteFact = { id: 'cloud', local: false, contextTokens: null };
const gitlab: McpOffer = {
  id: 'gitlab',
  tokens: 15_000,
  tools: [
    { name: 'get_mr', readOnly: true },
    { name: 'create_note', readOnly: false },
    { name: 'merge_mr', readOnly: null },
  ],
};
const docs: McpOffer = { id: 'docs', tokens: 2_000, tools: [{ name: 'search', readOnly: true }] };

function input(over: Partial<McpListInput> = {}): McpListInput {
  return {
    offers: [gitlab, docs],
    picks: {},
    baseTokens: 20_000,
    coreTools: [...MODEL_TOOL_NAMES],
    ...over,
  };
}

describe('mcpListFor — P73 conformance over every session step kind', () => {
  const allPicked = Object.fromEntries(SESSION_STEP_KINDS.map((k) => [k, ['gitlab', 'docs']]));

  for (const kind of SESSION_STEP_KINDS)
    it(`${kind}: core servers always, core tools by the kind plan, human writes only where the kind writes`, () => {
      const plan = toolPlanFor(kind)!;
      const list = mcpListFor(kind, cloud, input({ picks: allPicked }));
      expect(list.servers).toEqual([CORE_MCP_SERVER, PERMIT_MCP_SERVER, 'gitlab', 'docs']);
      const coreDenied = list.deniedTools
        .filter((t) => t.startsWith(`mcp__${CORE_MCP_SERVER}__`))
        .map((t) => t.slice(`mcp__${CORE_MCP_SERVER}__`.length));
      expect(coreDenied.sort()).toEqual(
        MODEL_TOOL_NAMES.filter((t) => !plan.modelTools.includes(t)).sort(),
      );
      const humanDenied = list.deniedTools.filter((t) => t.startsWith('mcp__gitlab__'));
      if (plan.builtins === 'read-only')
        expect(humanDenied).toEqual(['mcp__gitlab__create_note', 'mcp__gitlab__merge_mr']);
      else expect(humanDenied).toEqual([]);
      expect(list.deniedTools).not.toContain('mcp__gitlab__get_mr');
      expect(list.deniedTools).not.toContain('mcp__docs__search');
    });

  it('review through the Claude deny rules: no write tool reachable — built-in or MCP', () => {
    const list = mcpListFor('review', cloud, input({ picks: { review: ['gitlab'] } }));
    const { rules } = claudeDenyRules(
      { paths: [], commands: [], mcpTools: list.deniedTools, tools: [] },
      READ_ONLY_DENIED,
      'C:/copy',
    );
    for (const t of ['Write', 'Edit', 'Bash', 'mcp__gitlab__create_note', 'mcp__gitlab__merge_mr'])
      expect(rules).toContain(t);
    expect(rules).not.toContain('mcp__gitlab__get_mr');
  });

  it('a kind without a model session has no list', () => {
    expect(() => mcpListFor('publish', cloud, input())).toThrow(/no model session/);
  });
});

describe('mcpListFor — strict list', () => {
  it('no picks: core and permit only, nothing of the human (default none)', () => {
    const list = mcpListFor('work', cloud, input());
    expect(list.servers).toEqual([CORE_MCP_SERVER, PERMIT_MCP_SERVER]);
    expect(list.dropped).toEqual([]);
  });

  it('a pick for another kind does not leak into this one', () => {
    const list = mcpListFor('work', cloud, input({ picks: { review: ['gitlab'] } }));
    expect(list.servers).not.toContain('gitlab');
  });

  it('picked but unoffered or squatting the core name is dropped with a reason', () => {
    const list = mcpListFor(
      'work',
      cloud,
      input({
        offers: [gitlab, { id: CORE_MCP_SERVER, tools: [], tokens: 1 }],
        picks: { work: ['ghost', CORE_MCP_SERVER] },
      }),
    );
    expect(list.dropped.map((d) => d.id)).toEqual(['ghost', CORE_MCP_SERVER]);
    expect(list.servers).toEqual([CORE_MCP_SERVER, PERMIT_MCP_SERVER]);
  });

  it('read-only kind with an unread tool list drops the server; a writing kind keeps it', () => {
    const unread: McpOffer = { id: 'mute', tools: null, tokens: 100 };
    const picks = { review: ['mute'], work: ['mute'] };
    expect(mcpListFor('review', cloud, input({ offers: [unread], picks })).servers).not.toContain(
      'mute',
    );
    expect(mcpListFor('work', cloud, input({ offers: [unread], picks })).servers).toContain('mute');
  });

  it('bounded window: servers taken in pick order while headroom stays >= 4000', () => {
    const contextTokens = COMPACT_RESERVE_TOKENS + 20_000 + 2_000 + MIN_HEADROOM_TOKENS + 10;
    const route: McpRouteFact = { id: 'local-qwen', local: true, contextTokens };
    const list = mcpListFor('work', route, input({ picks: { work: ['docs', 'gitlab'] } }));
    expect(list.servers).toEqual([CORE_MCP_SERVER, PERMIT_MCP_SERVER, 'docs']);
    expect(list.dropped[0]).toMatchObject({ id: 'gitlab' });
    expect(list.headroom).toBe(MIN_HEADROOM_TOKENS + 10);
  });

  it('local route with unknown window: no human server; unmeasured cost on a bounded window: dropped', () => {
    const unknown: McpRouteFact = { id: 'local', local: true, contextTokens: null };
    expect(
      mcpListFor('work', unknown, input({ picks: { work: ['docs'] } })).dropped[0]?.reason,
    ).toMatch(/context unknown/);
    const bounded: McpRouteFact = { id: 'b', local: false, contextTokens: 200_000 };
    const unmeasured: McpOffer = { ...docs, tokens: null };
    expect(
      mcpListFor('work', bounded, input({ offers: [unmeasured], picks: { work: ['docs'] } }))
        .dropped[0]?.reason,
    ).toMatch(/cost unmeasured/);
  });

  it('the hash moves with the list (it keys the base cache)', () => {
    const a = mcpListFor('work', cloud, input()).hash;
    const b = mcpListFor('work', cloud, input({ picks: { work: ['docs'] } })).hash;
    expect(a).not.toBe(b);
    expect(mcpListFor('work', cloud, input()).hash).toBe(a);
  });
});
