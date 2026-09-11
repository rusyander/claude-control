import { describe, it, expect } from 'vitest';
import { driverFor } from './index.ts';
import { readPlatformModels, versionedUrl } from './driver.ts';

/**
 * Драйверы: единственное место, где знают о конкретной платформе.
 *
 * Главное свойство, которое здесь проверяется, — ЧЕСТНОСТЬ матрицы. Возможность,
 * которую панель не подтвердила ответом контура, обязана приходить как «не
 * объявлено», а не как «нет» и не как галка: инвариант 13 партии.
 */

function findingOf(payload: unknown, id: string, driver: 'enterprise-platform' | 'openai-compat' = 'enterprise-platform') {
  const reading = driverFor(driver).read(payload);
  const finding = reading.capabilities.find((item) => item.id === id);
  if (!finding) throw new Error(`в матрице нет строки «${id}»`);
  return finding;
}

describe('versionedUrl: вторая /v1 не приклеивается', () => {
  it('корень API получает версию', () => {
    expect(versionedUrl('https://api.example.ru', 'models')).toBe(
      'https://api.example.ru/v1/models',
    );
  });

  it('адрес с версией остаётся как есть', () => {
    expect(versionedUrl('http://127.0.0.1:11434/v1', 'models')).toBe(
      'http://127.0.0.1:11434/v1/models',
    );
    expect(versionedUrl('https://x.example/v1beta/', 'models')).toBe(
      'https://x.example/v1beta/models',
    );
  });

  it('хвостовые слэши не плодят пустых сегментов', () => {
    expect(versionedUrl('https://api.example.ru///', 'models')).toBe(
      'https://api.example.ru/v1/models',
    );
  });
});

describe('драйвер контура: матрица из объявленного, а не из имён моделей', () => {
  const declared = {
    data: [
      { id: 'gpt-4o', kind: 'chat' },
      { id: 'ru-embed-v2', kind: 'embedding' },
    ],
  };

  it('вид модели объявлен — эмбеддинги и чат считаются по нему', () => {
    expect(findingOf(declared, 'embeddings')).toMatchObject({ state: 'yes', count: 1 });
    expect(findingOf(declared, 'chat')).toMatchObject({ state: 'yes', count: 1 });
  });

  it('вид не объявлен — «не объявлено», а НЕ «нет»', () => {
    const payload = { data: [{ id: 'какая-то-модель' }] };
    expect(findingOf(payload, 'embeddings').state).toBe('unknown');
    expect(findingOf(payload, 'chat').state).toBe('unknown');
  });

  it('имя модели с «embed» без объявленного вида ничего не доказывает', () => {
    // Ровно то враньё, ради которого заведён инвариант 13: подстрока в имени
    // модели не делает контур умеющим эмбеддинги.
    const payload = { data: [{ id: 'text-embedding-3-large' }] };
    expect(findingOf(payload, 'embeddings').state).toBe('unknown');
  });

  it('агенты бесплатно не проверяются — «не объявлено» с причиной', () => {
    const agents = findingOf(declared, 'agents');
    expect(agents.state).toBe('unknown');
    expect(agents.detail).toContain('вызовом агента');
  });

  it('знания — косвенно, инструменты — нет, и оба подписаны', () => {
    expect(findingOf(declared, 'knowledge')).toMatchObject({
      state: 'indirect',
      compromise: 'kb-via-owner',
    });
    expect(findingOf(declared, 'client-tools')).toMatchObject({
      state: 'no',
      compromise: 'no-client-tools',
    });
  });

  it('проверки контента — свойство платформы: в полосе запроса', () => {
    expect(findingOf(declared, 'guardrails')).toMatchObject({ state: 'yes' });
    expect(findingOf(declared, 'guardrails').detail).toContain('451');
  });

  it('видно, ЧТО подтвердил ответ, а что известно про платформу вообще', () => {
    // Граница, на которой держится инвариант 13: «мы это увидели у ВАС» и «так
    // устроена платформа» — разные утверждения. Сливать их значит выдавать
    // непроверенное за проверенное на конкретном контуре.
    for (const id of ['models', 'chat', 'embeddings', 'agents']) {
      expect(findingOf(declared, id).evidence).toBe('answer');
    }
    for (const id of ['guardrails', 'knowledge', 'client-tools']) {
      expect(findingOf(declared, id).evidence).toBe('platform');
    }
  });

  it('известные ограничения платформы приезжают вместе с матрицей', () => {
    const reading = driverFor('enterprise-platform').read(declared);
    expect(reading.limits).toMatchObject({ nonStreamTimeoutSec: 120, managedContext: true });
  });

  it('пустой список моделей — «моделей нет», а не «чат недоступен»', () => {
    const empty = { data: [] };
    expect(findingOf(empty, 'models')).toMatchObject({ state: 'yes', count: 0 });
    expect(findingOf(empty, 'chat').state).toBe('no');
  });
});

