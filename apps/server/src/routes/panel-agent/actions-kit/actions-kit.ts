import { z } from 'zod';
import type { KitResponse } from '@agentdeck/contracts/kit';
import { definePanelAction, type AnyPanelAction } from '../registry.ts';

/**
 * Раздел «Набор панели» для агента панели — пока только чтение: что в наборе,
 * что включено, где он расходится с глобальным слоем и какой режим у каждого
 * CLI. Правка, режимы и перенос в глобальный слой — кнопки человека.
 */
const kitStatus = definePanelAction({
  name: 'kit_status',
  section: 'kit',
  risk: 'read',
  description:
    'Panel kit: version, per-CLI mode (global/hybrid/ours), every item (skill, command, agent, ' +
    'rule, hook) with origin, enabled flag and whether it matches the same-named item in the ' +
    "user's global layer; items only in the global layer. Read-only.",
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/kit' }),
  shape: (_input, body) => {
    const data = body as KitResponse;
    return {
      version: data.version,
      providers: data.providers.map(({ id, mode, modes, reason }) => ({
        id,
        mode,
        modes,
        ...(reason ? { reason } : {}),
      })),
      items: data.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        origin: item.origin,
        enabled: item.enabled,
        ...(item.conflict ? { global: item.conflict.same ? 'same' : 'differs' } : {}),
      })),
      globalOnly: data.globalOnly.map(({ kind, name }) => ({ kind, name })),
    };
  },
  summary: 'journal-kit-status',
});

export const KIT_ACTIONS: readonly AnyPanelAction[] = [kitStatus];
