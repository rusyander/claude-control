import { PROMPT_MAX_BYTES } from '@agentdeck/contracts/prompts';

/**
 * Правка длиннее потолка. Отдельный класс, а не просто `Error`, по одной
 * причине: правило живёт в двери записи (`writeOverride`), а рассказать о нём
 * человеку обязан тот, кто принял запрос, — и маршрут должен уметь отличить
 * «слишком длинно» от «диск не записался», не разбирая текст сообщения.
 */
export class PromptTooLongError extends Error {
  readonly code = 'prompt_too_long';
  /** Какого промпта касается отказ: писателей у правок двое, и оба пакетные. */
  readonly promptId: string;

  constructor(promptId: string) {
    super(`Промпт длиннее ${Math.round(PROMPT_MAX_BYTES / 1024)} КБ.`);
    this.name = 'PromptTooLongError';
    this.promptId = promptId;
  }
}
