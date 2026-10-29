import { CLI_RUN_FACTS } from './registry.ts';
import type { CliRunFacts } from './types.ts';

/**
 * Литералы, которым место только внутри переходников CLI (спецификация 11 R:PR-08, P108):
 * id CLI, вендоры, имена бинарей, переменные окружения CLI, приставки семейств моделей.
 * Список строится из реестра — новый CLI расширяет его сам, руками список не ведётся.
 */
export interface CliLiterals {
  adapterIds: string[];
  vendorNames: string[];
  binaryNames: string[];
  envVarNames: string[];
  modelFamilyPrefixes: string[];
}

/**
 * Пробный вход для канала «окружение прогона»: имена переменных видны только по результату
 * `build`, а функция чистая — вызвать её безопасно.
 */
const PROBE_INPUT = { baseUrl: 'http://127.0.0.1:1/v1', model: 'probe', key: 'probe' };

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function envVarsOf(facts: CliRunFacts): string[] {
  const names: string[] = [...facts.vendorApi.keyVars];
  for (const channel of facts.channels) {
    if (channel.via === 'file') continue;
    if (channel.keyVar) names.push(channel.keyVar);
    if (channel.form === 'vars') {
      names.push(channel.baseUrlVar);
      if (channel.modelVar) names.push(channel.modelVar);
    } else {
      names.push(...Object.keys(channel.build(PROBE_INPUT)));
    }
  }
  const limits = facts.limitsChannel;
  if (limits?.via === 'env') names.push(...limits.vars);
  if (limits?.via === 'settings-file') names.push(limits.fileVar);
  return names;
}

export function deriveLiterals(all: readonly CliRunFacts[]): CliLiterals {
  return {
    adapterIds: sortedUnique(all.map((facts) => facts.id)),
    vendorNames: sortedUnique(all.flatMap((facts) => facts.modelVendors ?? [])),
    binaryNames: sortedUnique(
      all.flatMap((facts) => [facts.binary.command, facts.binary.windowsCommand]),
    ),
    envVarNames: sortedUnique(all.flatMap(envVarsOf)),
    modelFamilyPrefixes: sortedUnique(all.flatMap((facts) => facts.modelLadder ?? [])),
  };
}

/** Литералы всех CLI реестра — вход будущего линта P108. */
export const CLI_LITERALS: CliLiterals = deriveLiterals(CLI_RUN_FACTS);
