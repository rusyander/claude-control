import { describe, it, expect } from 'vitest';
import { PLATFORM_PRESETS, shimByClientTools } from '@agentdeck/contracts/platform-presets';
import type { PlatformDriver } from '../driver.ts';
import { allDrivers } from '../index.ts';
import { contourHeaders, contourUrl } from '../../transport/transport.ts';
import { bridgeUpstreamStatus } from '../../status/status.ts';
import { MODELS_ANSWER, SECRET_IN_BODY } from './fixtures.ts';

/**
 * НАБОР СООТВЕТСТВИЯ — одна таблица на все драйверы.
 *
 * Смысл: «легко подключать следующих» — это не обещание, а прогон. Новый
 * контур приносит файл драйвера и обязан пройти ВСЁ, что ниже; провал любой
 * строки красит `pnpm test` (инвариант 9 партии).
 *
 * Строки, гонявшие манифест через мост шлюза (перевод запроса и разбор потока), ушли вместе со
 * шлюзом в ядро (этап 10, C3d) — `apps/core/src/hop-host/gateway/drivers/conformance.test.ts`, по
 * каждому пресету контракта. Здесь — манифест, адрес и ключ, модели, возможности и перевод отказа
 * (`bridgeUpstreamStatus`). Сети по-прежнему нет — драйвер по договору в неё не ходит.
 */

/**
 * ЧТО КАЖДЫЙ ДРАЙВЕР ОБЪЯВЛЯЕТ САМ — закреплено числом.
 *
 * Пять строк ниже подставляют в мост то, что драйвер объявил: вендорные поля,
 * свои строки отказа, свои названия нарушений. У драйвера без объявлений такой
 * цикл проходит по пустому массиву — `it` зеленеет, не проверив НИЧЕГО. Восемь
 * пресетов из девяти стоят на `openai-compat` и не объявляют ничего, то есть
 * около сорока зелёных строк набора покраснеть не могут в принципе.
 *
 * Сама пустота законна: у этих контуров вендорной формы нет, и придумывать её
 * ради строки было бы театром. Незаконно — НЕ ЗНАТЬ о ней. Пресет, получивший
 * своё объявление через `PLATFORM_PRESETS[...].manifest` (механизм живой,
 * `drivers/index.ts`), обязан покраснить эту таблицу: иначе его мост так и
 * останется непроверенным, а набор — зелёным, и автор не узнает, что его
 * драйвер не гонялся ни разу.
 */
const DECLARED: Record<string, { vendorFields: number; statusRows: number; violations: number }> = {
  'enterprise-platform': { vendorFields: 4, statusRows: 4, violations: 3 },
  'openai-compat': { vendorFields: 0, statusRows: 0, violations: 0 },
  litellm: { vendorFields: 0, statusRows: 0, violations: 0 },
  vllm: { vendorFields: 0, statusRows: 0, violations: 0 },
  ollama: { vendorFields: 0, statusRows: 0, violations: 0 },
  'llama-cpp': { vendorFields: 0, statusRows: 0, violations: 0 },
  openrouter: { vendorFields: 0, statusRows: 0, violations: 0 },
  'azure-openai': { vendorFields: 0, statusRows: 0, violations: 0 },
  dashscope: { vendorFields: 0, statusRows: 0, violations: 0 },
  together: { vendorFields: 0, statusRows: 0, violations: 0 },
};

/**
 * Название проверки, каким его увидит человек, для объявленного драйвером поля.
 * `label: true` значит «поле несёт фразу», остальные — идентификатор, и
 * разборщик отсеивает всё, что на идентификатор не похоже.
 */
function violationNameFor(field: string, label: boolean | undefined): string {
  return label ? `правило «${field}» сработало` : `rule_${field}`;
}

/**
 * Элементы перечня нарушений в форме ЭТОГО драйвера — по одному на каждое
 * объявленное поле, с проверявшимся текстом в соседних значениях. Драйвер без
 * объявления возвращает пусто: его живой путь читает встроенный список, и
 * проверяет его вторая половина того же тела.
 */
function declaredViolations(driver: PlatformDriver): Record<string, string>[] {
  return (driver.violationNames ?? []).map(({ field, label }) => ({
    [field]: violationNameFor(field, label),
    // Соседние значения — то самое, ради чего проверка стояла. Мост обязан
    // взять имя и не взять их.
    text: SECRET_IN_BODY,
    input: SECRET_IN_BODY,
  }));
}

