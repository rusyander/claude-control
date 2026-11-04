import { describe, it, expect } from 'vitest';
import {
  clientToolsTravel,
  PLATFORM_PRESETS,
  platformDrivers,
} from '@agentdeck/contracts/platform-presets';
import { driverOf } from '../../features.ts';
import { nativeMessagesPath } from '../anthropic-native.ts';
import {
  anthropicRequestToOpenAi,
  chooseToolRoute,
  openAiRequestLoss,
  type Dialect,
} from '../dialect/dialect.ts';
import { StreamTranslator } from '../frames/frames.ts';
import type { HopDriver } from './driver.types.ts';

/**
 * НАБОР СООТВЕТСТВИЯ звена — строки драйвера через НАСТОЯЩИЙ мост: перевод запроса
 * (`anthropicRequestToOpenAi`, `openAiRequestLoss`) и разбор потока (`StreamTranslator`). Перенесён
 * из панели (этап 10, C3d: шлюз панели удалён); строки манифеста, проб и отказов остались у
 * панели — `apps/server/src/domains/platform/drivers/conformance/conformance.test.ts`.
 *
 * Таблица, спрашивавшая манифест о манифесте, зеленела и тогда, когда мост не делал ничего из
 * объявленного, — поэтому каждая строка подставляет драйвер в те функции, что работают на живом
 * запросе. Сети здесь нет: предмет — перевод, а не транспорт.
 */

/**
 * Каждый пресет контракта — так, как его собирает звено (`driverOf`: база + манифест пресета), а не
 * отдельный список: новый шлюз нельзя завести, не прогнав его здесь.
 */
const DRIVERS: [string, HopDriver][] = platformDrivers.map((id) => [
  id,
  driverOf({
    features: [],
    driver: PLATFORM_PRESETS[id].base,
    manifest: PLATFORM_PRESETS[id].manifest,
  }),
]);

/** Тело, которое контур мог положить в вендорный кадр: ни один прогон не выносит его клиенту. */
const VENDOR_BODY = 'vendor-verdict-body-7731';

/** Обычный чанк потока: его вендорный разбор трогать не вправе. */
const DELTA_FRAME = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: 'привет' } }],
};

/** Последний чанк со счётом токенов — тоже обычный. */
const USAGE_FRAME = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

/** Чанк с картинкой рядом с текстом: в диалекте Anthropic мост её не переносит и обязан назвать. */
const IMAGE_DELTA_FRAME = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [
    {
      index: 0,
      delta: {
        content: [
          { type: 'text', text: 'вот схема' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    },
  ],
};

/** Запрос Anthropic с инструментами: на нём проверяется судьба `tools`. */
const ANTHROPIC_REQUEST_WITH_TOOLS = {
  model: 'chat-one',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'посчитай' }],
  tools: [{ name: 'calc', description: 'счёт', input_schema: { type: 'object' } }],
  tool_choice: { type: 'auto' },
};

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Прогнать кадры через настоящий разборщик от имени этого драйвера. */
function runStream(
  driver: HopDriver,
  dialect: Dialect,
  frames: string[],
): { out: string; translator: StreamTranslator } {
  const translator = new StreamTranslator({
    dialect,
    model: 'chat-one',
    includeUsage: false,
    driver,
  });
  let out = '';
  for (const chunk of frames) out += translator.push(chunk);
  out += translator.end();
  return { out, translator };
}

