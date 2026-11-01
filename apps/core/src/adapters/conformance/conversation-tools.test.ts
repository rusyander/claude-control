import { describe, expect, it } from 'vitest';
import { decidePermit } from '../../policy/permit/permit.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { platformDenySet } from '../deny-overlay.ts';
import { createAdapterRegistry } from '../index.ts';

/**
 * Инструменты разговора CLI (F-89, H1): хук ядра видит КАЖДЫЙ вызов, и загрузчик отложенных
 * инструментов (`ToolSearch` / `tool_search`), отказанный как `unknown-action`, лишал шаг
 * инструментов ядра — `step_done` не загружался, шаг не кончался. Дорога целиком: переходник из
 * реестра сопоставляет сырой вызов, судья прав решает. Навык и подагент — свои классы `skill` /
 * `subagent` (этап 7): без фактов слоя сеанса отказаны с именем; прочие действующие (вызов
 * другого инструмента, план) остаются `other` и отказаны.
 */
const ctx: PermitContext = {
  copyRoot: '/work/copy',
  ownedPaths: [],
  deny: platformDenySet({ coreHome: '/core-home', tokenFiles: [] }),
  platformPaths: ['/core-home'],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const TOOLS = {
  claude: {
    conversation: ['ToolSearch', 'TodoWrite'],
    acting: ['ExitPlanMode'],
    layer: { Task: 'subagent', Agent: 'subagent', Skill: 'skill' },
  },
  qwen: {
    conversation: ['tool_search', 'todo_write'],
    acting: ['tool_call', 'save_memory'],
    layer: { agent: 'subagent', skill: 'skill' },
  },
} as const;

const registry = createAdapterRegistry();

describe.each(Object.keys(TOOLS) as (keyof typeof TOOLS)[])(
  'conversation tools through the %s adapter and the judge',
  (id) => {
    const adapter = registry.get(id);
    if (!adapter) throw new Error(`adapter ${id} not registered`);

    it.each(TOOLS[id].conversation)('%s → conversation, allowed with a reason', (tool) => {
      const ask = adapter.mapPermission({
        tool,
        input: { query: 'select:mcp__agentdeck__step_done', todos: [] },
      });
      expect(ask).toEqual({ action: 'conversation', target: tool, tool, display: tool });
      expect(decidePermit(ask, ctx)).toEqual({
        allow: true,
        signal: null,
        reason: 'conversation-internal tool',
      });
      // Шаг только для чтения его не теряет: разговор — не правка и не исполнение.
      expect(decidePermit(ask, ctx, 'review')).toMatchObject({ allow: true });
    });

    it.each(TOOLS[id].acting)('%s acts → stays other, refused as unknown-action', (tool) => {
      const ask = adapter.mapPermission({ tool, input: {} });
      expect(ask.action).toBe('other');
      expect(decidePermit(ask, ctx)).toMatchObject({ allow: false, code: 'unknown-action' });
    });

    it.each(Object.entries(TOOLS[id].layer))(
      '%s → %s, refused without user layer facts (no silent allow)',
      (tool, action) => {
        const ask = adapter.mapPermission({ tool, input: {} });
        expect(ask.action).toBe(action);
        expect(decidePermit(ask, ctx)).toMatchObject({
          allow: false,
          code: action === 'skill' ? 'skills-off' : 'subagent-unproven',
        });
      },
    );

    it('a lookalike name is not a conversation tool (exact names only)', () => {
      for (const tool of TOOLS[id].conversation) {
        for (const near of [tool.toLowerCase(), tool.toUpperCase(), `${tool}X`]) {
          if (near === tool) continue;
          expect(adapter.mapPermission({ tool: near, input: {} }).action).not.toBe('conversation');
        }
      }
    });
  },
);
