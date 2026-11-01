import type { HopDriver } from './driver.types.ts';

/**
 * Совместимый шлюз OpenAI (перенос `drivers/openai-compat.ts` панели, часть конвейера): своих
 * кадров нет, отказы — общей таблицей `status.ts`. Им же говорит свой сервер моделей и
 * подставной контур — у них тоже нет вендорных полей.
 */
export const openAiCompatDriver: HopDriver = {
  id: 'openai-compat',
  title: 'Совместимый шлюз',
  requestFields: [],
  readFrame: () => undefined,
  vendorFields: [],
  statusRows: [],
  clientTools: 'native',
};