describe.each(DRIVERS)('набор соответствия звена: %s', (_id, driver) => {
  it('инструменты клиента в диалекте OpenAI живут ровно так, как объявлено', () => {
    // `clientTools: 'shim'` без строки в манифесте дал бы ПУСТОЙ след при выброшенных схемах.
    const loss = openAiRequestLoss(
      { tools: ANTHROPIC_REQUEST_WITH_TOOLS.tools },
      driver.requestFields,
    );
    // Потеря — только у `shim`: `native-no-call` поле ВЕЗЁТ.
    expect(loss.some((item) => item.field === 'tools')).toBe(
      !clientToolsTravel(driver.clientTools),
    );
    for (const item of loss) expect(item.note.trim()).not.toBe('');
  });

  it('инструменты в диалекте Anthropic без прослойки: полем либо потерей с причиной', () => {
    // Маршрут — ТЕМ ЖЕ решением, что на живом запросе; проверка — по телу наверх (аудит DRV-01).
    const route = chooseToolRoute({ toolShim: false, platformTools: false }, driver, () => '');
    const { body, lost } = anthropicRequestToOpenAi(
      ANTHROPIC_REQUEST_WITH_TOOLS,
      driver.requestFields,
      route,
    );
    if (clientToolsTravel(driver.clientTools)) {
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: { name: 'calc', description: 'счёт', parameters: { type: 'object' } },
        },
      ]);
      expect(body.tool_choice).toBe('auto');
      expect(lost).toEqual([]);
      return;
    }
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(lost.find((item) => item.field === 'tools')?.note.trim()).not.toBe('');
    expect(lost.some((item) => item.field === 'tool_choice')).toBe(true);
  });

  it('прослойка не шлёт выбор инструмента без `tools`, кроме объявленного драйвером', () => {
    const route = chooseToolRoute({ toolShim: true, platformTools: false }, driver, () => 'п');
    const { body } = anthropicRequestToOpenAi(
      ANTHROPIC_REQUEST_WITH_TOOLS,
      driver.requestFields,
      route,
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBe(driver.shimRequestFields?.tool_choice);
  });

  it('обычный поток драйвер вендорным не считает', () => {
    expect(driver.readFrame(DELTA_FRAME)).toBeUndefined();
    expect(driver.readFrame(USAGE_FRAME)).toBeUndefined();
  });

  it('объявленное вендорное поле узнаётся и названо своим именем', () => {
    for (const field of driver.vendorFields) {
      const parsed = driver.readFrame({ [field]: 'что-нибудь' });
      expect(parsed, `поле ${field} объявлено, но не узнано`).toBeDefined();
      // Именем кадр вычищается, если рядом с вердиктом приехал кусок ответа.
      expect(parsed?.field).toBe(field);
    }
  });

  it('вендорный кадр не доезжает до клиента ни в одном диалекте', () => {
    for (const dialect of ['openai-compat', 'anthropic'] as const) {
      for (const field of driver.vendorFields) {
        const { out } = runStream(driver, dialect, [
          frame({ [field]: { note: VENDOR_BODY } }),
          frame(DELTA_FRAME),
          'data: [DONE]\n\n',
        ]);
        expect(out, `${field} уехал клиенту в диалекте ${dialect}`).not.toContain(field);
        expect(out).not.toContain(VENDOR_BODY);
      }
    }
  });

  it('вендорное поле рядом с обычным чанком не уезжает вместе с ним', () => {
    for (const field of driver.vendorFields) {
      // Худший случай: вердикт приехал В ОДНОМ кадре с содержимым.
      const mixed = { ...DELTA_FRAME, [field]: { note: VENDOR_BODY } };
      const { out } = runStream(driver, 'openai-compat', [frame(mixed), 'data: [DONE]\n\n']);
      expect(out, `${field} уехал клиенту рядом с содержимым`).not.toContain(field);
      expect(out).not.toContain(VENDOR_BODY);
    }
  });

  it('часть ответа, не перенесённая в чужой диалект, названа, а не обнулена', () => {
    const { out, translator } = runStream(driver, 'anthropic', [
      frame(IMAGE_DELTA_FRAME),
      'data: [DONE]\n\n',
    ]);
    expect(out).toContain('вот схема');
    expect(translator.facts.droppedParts).toContain('content[].image_url');
  });
});

/** Звено по пресету и переопределениям контура — тем же `driverOf`, что на регистрации сеанса. */
const hopDriver = (id: (typeof platformDrivers)[number], manifest = {}) =>
  driverOf({
    features: [],
    driver: PLATFORM_PRESETS[id].base,
    manifest: { ...PLATFORM_PRESETS[id].manifest, ...manifest },
  });

/** Перенесено из `apps/server/src/domains/platform/drivers/presets.test.ts` (этап 10, C3d). */
describe('пресеты у звена: объявленное доезжает до провода', () => {
  const plain = { toolShim: false, rules: { platform: { platformTools: [] } } };

  it('vLLM, LiteLLM, Ollama, OpenRouter — клиент Anthropic идёт к родной ручке', () => {
    for (const id of ['vllm', 'litellm', 'ollama', 'llama-cpp', 'openrouter'] as const)
      expect(nativeMessagesPath(plain, hopDriver(id)), id).toBe('messages');
    expect(nativeMessagesPath(plain, hopDriver('openai-compat'))).toBeUndefined();
    // Включённая прослойка сильнее манифеста: её протокол собран под мост.
    expect(nativeMessagesPath({ ...plain, toolShim: true }, hopDriver('vllm'))).toBeUndefined();
  });

  it('«полем, но модель не зовёт» — инструменты ВЕЗЁТ без потери', () => {
    const driver = hopDriver('ollama', { clientTools: 'native-no-call' });
    const route = chooseToolRoute({ toolShim: false, platformTools: false }, driver, () => '');
    expect(route).toEqual({ mode: 'native' });
    const { body, lost } = anthropicRequestToOpenAi(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'привет' }],
        tools: [{ name: 'calc', description: 'счёт', input_schema: { type: 'object' } }],
      },
      driver.requestFields,
      route,
    );
    expect(body.tools).toHaveLength(1);
    expect(lost.some((item) => item.field === 'tools')).toBe(false);
  });
});
