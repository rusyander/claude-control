import type { PlatformCapabilityFinding } from '@agentdeck/contracts';
import type { CompromiseId } from '@agentdeck/contracts/compromises';
import {
  readPlatformModels,
  versionedUrl,
  type DriverReading,
  type PlatformDriver,
} from './driver.ts';

/**
 * Драйвер корпоративной платформы: публичная поверхность по ключу.
 *
 * Что он знает и откуда:
 * - список моделей УЖЕ сужен правами ключа — это единственный бесплатный
 *   источник правды о том, что ключу доступно;
 * - вид модели (чат/эмбеддинги) берётся из объявленного платформой поля, а НЕ
 *   из имени модели: «угадать по подстроке embed» — ровно то враньё, ради
 *   которого заведён инвариант 13;
 * - проверки контента работают в полосе запроса — свойство самой платформы, а
 *   не ключа: блокировка приезжает статусом 451 вместе с ответом;
 * - агенты бесплатно не проверяются: узнать про них можно только вызовом
 *   опубликованного агента, а тратить деньги ключа молча панель не станет.
 *   Поэтому «не объявлено», а не галка.
 */

/**
 * Строка матрицы. `evidence` обязателен и не имеет умолчания намеренно: это
 * граница между «панель увидела это в ответе ВАШЕГО контура» и «так устроена
 * платформа вообще», и молча выбранная сторона была бы ровно тем враньём, от
 * которого заведён инвариант 13.
 */
function capability(
  id: PlatformCapabilityFinding['id'],
  state: PlatformCapabilityFinding['state'],
  evidence: PlatformCapabilityFinding['evidence'],
  detail: string,
  extra: { compromise?: CompromiseId; count?: number } = {},
): PlatformCapabilityFinding {
  return { id, state, detail, evidence, ...extra };
}

export const enterprise-platformDriver: PlatformDriver = {
  id: 'enterprise-platform',
  title: 'Контур',

  modelsUrl: (baseUrl) => versionedUrl(baseUrl, 'models'),

  headers: (token) => ({
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }),

  read(payload): DriverReading {
    const models = readPlatformModels(payload);
    // Вид модели объявляет платформа полем, а не именем модели: молчание в этом
    // поле остаётся молчанием и ниже превращается в «не объявлено».
    //
    // Считаем только РАСПОЗНАННЫЕ виды. Поле вида ищется по нескольким именам,
    // и среди них есть общие (`type`, `mode`): у части шлюзов там лежит совсем
    // другое — `{"id":"gpt-4o","type":"model"}`. Считать такую строку
    // объявлением значило бы объявить от имени контура «моделей чата ключу не
    // выдано» — тот же инвариант 13, только вывернутый в отказ, а отказ на
    // экране страшнее молчания: человек пойдёт чинить права ключа.
    const kinds = models.map((model) => model.kind).filter((kind): kind is string => Boolean(kind));
    const embeddingCount = kinds.filter((kind) => kind.includes('embed')).length;
    const chatCount = kinds.filter((kind) => kind.includes('chat') || kind.includes('text')).length;
    const declared = embeddingCount + chatCount;

    const capabilities: PlatformCapabilityFinding[] = [
      capability('models', 'yes', 'answer', 'список сужен правами ключа', { count: models.length }),

      // Вид модели объявляет сама платформа. Список без объявленных видов —
      // это «не объявлено», а не «чата нет»: панель не решает за платформу.
      declared === 0
        ? capability(
            'chat',
            models.length > 0 ? 'unknown' : 'no',
            'answer',
            'вид моделей не объявлен',
          )
        : capability(
            'chat',
            chatCount > 0 ? 'yes' : 'no',
            'answer',
            chatCount > 0 ? 'модели чата в списке ключа' : 'моделей чата ключу не выдано',
            { count: chatCount },
          ),

      declared === 0
        ? capability('embeddings', 'unknown', 'answer', 'вид моделей не объявлен')
        : capability(
            'embeddings',
            embeddingCount > 0 ? 'yes' : 'no',
            'answer',
            embeddingCount > 0
              ? 'модели эмбеддингов в списке ключа'
              : 'моделей эмбеддингов ключу не выдано',
            { count: embeddingCount },
          ),

      // Проверить агентов можно только вызовом опубликованного агента: это
      // деньги ключа, и тратить их ради галки в матрице панель не станет.
      capability(
        'agents',
        'unknown',
        'answer',
        'проверяется только вызовом агента — панель его не делает',
      ),

      // Свойство самой платформы, а не ключа: проверки идут в полосе запроса, и
      // блокировка приезжает вместе с ответом, статусом 451. Ответ КОНКРЕТНОГО
      // контура этого не подтверждает — потому `platform`, а не `answer`.
      capability(
        'guardrails',
        'yes',
        'platform',
        'работают в полосе запроса: отказ приходит статусом 451',
      ),

      // compromise: kb-via-owner — знания компании доступны только косвенно, через владельца ключа
      capability(
        'knowledge',
        'indirect',
        'platform',
        'через владельца ключа, отдельного маршрута нет',
        { compromise: 'kb-via-owner' },
      ),

      // compromise: no-client-tools — публичная схема не принимает описания инструментов, список клиента отбрасывается
      capability(
        'client-tools',
        'no',
        'platform',
        'публичный API не принимает описания инструментов',
        { compromise: 'no-client-tools' },
      ),
    ];

    return {
      models,
      capabilities,
      // Известные свойства платформы, которые обязан знать шлюз: не-потоковый
      // запрос рвётся на 120 с, а длинную историю платформа сжимает сама.
      limits: { nonStreamTimeoutSec: 120, managedContext: true },
      notes: [],
      compromises: ['kb-via-owner', 'no-client-tools'],
    };
  },

  /**
   * Публичный API платформы живёт на отдельном хосте, а человек чаще всего даёт
   * адрес админки, в которую сам заходит. Это знание О ПЛАТФОРМЕ, поэтому оно
   * здесь: произвольный шлюз называется как угодно, и такая подсказка на нём
   * была бы выдумкой.
   */
  addressHint(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.startsWith('api.') || host.startsWith('127.') || host === 'localhost')
        return undefined;
      return 'Похоже, это адрес админки: публичный API живёт на отдельном хосте (обычно api.<домен>).';
    } catch {
      return undefined;
    }
  },
};
