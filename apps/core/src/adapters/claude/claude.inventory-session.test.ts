import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { createClaudeAdapter } from './claude.ts';

/**
 * Опись слоя через НАСТОЯЩИЙ переходник Claude (`CliAdapter.inventory`, каркас SDK-потока): факты
 * сеанса (как он запущен — режим, перенос) доходят до описи слоя, и хук локального слоя ядра
 * (`--settings`) виден в описи сеанса. Без фактов сеанса — опись слоя человека как есть.
 */

describe('claude adapter: the inventory takes the session facts through the sdk frame', () => {
  it('a carried local-layer hook is in the session inventory, absent without session facts', () => {
    const root = tempDir('cl-inv-');
    const config = join(root, '.claude');
    const cwd = join(root, 'work');
    mkdirSync(config, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const pin = { CLAUDE_CONFIG_DIR: config, HOME: root, USERPROFILE: root };
    const inventory = createClaudeAdapter().inventory;
    if (!inventory) throw new Error('the claude adapter has no inventory');
    const localLayer = {
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node ll.mjs' }] }],
      },
    };
    const keys = (inv: UserLayerInventory) => inv.hooks.map((h) => h.key);
    expect(keys(inventory(pin, cwd, true, { ran: 'observe', carry: { localLayer } }))).toEqual([
      'local-layer:PreToolUse.0.0',
    ]);
    expect(keys(inventory(pin, cwd, true))).toEqual([]);
  });
});