describe('драйвер совместимого шлюза: спросить нечем — значит «не объявлено»', () => {
  const payload = { data: [{ id: 'llama-3' }] };

  it('модели есть, всё остальное не объявлено и подписано probe-guess', () => {
    const reading = driverFor('openai-compat').read(payload);
    expect(reading.compromises).toContain('probe-guess');
    expect(findingOf(payload, 'models', 'openai-compat')).toMatchObject({ state: 'yes', count: 1 });

    for (const id of ['chat', 'embeddings', 'agents', 'guardrails', 'knowledge', 'client-tools']) {
      const finding = findingOf(payload, id, 'openai-compat');
      expect(finding.state).toBe('unknown');
      expect(finding.compromise).toBe('probe-guess');
    }
  });

  it('чат тоже «не объявлено»: список моделей не доказывает, что чат работает', () => {
    // Шлюз бывает чисто эмбеддинговым. «Есть модели» и «есть чат» — разные
    // утверждения, и второе панель у произвольного шлюза не проверяла.
    expect(findingOf(payload, 'chat', 'openai-compat').state).toBe('unknown');
  });

  it('ограничений произвольного шлюза панель не выдумывает', () => {
    expect(driverFor('openai-compat').read(payload).limits).toEqual({});
  });

  it('ключ уходит в заголовок, без ключа заголовка нет вовсе', () => {
    expect(driverFor('openai-compat').headers('sk-1').authorization).toBe('Bearer sk-1');
    expect(driverFor('openai-compat').headers(undefined).authorization).toBeUndefined();
  });
});

describe('readPlatformModels: читаем объявленное, не додумываем', () => {
  it('поле, которого в ответе нет, остаётся пустым', () => {
    // Самое важное свойство файла: молчание контура остаётся молчанием. Модель
    // с «vision» в имени НЕ получает флага зрения — иначе панель пообещала бы
    // человеку то, чего контур не обещал (инвариант 13).
    const [model] = readPlatformModels({ data: [{ id: 'gpt-4o-vision-preview' }] });

    expect(model).toEqual({ id: 'gpt-4o-vision-preview' });
    expect(model!.vision).toBeUndefined();
  });

  it('объявленное `false` сохраняется: это знание, а не молчание', () => {
    const [model] = readPlatformModels({ data: [{ id: 'm', supports_vision: false }] });
    expect(model!.vision).toBe(false);
  });

  it('флаги и лимиты берутся под любым из известных имён', () => {
    const [model] = readPlatformModels({
      data: [
        {
          id: 'm',
          display_name: 'Модель',
          type: 'CHAT',
          owned_by: 'yandex',
          context_window: 32_000,
          max_output_tokens: 4_096,
          supports_function_calling: true,
          json_mode: true,
        },
      ],
    });

    expect(model).toEqual({
      id: 'm',
      name: 'Модель',
      kind: 'chat',
      ownedBy: 'yandex',
      contextLimit: 32_000,
      outputLimit: 4_096,
      functionCalling: true,
      jsonMode: true,
    });
  });

  it('вложенный объект возможностей читается наравне с плоскими полями', () => {
    const [model] = readPlatformModels({
      data: [{ id: 'm', capabilities: { supports_vision: true, context_length: 8_000 } }],
    });
    expect(model!.vision).toBe(true);
    expect(model!.contextLimit).toBe(8_000);
  });

  it('нулевой лимит — мусор, а не лимит: показывать «контекст 0» хуже, чем ничего', () => {
    const [model] = readPlatformModels({ data: [{ id: 'm', context_length: 0 }] });
    expect(model!.contextLimit).toBeUndefined();
  });

  it('имя, равное идентификатору, не дублируется в запись', () => {
    const [model] = readPlatformModels({ data: [{ id: 'm', name: 'm' }] });
    expect(model!.name).toBeUndefined();
  });

  it('запись без идентификатора и мусор в списке пропускаются молча', () => {
    const models = readPlatformModels({
      data: [{ id: '  ' }, null, 'строка', { id: 'good' }],
    });
    expect(models).toEqual([{ id: 'good' }]);
  });

  it('ответ без списка — пустой каталог, а не падение', () => {
    expect(readPlatformModels({})).toEqual([]);
    expect(readPlatformModels(null)).toEqual([]);
    expect(readPlatformModels({ data: 'нет' })).toEqual([]);
  });

  it('вид модели у платформа компании считается по объявленному полю, а не по имени', () => {
    // Модель НАЗЫВАЕТСЯ embed, но вида не объявляет: строка матрицы обязана
    // остаться «не объявлено».
    const finding = findingOf({ data: [{ id: 'ru-embed-v2' }] }, 'embeddings');
    expect(finding.state).toBe('unknown');
    expect(finding.detail).toContain('не объявлен');
  });
});
