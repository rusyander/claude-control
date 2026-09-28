import type { ResourceSummary } from '@agentdeck/contracts/group-path';
import type { GroupScope } from '@agentdeck/contracts/group-sources';
import { projectKey, readPanelJson, writePanelJson } from '../lib/app-store/group-sources.ts';
import type { EntityToggleDeps } from './entity-toggle.ts';
import { readJsonBlock } from './groups/answer-block.ts';
import { GroupRequestError } from './groups/errors.ts';
import { memberContent } from './groups/members.ts';
import { singleTurn, type GroupAsk } from './groups/model.ts';

/**
 * Сводка ресурса «что делает / как работает» на двух языках — для карточек
 * «Пути» и находок. Зовётся лениво (при первом показе), дешёвой ступенью, и
 * кэшируется по хэшу содержимого в `<appData>/summaries.json`: пока файл не
 * менялся, повторный показ бесплатен. Два одновременных запроса одного ресурса
 * ждут один вызов модели, а не платят дважды.
 */

const FILE = 'summaries.json';
export const SUMMARY_BLOCK_KIND = 'resource-summary';

type Cache = Record<string, ResourceSummary>;

const inFlight = new Map<string, Promise<ResourceSummary>>();

export type SummaryType = 'skill' | 'hook' | 'rule';

function cacheKey(scope: GroupScope, type: SummaryType, id: string): string {
  const where = scope.kind === 'project' ? projectKey(scope.path) : 'global';
  return `${where}|${type}:${id}`;
}

export async function resourceSummary(
  deps: EntityToggleDeps,
  ask: GroupAsk,
  prompt: string,
  type: SummaryType,
  id: string,
  projectPath?: string,
): Promise<ResourceSummary> {
  const scope: GroupScope = projectPath
    ? { kind: 'project', path: projectPath, provider: 'claude' }
    : { kind: 'global' };
  const content = memberContent(deps, scope, { kind: type, id });
  if (!content) throw new GroupRequestError(404, 'resource_not_found', 'resource-not-found');

  const key = cacheKey(scope, type, id);
  const cached = readPanelJson<Cache>(deps.paths.appData, FILE, {})[key];
  if (cached && cached.hash === content.hash) return cached;

  const flightKey = `${deps.paths.appData}|${key}|${content.hash}`;
  const pending = inFlight.get(flightKey);
  if (pending) return pending;

  const run = (async (): Promise<ResourceSummary> => {
    const reply = await ask(
      singleTurn(prompt, `${type} ${id}:\n${content.text.slice(0, 16_000)}`),
      'cheap',
    );
    const parsed = readJsonBlock(reply, SUMMARY_BLOCK_KIND) as
      { ru?: unknown; en?: unknown } | undefined;
    if (typeof parsed?.ru !== 'string' || typeof parsed.en !== 'string') {
      throw new GroupRequestError(502, 'model_unreadable', 'group-model-unreadable');
    }
    const summary: ResourceSummary = {
      hash: content.hash,
      ru: parsed.ru.trim(),
      en: parsed.en.trim(),
    };
    // Перечитываем перед записью: пока шёл вызов, мог записаться соседний ресурс.
    const cache = readPanelJson<Cache>(deps.paths.appData, FILE, {});
    cache[key] = summary;
    writePanelJson(deps.paths.appData, FILE, cache);
    return summary;
  })();
  inFlight.set(flightKey, run);
  try {
    return await run;
  } finally {
    inFlight.delete(flightKey);
  }
}
