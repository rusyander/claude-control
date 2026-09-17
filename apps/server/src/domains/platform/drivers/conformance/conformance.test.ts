import { describe, it, expect } from 'vitest';
import { PLATFORM_PRESETS } from '@agentdeck/contracts/platform-presets';
import type { PlatformDriver } from '../driver.ts';
import { allDrivers } from '../index.ts';
import { contourHeaders, contourUrl } from '../../transport.ts';
import {
  anthropicRequestToOpenAi,
  chooseToolRoute,
  openAiRequestLoss,
  type Dialect,
} from '../../gateway/dialect.ts';
import { StreamTranslator } from '../../gateway/frames.ts';
import { bridgeUpstreamStatus } from '../../gateway/status.ts';
import {
  ANTHROPIC_REQUEST_WITH_TOOLS,
  DELTA_FRAME,
  IMAGE_DELTA_FRAME,
  MODELS_ANSWER,
  SECRET_IN_BODY,
  USAGE_FRAME,
} from './fixtures.ts';

/**
 * НАБОР СООТВЕТСТВИЯ — одна таблица на все драйверы.
 *
 * Смысл: «легко подключать следующих» — это не обещание, а прогон. Новый
 * контур приносит файл драйвера и обязан пройти ВСЁ, что ниже; провал любой
 * строки красит `pnpm test` (инвариант 9 партии).
 *
 * Половина строк гоняет манифест ЧЕРЕЗ РЕАЛЬНЫЙ МОСТ, а не сверяет его поля
 * между собой. Разница не косметическая: таблица, спрашивавшая манифест о
 * манифесте, зеленела и тогда, когда мост не делал ничего из объявленного, —
 * ровно тем и была прежняя редакция. Поэтому строки драйвера подставляются в те
 * самые функции, которые работают на живом запросе: перевод запроса
 * (`anthropicRequestToOpenAi`, `openAiRequestLoss`), разбор потока
 * (`StreamTranslator`) и перевод отказа (`bridgeUpstreamStatus`). Сети здесь
 * по-прежнему нет — драйвер по договору в неё не ходит.
 */

