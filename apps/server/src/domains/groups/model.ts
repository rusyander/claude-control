import type { ModelInfo } from '@agentdeck/contracts';
import { ASSIGNABLE_MODELS } from '@agentdeck/contracts/model-cascade';
import type { PromptId } from '@agentdeck/contracts/prompts';
import type { ConfigProvider } from '../../providers/types.ts';
import { newestInFamily } from '../models/model-defaults.ts';
import { promptText } from '../prompts.ts';
import { withBlockLang } from './answer-block.ts';
import type { AgentImage } from '../../lib/agent-images.ts';

/**
 * Служебный вызов модели для групп: опись, советы, слияние, шаг «Пути», сводки.
 *
 * Домены получают его ФУНКЦИЕЙ, а не собирают сами: как именно звать модель
 * (CLI по подписке, ключ, свой эндпоинт) решает общий раннер ассистента, а
 * тестам нужна подмена без процессов и сети. Реплики — история разговора:
 * у шага «Пути» она растёт от круга к кругу, у остальных это одно сообщение.
 */
export interface GroupModelMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Картинки реплики человека — в самом запросе к модели (`lib/agent-images.ts`). */
  images?: readonly AgentImage[];
}

/** `cheap` — младшая ступень лестницы провайдера; `default` — его собственная настройка. */
export type GroupModelTier = 'cheap' | 'default';

export type GroupAsk = (messages: GroupModelMessage[], tier: GroupModelTier) => Promise<string>;

/** Вызов не удался: причина уходит человеку кодом, а не текстом раннера. */
export class GroupModelError extends Error {
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(detail || reason);
    this.name = 'GroupModelError';
    this.reason = reason;
  }
}

/**
 * Дешёвая модель провайдера. У Claude — младший алиас (`haiku`): алиас сам
 * разворачивается в последнее поколение, поэтому каталог тут не нужен. У
 * чужого — младшая ступень его `modelLadder`, найденная в каталоге; нет
 * лестницы или семейства в каталоге — `undefined`, и вызов идёт настройкой CLI
 * (дороже, но честно: подобранная наугад модель могла бы не существовать).
 */
export function cheapModelFor(
  provider: Pick<ConfigProvider, 'id' | 'modelLadder'>,
  models: ModelInfo[],
): string | undefined {
  if (provider.id === 'claude') return ASSIGNABLE_MODELS[0];
  const family = provider.modelLadder?.[0];
  return family ? newestInFamily(models, family)?.id : undefined;
}

/** Текст промпта каталога (с правкой человека, если она есть) и нашим языком блока. */
export function groupPrompt(appData: string, id: PromptId, blockKind: string): string {
  return withBlockLang(promptText(appData, id), blockKind);
}

/** Одно сообщение: промпт каталога и данные под ним. */
export function singleTurn(prompt: string, data: string): GroupModelMessage[] {
  return [{ role: 'user', content: `${prompt.trim()}\n\n${data.trim()}\n` }];
}
