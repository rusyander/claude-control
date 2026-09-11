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
};