describe.each(allDrivers)('набор соответствия: $id', (driver: PlatformDriver) => {
  it('называет себя человеку', () => {
    expect(driver.title.trim()).not.toBe('');
  });

  it('объявления драйвера совпадают с закреплённой таблицей — пустой цикл не молчит', () => {
    const pinned = DECLARED[driver.id];
    expect(pinned, `драйвер ${driver.id} не записан в таблицу объявлений`).toBeDefined();
    expect({
      vendorFields: driver.vendorFields.length,
      statusRows: driver.statusRows.length,
      violations: (driver.violationNames ?? []).length,
    }).toEqual(pinned);
  });

  it('драйвер без своих строк отказа отвечает общей таблицей, а не пустотой', () => {
    if (driver.statusRows.length > 0) return;
    // Восемь пресетов из девяти сюда и попадают, и до этой строки мост на них
    // не гонялся ни разу: цикл по `statusRows` проходил по пустому массиву.
    // Ожидание записано КОДАМИ, а не «непусто»: общий откат на любой незнакомый
    // код отвечает непустой фразой всегда, и проверка «строка не пуста» зеленела
    // бы и с выломанной таблицей. 451 стоит здесь ради главного: наружу он не
    // уходит никогда — его не ждёт ни один CLI.
    const expected: Record<number, { status: number; code: string }> = {
      400: { status: 400, code: 'invalid_request_error' },
      401: { status: 401, code: 'authentication_error' },
      403: { status: 403, code: 'permission_error' },
      404: { status: 404, code: 'not_found_error' },
      429: { status: 429, code: 'rate_limit_error' },
      451: { status: 400, code: 'content_policy_violation' },
      500: { status: 502, code: 'api_error' },
    };
    for (const [upstream, want] of Object.entries(expected)) {
      const bridged = bridgeUpstreamStatus(Number(upstream), {}, { driverRows: driver.statusRows });
      expect({ status: bridged.status, code: bridged.code }, `отказ ${upstream}`).toEqual(want);
      expect(bridged.message.trim(), `текст отказа ${upstream} пуст`).not.toBe('');
      expect(bridged.status).not.toBe(451);
    }
  });

  it('драйвер без объявленных нарушений не читает чужое тело наугад', () => {
    if ((driver.violationNames ?? []).length > 0) return;
    // Тот же провал молчания с другой стороны: перечень нарушений читается
    // ТОЛЬКО там, где драйвер сказал, что он в теле есть. У этих восьми такого
    // объявления нет — значит, тело с `violations` обязано проехать мимо, и
    // проверявшийся текст не должен оказаться в отказе.
    const body = {
      message: 'запрос остановлен проверками',
      violations: [{ category: 'secrets', text: SECRET_IN_BODY }],
    };
    const bridged = bridgeUpstreamStatus(451, body, {
      driverRows: driver.statusRows,
      violationNames: driver.violationNames,
    });
    expect(bridged.violations).toEqual([]);
    expect(JSON.stringify(bridged)).not.toContain(SECRET_IN_BODY);
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

  it('умолчание прослойки нового контура совпадает с тем, как платформа принимает инструменты', () => {
    // Пресет читает мастер фронта, манифест — конвейер. Разойдясь, они включали бы
    // прослойку шлюзу, принимающему `tools` полем, или выключали её платформе компании, у
    // которой других рук нет (аудит DRV-20).
    const preset = PLATFORM_PRESETS[driver.id];
    expect(preset, `нет пресета у драйвера ${driver.id}`).toBeDefined();
    // Руки без прослойки есть только у `native`: и «поля нет» (`shim`), и «поле
    // есть, а вызовов нет» (`native-no-call`) означают одно — умолчание «включена».
    expect(preset.defaults.toolShim).toBe(shimByClientTools(driver.clientTools));
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
        // По элементу на КАЖДОЕ объявленное драйвером поле: разборщик читает у
        // элемента первое совпавшее поле и уходит, поэтому одним элементом со
        // всеми полями сразу проверилось бы только первое. Проверявшийся текст
        // лежит в соседних значениях — там, где его кладёт настоящий контур.
        // Драйвер без объявления не приносит сюда ни одного элемента.
        ...declaredViolations(driver),
      ],
    };
    for (const row of driver.statusRows) {
      const bridged = bridgeUpstreamStatus(row.upstream, body, {
        driverRows: driver.statusRows,
        // Ровно то, что передаёт живой путь (`gateway/pipeline.ts`). Без этого
        // мост откатывался бы на встроенный список полей, и объявление драйвера
        // — единственное, что здесь и проверяется, — не исполнялось бы вовсе.
        violationNames: driver.violationNames,
      });
      const all = JSON.stringify(bridged);
      // Единственное, что уезжает наружу, — НАЗВАНИЯ проверок. Проверявшийся
      // текст в теле отказа лежит рядом с ними, и любой его кусок на экране
      // панели — это вынос наружу того, ради чего проверка и стояла.
      expect(all, `отказ ${row.upstream} вынес проверявшийся текст`).not.toContain(SECRET_IN_BODY);
      if (row.violations) {
        expect(bridged.violations).toContain('secrets');
        expect(bridged.violations).toContain('internal-network');
        // И то, что объявил САМ драйвер. Без этой строки поле манифеста читал
        // бы только встроенный список, а объявление проезжало бы мимо: новый
        // контур назвал бы своё поле, набор остался бы зелёным, а на экране
        // панели перечень был бы пуст.
        for (const { field, label } of driver.violationNames ?? []) {
          expect(bridged.violations, `объявленное поле ${field} не прочитано мостом`).toContain(
            violationNameFor(field, label),
          );
        }
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
