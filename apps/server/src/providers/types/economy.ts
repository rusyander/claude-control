import type { GroupEconomySupport } from '@agentdeck/contracts/group-economy-support';

/**
 * Канал рычагов экономии групп на один прогон чужого CLI
 * (`domains/provider-chat/economy-run/economy-run.ts`): у каждого CLI свой
 * способ донести значение до ОДНОГО запуска, не трогая конфиг человека —
 * ключ `-c` у Codex, слой системных настроек у Qwen Code и Gemini, переменные
 * окружения у Goose и Continue.
 */
export type EconomyChannel = 'codex' | 'qwen' | 'gemini' | 'goose' | 'continue';

/**
 * Рычаги экономии групп у провайдера: что объявлено человеку (`support`, отметки
 * «Где действует») и чем панель это делает (`channel`). Канала нет — у CLI нет
 * ни одного родного рычага на прогон, и диспетчер его не зовёт; эмулируемые
 * рычаги (строка привычек, выбор модели доставки) живут вне канала.
 */
export interface ProviderGroupEconomy {
  support: GroupEconomySupport;
  channel?: EconomyChannel;
  /**
   * У CLI нет своего цикла инструментов (aider: один `--message`, оболочка
   * выключена, переписку панель шлёт целиком): из строки экономии группы ему едут
   * только фразы, исполнимые правкой файла, — тетрадь задачи и задачи трекера
   * (`NO_TOOL_LOOP_ECONOMY_PROMPT`). Нет поля — строка целиком.
   */
  noToolLoop?: true;
}