/** Кадр потока в проводном виде. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Прогнать кадры через настоящий разборщик от имени этого драйвера. */
function runStream(
  driver: PlatformDriver,
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

describe.each(allDrivers)('набор соответствия: $id', (driver: PlatformDriver) => {
  it('называет себя человеку', () => {
    expect(driver.title.trim()).not.toBe('');
  });

  it('адрес моделей не удваивает версию', () => {
    const url = (baseUrl: string): string | undefined =>
      contourUrl({ baseUrl, driver: driver.id }, 'models');
    expect(url('https://api.example.ru')).toBe('https://api.example.ru/v1/models');
    expect(url('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/models');
    // Хвостовой слэш — самый частый вид адреса из буфера обмена.
    expect(url('https://api.example.ru/')).toBe('https://api.example.ru/v1/models');
  });

  it('заголовок ключа объявлен токеном HTTP в нижнем регистре', () => {
    expect(driver.auth.header).toMatch(/^[a-z0-9-]+$/);
  });

  it('ключ уходит только в заголовки и только когда он есть', () => {
    const withKey = JSON.stringify(contourHeaders({ baseUrl: '', driver: driver.id }, 'секрет'));
    expect(withKey).toContain('секрет');
    // Без ключа заголовка авторизации быть не должно: пустой Bearer читается
    // контуром как «ключ неверный», а человеком — как «панель сломалась».
    const without = contourHeaders({ baseUrl: '', driver: driver.id }, undefined);
    expect(JSON.stringify(without).toLowerCase()).not.toContain('bearer');
    expect(without[driver.auth.header]).toBeUndefined();
  });

  // Аудит DRV-04: заголовок ключа назначается настройкой, а не драйвером навсегда.
  it('свой заголовок ключа заменяет драйверный, а не добавляется к нему', () => {
    // Свой — заведомо не драйверный: у пресета Azure драйверный и есть `api-key`.
    const own = driver.auth.header === 'api-key' ? 'x-api-key' : 'api-key';
    const headers = contourHeaders(
      {
        baseUrl: '',
        driver: driver.id,
        transport: {
          authHeader: own,
          authScheme: '',
          version: 'auto',
          query: '',
          headers: '',
        },
      },
      'секрет',
    );
    expect(headers[own]).toBe('секрет');
    expect(headers[driver.auth.header]).toBeUndefined();
  });

  it('читает модели из ответа OpenAI-формы', () => {
    const reading = driver.read(MODELS_ANSWER);
    expect(reading.models.map((model) => model.id)).toEqual(['chat-one', 'embed-one']);
    // Объявленное платформой поле читается, невыдуманное — остаётся пустым.
    expect(reading.models[0]?.contextLimit).toBe(32000);
    expect(reading.models[1]?.vision).toBeUndefined();
  });

  it('мусор вместо ответа не превращается в утверждение', () => {
    for (const payload of [null, {}, { data: 'не массив' }, { data: [{}] }]) {
      const reading = driver.read(payload);
      expect(reading.models).toEqual([]);
      // Матрица возможностей при этом всё равно заполнена: «не объявлено» —
      // тоже ответ, а пустая матрица читалась бы как «панель не проверяла».
      expect(reading.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('каждая возможность названа состоянием, доказательством и словами', () => {
    const reading = driver.read(MODELS_ANSWER);
    for (const finding of reading.capabilities) {
      expect(['yes', 'no', 'indirect', 'unknown']).toContain(finding.state);
      expect(['answer', 'platform']).toContain(finding.evidence);
      expect(finding.detail.trim()).not.toBe('');
    }
  });

  it('судьба каждого поля названа и объяснена', () => {
    for (const row of driver.requestFields) {
      expect(['anthropic', 'openai']).toContain(row.dialect);
      expect(row.field.trim()).not.toBe('');
      expect(['mapped', 'renamed', 'lossy', 'dropped']).toContain(row.fate);
      // Потеря без причины — это «исчезло молча», то есть ровно то, против чего
      // таблица и заведена.
      expect(row.note.trim()).not.toBe('');
      // Переименование без нового имени — судьба без кода за ней (DRV-18).
      if (row.fate === 'renamed') {
        expect(row.to.trim()).not.toBe('');
        expect(row.to).not.toBe(row.field);
      }
    }
  });

  it('родная ручка Anthropic, если объявлена, — путь относительно версии', () => {
    if (!driver.anthropic) return;
    expect(driver.anthropic.messages).toMatch(/^[a-z0-9][a-z0-9/_-]*$/);
  });

  it('предел цельного ответа, если объявлен, — положительное число секунд', () => {
    if (driver.nonStreamTimeoutSec === undefined) return;
    expect(Number.isFinite(driver.nonStreamTimeoutSec)).toBe(true);
    expect(driver.nonStreamTimeoutSec).toBeGreaterThan(0);
  });

  it('потолок любого ответа, если объявлен, — положительное число секунд', () => {
    if (driver.responseCeilingSec === undefined) return;
    expect(Number.isFinite(driver.responseCeilingSec)).toBe(true);
    expect(driver.responseCeilingSec).toBeGreaterThan(0);
  });

  it('инструменты клиента в диалекте OpenAI живут ровно так, как объявлено', () => {
    // Не сверка двух полей манифеста, а прогон через ту самую функцию, которая
    // считает потери живого запроса: `clientTools: 'shim'` без строки в
    // манифесте даёт ПУСТОЙ след при выброшенных схемах — панель обещает агенту
    // руки и молчит о том, что их нет.
    const loss = openAiRequestLoss(
      { tools: ANTHROPIC_REQUEST_WITH_TOOLS.tools },
      driver.requestFields,
    );
    expect(loss.some((item) => item.field === 'tools')).toBe(driver.clientTools !== 'native');
    for (const item of loss) expect(item.note.trim()).not.toBe('');
  });

  it('инструменты в диалекте Anthropic без прослойки: полем либо потерей с причиной', () => {
    // Маршрут выбирается ТЕМ ЖЕ решением, что на живом запросе, и проверяется по
    // телу, уходящему наверх. Прежняя строка здесь закрепляла потерю у всех
    // драйверов «хоть трижды passthrough» — и зеленела, пока совместимый шлюз
    // оставался без рук (аудит DRV-01).
    const route = chooseToolRoute({ toolShim: false, platformTools: false }, driver, () => '');
    const { body, lost } = anthropicRequestToOpenAi(
      ANTHROPIC_REQUEST_WITH_TOOLS,
      driver.requestFields,
      route,
    );
    if (driver.clientTools === 'native') {
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
    const tools = lost.find((item) => item.field === 'tools');
    expect(tools?.note.trim()).not.toBe('');
    expect(lost.some((item) => item.field === 'tool_choice')).toBe(true);
  });

  it('умолчание прослойки нового контура совпадает с тем, как платформа принимает инструменты', () => {
    // Пресет читает мастер фронта, манифест — конвейер. Разойдясь, они включали бы
    // прослойку шлюзу, принимающему `tools` полем, или выключали её платформе компании, у
    // которой других рук нет (аудит DRV-20).
    const preset = PLATFORM_PRESETS[driver.id];
    expect(preset, `нет пресета у драйвера ${driver.id}`).toBeDefined();
    expect(preset.defaults.toolShim).toBe(driver.clientTools === 'shim');
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
    expect(driver.readFrame(JSON.parse(DELTA_FRAME))).toBeUndefined();
    expect(driver.readFrame(JSON.parse(USAGE_FRAME))).toBeUndefined();
  });

  it('объявленное вендорное поле узнаётся и названо своим именем', () => {
    for (const field of driver.vendorFields) {
      const parsed = driver.readFrame({ [field]: 'что-нибудь' });
      // Иначе цельный ответ разложился бы в кадр, который разборщик потока
      // считает незнакомым: поле объявлено в одном месте и не узнано в другом.
      expect(parsed, `поле ${field} объявлено, но не узнано`).toBeDefined();
      // Именем кадр вычищается, если рядом с вердиктом приехал кусок ответа.
      // Разойдясь с объявленным, оно оставило бы вендорный ключ в теле клиента.
      expect(parsed?.field).toBe(field);
    }
  });

  it('вендорный кадр не доезжает до клиента ни в одном диалекте', () => {
    for (const dialect of ['openai-compat', 'anthropic'] as const) {
      for (const field of driver.vendorFields) {
        const { out } = runStream(driver, dialect, [
          frame({ [field]: { note: SECRET_IN_BODY } }),
          frame(JSON.parse(DELTA_FRAME)),
          'data: [DONE]\n\n',
        ]);
        expect(out, `${field} уехал клиенту в диалекте ${dialect}`).not.toContain(field);
        expect(out).not.toContain(SECRET_IN_BODY);
      }
    }
  });

  it('вендорное поле рядом с обычным чанком не уезжает вместе с ним', () => {
    for (const field of driver.vendorFields) {
      // Худший случай формы: вердикт приехал В ОДНОМ кадре с содержимым. Читать
      // такой кадр как обычный чанк значит отдать клиенту служебное тело.
      const mixed = {
        ...JSON.parse(DELTA_FRAME),
        [field]: { note: SECRET_IN_BODY },
      };
      const { out } = runStream(driver, 'openai-compat', [frame(mixed), 'data: [DONE]\n\n']);
      expect(out, `${field} уехал клиенту рядом с содержимым`).not.toContain(field);
      expect(out).not.toContain(SECRET_IN_BODY);
    }
  });

  it('часть ответа, не перенесённая в чужой диалект, названа, а не обнулена', () => {
    const { out, translator } = runStream(driver, 'anthropic', [
      frame(JSON.parse(IMAGE_DELTA_FRAME)),
      'data: [DONE]\n\n',
    ]);
    // Текст доезжает целиком...
    expect(out).toContain('вот схема');
    // ...а картинка, которой в диалекте Anthropic не будет, названа человеку.
    // Молча обнулённая, она и есть ответ, в котором человек видит пустоту и не
    // знает, что она была.
    expect(translator.facts.droppedParts).toContain('content[].image_url');
  });

  it('своя строка отказа отвечает клиенту ровно тем, что объявила', () => {
    for (const row of driver.statusRows) {
      expect(row.upstream).toBeGreaterThanOrEqual(400);
      expect(row.code.trim()).not.toBe('');
      expect(row.message.trim()).not.toBe('');

      const bridged = bridgeUpstreamStatus(row.upstream, {}, { driverRows: driver.statusRows });
      // Строка драйвера обязана лечь ПОВЕРХ общей таблицы: иначе объявленная
      // причина («401 у этого контура значит пять разных вещей») до человека не
      // доходит, а он читает общую фразу и идёт чинить не то.
      expect(bridged.status).toBe(row.status);
      expect(bridged.code).toBe(row.code);
      expect(bridged.status).toBeGreaterThanOrEqual(400);
      expect(bridged.status).toBeLessThan(600);
      // 451 наружу не отдаётся никогда: ни один CLI его не ждёт.
      expect(bridged.status).not.toBe(451);
    }
  });

  it('перечень нарушений читается только там, где он объявлен, и без текста запроса', () => {
    const body = {
      // Фраза контура доверенная: она приходит по-русски и уже вычищена на его
      // стороне (справочник §8), мост показывает её как есть. Проверяется здесь
      // не она, а ПЕРЕЧЕНЬ, в котором рядом с названиями лежит проверявшийся
      // текст — и вот его наружу не выпускает уже мост.
      message: 'запрос остановлен проверками',
      violations: [
        { category: 'secrets', text: SECRET_IN_BODY },
        SECRET_IN_BODY,
        'internal-network',
      ],
    };
    for (const row of driver.statusRows) {
      const bridged = bridgeUpstreamStatus(row.upstream, body, { driverRows: driver.statusRows });
      const all = JSON.stringify(bridged);
      // Единственное, что уезжает наружу, — НАЗВАНИЯ проверок. Проверявшийся
      // текст в теле отказа лежит рядом с ними, и любой его кусок на экране
      // панели — это вынос наружу того, ради чего проверка и стояла.
      expect(all, `отказ ${row.upstream} вынес проверявшийся текст`).not.toContain(SECRET_IN_BODY);
      if (row.violations) {
        expect(bridged.violations).toContain('secrets');
        expect(bridged.violations).toContain('internal-network');
      } else {
        expect(bridged.violations).toEqual([]);
      }
    }
  });

  it('путь картинок назван одним из трёх, и у ручки объявлен путь', () => {
    if (typeof driver.images === 'object') {
      // Путь относительно версии: ведущая черта или адрес целиком обошли бы
      // транспорт контура (прокси, свои заголовки) так же, как угаданный.
      expect(driver.images.api).toMatch(/^[a-z0-9][a-z0-9/_-]*$/);
    } else {
      expect(['chat-part', 'none']).toContain(driver.images);
    }
  });

  it('усилие рассуждения объявлено, а не подразумевается', () => {
    expect(typeof driver.effort).toBe('boolean');
  });

  it('агенты объявлены путями под версией API либо не объявлены вовсе', () => {
    if (!driver.agents) return;
    for (const path of [driver.agents.completions, driver.agents.sessions]) {
      // Ведущий `/` или версия в пути удвоили бы то, что дописывает `callUpstream`.
      expect(path).toMatch(/^[a-z][a-z0-9_/-]*[a-z0-9]$/);
      expect(path).not.toMatch(/^v\d/);
    }
  });

  it('у каждой ручки есть механизм и слова', () => {
    for (const control of driver.controls) {
      expect(control.id.trim()).not.toBe('');
      expect(control.title.trim()).not.toBe('');
      expect(['request', 'observed']).toContain(control.kind);
      // Ручка без объяснения на экран не выводится — значит и объявлять её
      // незачем (Р5).
      expect(control.detail.trim()).not.toBe('');
    }
    const ids = driver.controls.map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('пробный запрос короткий и непустой', () => {
    expect(driver.smokePrompt.trim()).not.toBe('');
    // Он уходит в модель за деньги ключа: длинный пробник — это счёт за то,
    // что доказывается одной строкой.
    expect(driver.smokePrompt.length).toBeLessThan(120);
  });
});
