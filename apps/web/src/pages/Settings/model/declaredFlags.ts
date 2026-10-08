import type { ModelInfo } from '@agentdeck/contracts';

/** Объявленные контуром флаги модели — только те, что он назвал. */
export function declaredFlags(model: ModelInfo): Array<{ key: string; on: boolean }> {
  const flags: Array<{ key: string; on: boolean }> = [];
  if (model.vision !== undefined) flags.push({ key: 'vision', on: model.vision });
  if (model.functionCalling !== undefined)
    flags.push({ key: 'functionCalling', on: model.functionCalling });
  if (model.jsonMode !== undefined) flags.push({ key: 'jsonMode', on: model.jsonMode });
  return flags;
}
