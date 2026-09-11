import type { PlatformCapability, PlatformCapabilityFinding } from '@agentdeck/contracts';
import {
  readPlatformModels,
  versionedUrl,
  type DriverReading,
  type PlatformDriver,
} from './driver.ts';

/**
 * Драйвер любого совместимого с OpenAI шлюза.
 *
 * У него спрашивают ровно одно — список моделей: другого задокументированного
 * способа что-либо узнать у произвольного шлюза нет. Всё остальное остаётся
 * «не объявлено» и НЕ превращается ни в галку, ни в прочерк: и то и другое было
 * бы утверждением, которого панель не проверяла.
 */

/**
 * Что не спрашивается у совместимого шлюза, потому что спросить нечем. Чат
 * здесь НЕ случайно: непустой список моделей не доказывает, что шлюз умеет
 * `/chat/completions` — он бывает и чисто эмбеддинговым. «Есть модели» и «есть
 * чат» это разные утверждения, и второе панель не проверяла.
 */
const UNDECLARED: PlatformCapability[] = [
  'chat',
  'embeddings',
  'agents',
  'guardrails',
  'knowledge',
  'client-tools',
];

export const openAiCompatDriver: PlatformDriver = {
  id: 'openai-compat',
  title: 'Совместимый шлюз',

  modelsUrl: (baseUrl) => versionedUrl(baseUrl, 'models'),

  headers: (token) => ({
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }),

  read(payload): DriverReading {
    const models = readPlatformModels(payload);

    const capabilities: PlatformCapabilityFinding[] = [
      {
        id: 'models',
        state: 'yes',
        evidence: 'answer',
        detail: 'список отдан шлюзом',
        count: models.length,
      },
      // compromise: probe-guess — совместимый шлюз не объявляет возможности, и панель считает, что есть только модели
      ...UNDECLARED.map((id): PlatformCapabilityFinding => ({
        id,
        state: 'unknown',
        evidence: 'answer',
        detail: 'совместимый шлюз этого о себе не сообщает',
        compromise: 'probe-guess',
      })),
    ];

    return {
      models,
      capabilities,
      // Ограничений произвольного шлюза панель не знает — и не выдумывает их.
      limits: {},
      notes: ['Возможности сверх списка моделей у совместимого шлюза не объявлены.'],
      compromises: ['probe-guess'],
    };
  },

  /**
   * Пусто — и это утверждение, а не пробел: судьба полей у совместимого шлюза
   * ровно такая, как в общей таблице диалектов. Дописать сюда «инструменты
   * отбрасываются» значило бы перенести на чужой шлюз свойство платформа компании.
   */
  requestFields: [],

  /** Вендорных кадров у совместимого шлюза нет: поток — обычный OpenAI. */
  readFrame: () => undefined,

  vendorFields: [],

  /**
   * Своих кодов нет. Даже 401 остаётся общим: пять причин отказа — знание о
   * платформа компании, проверенное в её исходниках, и у произвольного шлюза причина
   * может быть ровно одна.
   */
  statusRows: [],

  /**
   * Шлюзы OpenAI-вида публикуют `/v1/images/generations`. Ручка объявлена
   * адресом эндпоинта (В4), а не угадывается по списку моделей.
   */
  images: 'images-api',

  /**
   * Инструменты клиента проходят как есть: это и есть схема OpenAI. Прослойка
   * такому шлюзу не нужна — агент работает руками.
   */
  toolsPassthrough: true,

  /**
   * Усилие рассуждения совместимый шлюз может и принимать, и не принимать, а
   * спросить его об этом нечем. `false` означает «панель не отправляет», а не
   * «шлюз не умеет»: отправить непроверенное поле — это 400 на ровном месте.
   */
  effort: false,

  /** Ручек у произвольного шлюза панель не знает и не придумывает. */
  controls: [],

  smokePrompt: 'Ответь одним словом: готов',
};
