import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import { AppStore } from '../../lib/app-store.ts';
import { promptText, savePrompt } from '../prompts.ts';
import { buildManagedProfile } from './apply/profile.ts';
import { writePlatform, writeToken } from './store.ts';
import {
  contourIdentity,
  describeRunPlan,
  listConsumerOptions,
  resolveRunRoute,
  runRouteOf,
  type PlatformRoutingDeps,
} from './routing.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Маршрут в момент запуска: кто идёт через контур и с каким окружением.
 *
 * Таблица здесь проверяет РЕШЕНИЕ, а не запуск: что прогон с отмеченной
 * галочкой получает адрес шлюза, что снятая галочка возвращает его провайдеру
 * по умолчанию, и что каждый отказ назван своей причиной. Настоящий процесс с
 * этими переменными проверяется живым прогоном (`.agent/tmp/t3-routing-live.mjs`):
 * таблица доказала бы только саму себя.
 */

const SECRET = 'CONTOUR-KEY-CORPORATE-4f21';

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  consumers: ['chat'],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

let root: string;
let dir: string;
let store: AppStore;
let deps: PlatformRoutingDeps;

/** Контур, сохранённый и активный, с ключом и поднятым шлюзом. */
function connect(platform: Platform = PLATFORM, port = 5179): void {
  writePlatform(store, platform);
  writeToken(dir, platform.id, SECRET);
  store.updateSettings({ activePlatformId: platform.id });
  deps.gatewayPort = () => port;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-routing-'));
  dir = join(root, 'agentdeck');
  mkdirSync(dir, { recursive: true });
  store = new AppStore(dir);
  deps = { store, appDataDir: dir, gatewayPort: () => 5179 };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('прогон через контур', () => {
  it('отмеченный потребитель получает адрес шлюза, заглушку ключа и модель профиля', () => {
    connect();
    // Модель берётся из управляемого профиля — то есть из того выбора, который
    // человек сделал в панели, а не из имени модели вендора.
    store.updateSettings({
      endpointProfiles: [
        buildManagedProfile(
          PLATFORM,
          { enabled: true, port: 5179, forceStream: true },
          'qwen2.5:7b',
        ),
      ],
    });

    const decision = resolveRunRoute(deps, 'chat');

    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    expect(decision.platformId).toBe('company-dev');
    // Клиент anthropic дописывает `/v1` сам: адрес с версией дал бы
    // `/v1/v1/messages` на первом же запросе.
    expect(decision.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5179/company-dev');
    expect(decision.env.ANTHROPIC_MODEL).toBe('qwen2.5:7b');
    // Настоящий ключ контура не уходит в окружение НИКОГДА: его подставляет
    // шлюз, в этом весь смысл конструкции.
    expect(decision.env.ANTHROPIC_AUTH_TOKEN).toBe('panel-contour-no-key-needed');
    expect(JSON.stringify(decision.env)).not.toContain(SECRET);
  });

  it('свой промпт контура едет маршрутом — из каталога, а не строкой в коде (Т5.4а)', () => {
    connect();
    const decision = resolveRunRoute(deps, 'chat');

    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    // Текст ровно тот, которым панель работает: правка человека в разделе
    // «Промпты» меняет и его, поэтому сверяем с каталогом, а не с образцом.
    expect(decision.systemPrompt).toContain(promptText(dir, 'contour-agent').trim());
    expect(decision.systemPrompt).toContain('инструмент');
  });

  /**
   * Аудит MD-06: преамбула контура лежала в каталоге, человек мог её править —
   * и ни один прогон её не читал. Правка, которая ничего не меняет, хуже
   * отсутствия поля: человек решает, что модель слушает его текст.
   */
  it('преамбула контура едет прогону следом за промптом агента', () => {
    connect();
    const decision = resolveRunRoute(deps, 'chat');
    if (!decision.routed) throw new Error('маршрут не собран');
    const agent = promptText(dir, 'contour-agent').trim();
    const preamble = promptText(dir, 'contour-preamble').trim();
    expect(decision.systemPrompt).toBe(`${agent}\n\n${preamble}\n\n${identity()}`);
  });

  /** Строка «кто отвечает» при прогоне без названной модели — её собирает сам маршрут. */
  const identity = (): string => contourIdentity(PLATFORM.title, '');

  /**
   * Живой прогон 14.09.2026: Qwen3.8 через dev-стенд Company назвалась Claude
   * Opus 5 — промпт контура заменил промпт CLI и не сказал, кто отвечает.
   */
  it('промпт контура называет модель и контур, которыми идёт прогон', () => {
    connect();
    const decision = resolveRunRoute(deps, 'chat', 'qwen-test');
    if (!decision.routed) throw new Error('маршрут не собран');
    expect(decision.systemPrompt).toContain('модель qwen-test');
    expect(decision.systemPrompt).toContain(`«${PLATFORM.title}»`);
    expect(decision.systemPrompt).toContain('Ты не Claude');
  });

  it('правка человека в каталоге едет прогону, а не встроенный текст', () => {
    connect();
    savePrompt(dir, 'contour-agent', 'короткий свой промпт');
    savePrompt(dir, 'contour-preamble', 'своя преамбула');
    const decision = resolveRunRoute(deps, 'chat');
    expect(decision.routed && decision.systemPrompt).toBe(
      `короткий свой промпт\n\nсвоя преамбула\n\n${identity()}`,
    );
  });

  it('пустая правка преамбулы снимает только её, промпт агента остаётся', () => {
    connect();
    savePrompt(dir, 'contour-preamble', '   ');
    const decision = resolveRunRoute(deps, 'chat');
    expect(decision.routed && decision.systemPrompt).toBe(
      `${promptText(dir, 'contour-agent').trim()}\n\n${identity()}`,
    );
  });

  it('выключенный переключатель возвращает прогон к промпту CLI', () => {
    // Промпта в маршруте нет ВОВСЕ, а не пустая строка: прогон обязан уйти без
    // `--system-prompt-file`, то есть ровно с тем промптом, что был до контура.
    connect({ ...PLATFORM, contourPrompt: false });
    const decision = resolveRunRoute(deps, 'chat');
    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    expect(decision.systemPrompt).toBeUndefined();
    // Адрес шлюза при этом на месте: выключен промпт, а не маршрут.
    expect(decision.env.ANTHROPIC_BASE_URL).toContain('127.0.0.1');
  });

  it('порт берётся у живого слушателя, а не из настроек', () => {
    connect(PLATFORM, 5182);
    const decision = resolveRunRoute(deps, 'chat');
    expect(decision.routed && decision.env.ANTHROPIC_BASE_URL).toBe(
      'http://127.0.0.1:5182/company-dev',
    );
  });

  it('снятая галочка — прогон идёт провайдером по умолчанию', () => {
    connect({ ...PLATFORM, consumers: ['assistant'] });
    expect(resolveRunRoute(deps, 'chat')).toEqual({ routed: false, reason: 'consumer_off' });
    // А группы разделения и агент тестов — отдельные потребители, и общего
    // «включено для чата» им не достаётся.
    connect({ ...PLATFORM, consumers: ['chat'] });
    expect(resolveRunRoute(deps, 'groups')).toEqual({ routed: false, reason: 'consumer_off' });
    expect(resolveRunRoute(deps, 'tests')).toEqual({ routed: false, reason: 'consumer_off' });
  });

  it('группы и тесты ходят своими галочками', () => {
    connect({ ...PLATFORM, consumers: ['groups', 'tests'] });
    expect(resolveRunRoute(deps, 'groups').routed).toBe(true);
    expect(resolveRunRoute(deps, 'tests').routed).toBe(true);
    expect(resolveRunRoute(deps, 'chat').routed).toBe(false);
  });

  it('нет активного контура — маршрута нет даже при отмеченной галочке', () => {
    writePlatform(store, PLATFORM);
    writeToken(dir, PLATFORM.id, SECRET);
    expect(resolveRunRoute(deps, 'chat')).toEqual({ routed: false, reason: 'no_active_platform' });
  });

  it('погашенный шлюз и потерянный ключ названы по-разному', () => {
    connect(PLATFORM, 0);
    expect(resolveRunRoute(deps, 'chat')).toMatchObject({ routed: false, reason: 'gateway_down' });

    connect();
    writeToken(dir, PLATFORM.id, '');
    expect(resolveRunRoute(deps, 'chat')).toMatchObject({ routed: false, reason: 'no_token' });
  });

  /**
   * Живое подключение 14.09.2026: активный обязательный контур с галочкой «Чат»
   * при погашенном шлюзе отдавал пустой маршрут — и чат уходил в облако вендора,
   * ровно то, чего «обязательно» обещает не делать.
   */
  it('обязательный контур без шлюза или ключа — отказ прогону, а не проход мимо', () => {
    connect(PLATFORM, 0);
    const down = resolveRunRoute(deps, 'chat');
    expect(!down.routed && down.refusal).toContain('Контур «Company · dev» обязателен');
    expect(!down.routed && down.refusal).toContain('шлюз панели не поднят');
    // Совет — ровно к своей причине: кнопка на карточке, а не три перехода в мастер.
    expect(!down.routed && down.refusal).toContain('«Поднять шлюз» на карточке контура');
    expect(describeRunPlan(deps, 'chat')).toMatchObject({ routed: false, refused: true });

    connect();
    writeToken(dir, PLATFORM.id, '');
    const noKey = resolveRunRoute(deps, 'chat');
    expect(!noKey.routed && noKey.refusal).toContain('ключ контура не сохранён');
    // Без ключа шлюз поднимать бесполезно — совет про ключ, а не про шлюз.
    expect(!noKey.routed && noKey.refusal).toContain('шаг «Ключ»');
    expect(!noKey.routed && noKey.refusal).not.toContain('Поднять шлюз');

    // Снятая галочка — не отказ: этот потребитель в контур и не просился.
    connect({ ...PLATFORM, consumers: [] }, 0);
    expect(resolveRunRoute(deps, 'chat')).toEqual({ routed: false, reason: 'consumer_off' });
  });

  it('«по возможности» оставляет проход мимо контура без отказа', () => {
    connect({ ...PLATFORM, mode: 'best-effort' }, 0);
    expect(resolveRunRoute(deps, 'chat')).toEqual({ routed: false, reason: 'gateway_down' });
    expect(describeRunPlan(deps, 'chat').refused).toBeUndefined();
    // Решение по контуру №4: режим живёт, только пока уход мимо контура назван в
    // шапке. План говорит это полем, причину — словом, которым шапка его объяснит.
    expect(describeRunPlan(deps, 'chat')).toMatchObject({
      routed: false,
      bypassed: true,
      reason: 'gateway_down',
    });

    connect({ ...PLATFORM, mode: 'best-effort' });
    writeToken(dir, PLATFORM.id, '');
    expect(describeRunPlan(deps, 'chat')).toMatchObject({ bypassed: true, reason: 'no_token' });

    // Мимо контура по собственной галочке человека — не уход, а выбор: молчим.
    connect({ ...PLATFORM, mode: 'best-effort', consumers: [] }, 0);
    expect(describeRunPlan(deps, 'chat').bypassed).toBeUndefined();
    // Обязательный отказывает, а не уходит: подпись отказа, не ухода.
    connect(PLATFORM, 0);
    expect(describeRunPlan(deps, 'chat').bypassed).toBeUndefined();
  });

  it('ассистент и терминал — не прогоны: у них свои пути', () => {
    connect({ ...PLATFORM, consumers: ['assistant', 'terminal'] });
    // Ассистент ходит управляемым профилем, терминал — файлами CLI. Выдать им
    // окружение прогона значило бы сделать работу дважды и по-разному.
    expect(resolveRunRoute(deps, 'assistant')).toEqual({ routed: false, reason: 'not_a_run' });
    expect(resolveRunRoute(deps, 'terminal')).toEqual({ routed: false, reason: 'not_a_run' });
  });

  it('чужой CLI с переменной адреса идёт своим диалектом', () => {
    connect({ ...PLATFORM, consumers: ['foreign:qwen'] });
    const decision = resolveRunRoute(deps, 'foreign:qwen');
    expect(decision.routed).toBe(true);
    // У qwen задокументирован openai-совместимый раздел, и шлюзу он родной:
    // адрес отдаётся вместе с версией.
    expect(decision.routed && decision.env.OPENAI_BASE_URL).toBe(
      'http://127.0.0.1:5179/company-dev/v1',
    );
  });

  /**
   * Слои Т8 — флаги CLI Claude, и только его. Чужой CLI, получив
   * `--setting-sources`, не пошёл бы «без наших правил»: он отказал бы ЗАПУСКОМ,
   * и человек читал бы это как поломку контура.
   */
  it('наши слои едут прогону Claude и не едут чужому CLI', () => {
    const stripped = {
      ...PLATFORM,
      consumers: ['chat', 'foreign:qwen'],
      rules: { platform: defaultPlatformRules(), ours: { ...defaultOurRules(), skills: false } },
    };
    connect(stripped);

    const own = resolveRunRoute(deps, 'chat');
    expect(own.routed && own.layers).toEqual({
      args: ['--disable-slash-commands'],
      systemPrompt: true,
      dropped: ['skills'],
    });

    const foreign = resolveRunRoute(deps, 'foreign:qwen');
    expect(foreign.routed).toBe(true);
    expect(foreign.routed && foreign.layers).toBeUndefined();
  });

  /**
   * Проекция решения в то, что получает место спавна. Ревью Т13: её исполнял
   * ТОЛЬКО живой запуск панели (замыкание в `bootstrap/runtime.ts`), и удаление
   * строки `layers` или `model` оставляло гейт зелёным — прогон молча уходил бы
   * со всеми нашими слоями и с именем вендора, которого контур не знает.
   * Решения здесь настоящие: их считает тот же `resolveRunRoute`.
   */
  describe('решение → маршрут места спавна', () => {
    it('модель, усилие, промпт и снятые слои доезжают до места спавна', () => {
      const stripped = {
        ...PLATFORM,
        rules: { platform: defaultPlatformRules(), ours: { ...defaultOurRules(), skills: false } },
      };
      connect(stripped);
      savePrompt(dir, 'contour-agent', 'Отвечай коротко.');

      const decision = resolveRunRoute(deps, 'chat', 'sonnet');
      const route = runRouteOf(decision);

      expect(route.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5179/company-dev');
      expect(route.model).toEqual(decision.routed && decision.model);
      expect(route.effort).toBe(decision.routed && decision.effort);
      expect(route.systemPrompt).toContain('Отвечай коротко.');
      expect(route.layers).toEqual({
        args: ['--disable-slash-commands'],
        systemPrompt: true,
        dropped: ['skills'],
      });
      // Признак контура наружу не течёт: место спавна знает маршрут, а не то,
      // какой именно контур его выдал.
      expect('platformId' in route).toBe(false);
    });

    it('не через контур — пустой маршрут, который затирает прежний', () => {
      connect({ ...PLATFORM, consumers: ['tests'] });

      const route = runRouteOf(resolveRunRoute(deps, 'chat'));

      // Ни модели, ни усилия, ни слоёв: продолжение остановленного прогона
      // приходит со старыми параметрами, и адрес контура пережил бы снятую
      // галочку.
      expect(route).toEqual({ env: {} });
    });

    it('обязательный контур без шлюза — отказ доезжает текстом, а не пустотой', () => {
      connect(PLATFORM, 0);

      const route = runRouteOf(resolveRunRoute(deps, 'chat'));

      expect(route.env).toEqual({});
      expect(route.refusal).toContain('Контур «Company · dev» обязателен');
      expect(route.model).toBeUndefined();
    });
  });

  it('CLI, который держит адрес в файле, отказывает с «только глобально»', () => {
    connect({ ...PLATFORM, consumers: ['foreign:codex', 'foreign:gemini'] });
    // Файл один на машину: «включить только для чата» там не получается
    // физически, и панель говорит это словом.
    expect(resolveRunRoute(deps, 'foreign:codex')).toEqual({ routed: false, reason: 'file_only' });
    // Gemini — другое: адрес задать можно, но шлюз его диалекта не знает.
    expect(resolveRunRoute(deps, 'foreign:gemini')).toEqual({
      routed: false,
      reason: 'gateway_dialect',
    });
  });

  it('CLI без своего чата в панели маршрута не получает — тем же правилом, что и каталог', () => {
    // Ревью Т13: каталог пропускает провайдера без `oneShotArgs` («галочка, за
    // которой не запускается ничего»), а решатель раньше смотрел только на
    // «известен ли id». Сохранённый мимо мастера `foreign:cursor` получил бы
    // полное окружение контура в тот день, когда провайдеру допишут секцию
    // переменных, — без единой галочки на экране.
    connect({ ...PLATFORM, consumers: ['foreign:cursor'] });
    expect(resolveRunRoute(deps, 'foreign:cursor')).toEqual({ routed: false, reason: 'not_a_run' });
    // Второе полукольцо того же правила: в списке мастера его тоже нет.
    expect(
      listConsumerOptions({ ...PLATFORM, consumers: ['foreign:cursor'] }).map((item) => item.id),
    ).not.toContain('foreign:cursor');
  });

  it('контура нет вовсе — об этом и сказано, а не про устаревший CLI', () => {
    // Порядок проверок: диагноз про потребителя ниже «контура нет». Иначе
    // панель без единого контура отвечала бы про `foreign:<cli>` словом, к её
    // состоянию отношения не имеющим (ревью Т13).
    store.updateSettings({ activePlatformId: '' });
    expect(resolveRunRoute(deps, 'foreign:nosuchcli')).toEqual({
      routed: false,
      reason: 'no_active_platform',
    });
  });

  it('неизвестный потребитель маршрута не получает', () => {
    connect({ ...PLATFORM, consumers: ['foreign:nosuchcli'] });
    // Своё слово, а не `not_a_run`: это прогон, просто CLI такого панель не знает
    // (устаревший архив, провайдер убран из реестра). «Ходит не процессом» здесь
    // было бы неправдой о потребителе.
    expect(resolveRunRoute(deps, 'foreign:nosuchcli')).toEqual({
      routed: false,
      reason: 'unknown_provider',
    });
  });
});

describe('модель и усилие прогона (Т6)', () => {
  it('имя, названное прогоном, переводится картой — и в окружение, и в ответ', () => {
    // Ради этого Т6 и писался: «sonnet» уходит в `--model`, перебивает адресную
    // переменную и доезжает до контура именем вендора — 403 «модель» на каждом
    // сообщении, невидимый ровно до расхождения имён.
    connect({ ...PLATFORM, defaultModel: 'company-mid', modelMap: { sonnet: 'company-small' } });

    const decision = resolveRunRoute(deps, 'chat', 'sonnet');

    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    expect(decision.model).toEqual({
      model: 'company-small',
      asked: 'sonnet',
      source: 'mapped',
      replaced: true,
    });
    // Одно и то же имя в переменной окружения и в ответе маршрута: расхождение
    // означало бы, что шапка чата показывает не то, чем прогон пошёл.
    expect(decision.env.ANTHROPIC_MODEL).toBe('company-small');
  });

  it('незнакомое имя заменяется моделью потребителя, а не уезжает как есть', () => {
    connect({
      ...PLATFORM,
      consumers: ['chat', 'tests'],
      defaultModel: 'company-mid',
      consumerModels: { tests: 'company-small' },
    });

    const tests = resolveRunRoute(deps, 'tests', 'haiku');
    expect(tests.routed && tests.model).toMatchObject({
      model: 'company-small',
      source: 'consumer',
      replaced: true,
    });
    // Чат при этом идёт моделью контура: переопределение — на потребителя.
    const chat = resolveRunRoute(deps, 'chat');
    expect(chat.routed && chat.env.ANTHROPIC_MODEL).toBe('company-mid');
  });

  it('контур не принимает усилие — маршрут говорит это словом', () => {
    // compromise: no-effort — панель не отправляет `--effort` вовсе (решение
    // владельца 12.09.2026): контур его не примет, а человек заплатит за
    // глубину, которой не будет.
    connect();
    const decision = resolveRunRoute(deps, 'chat');
    expect(decision.routed && decision.effort).toBe(false);
  });
});

describe('чем пойдёт прогон, если запустить сейчас', () => {
  it('маршрут есть — отдаются правила целиком, чтобы шапка считала тем же кодом', () => {
    connect({ ...PLATFORM, defaultModel: 'company-mid', modelMap: { sonnet: 'company-small' } });

    const plan = describeRunPlan(deps, 'chat');

    expect(plan).toEqual({
      routed: true,
      title: 'Company · dev',
      rules: {
        model: 'company-mid',
        source: 'default',
        map: { sonnet: 'company-small' },
        catalog: [],
      },
      effort: false,
      // Слои (Т8) — тем же ответом: шапка обязана сказать о снятых ДО отправки
      // сообщения, иначе «агент не читает мои правила» выглядит поломкой агента.
      layers: { args: [], systemPrompt: true, dropped: [] },
      // Путь инструментов: чат по нему называет вызов текстом при выключенной прослойке.
      toolRoute: 'shim',
    });
    // Правила отдаются целиком именно для этого: клиент пересчитывает выбор на
    // каждое переключение модели сам, той же функцией контрактов.
    expect(plan.routed && chooseRunModel(plan.rules, 'sonnet').model).toBe('company-small');
  });

  it('маршрута нет — причина названа, а усилие остаётся выбором человека', () => {
    connect({ ...PLATFORM, consumers: [] });
    const plan = describeRunPlan(deps, 'chat');
    expect(plan.routed).toBe(false);
    expect(plan.reason).toBe('consumer_off');
    // `effort: true` здесь — не «контур принимает», а «контур ни при чём»:
    // подпись о потерянной глубине в обычном разговоре была бы враньём.
    expect(plan.effort).toBe(true);
    expect(plan.rules).toEqual({ model: '', source: 'none', map: {}, catalog: [] });
  });
});

describe('подстановка для контуров, заведённых до Т3', () => {
  it('поля нет вовсе — контур делает ровно то, что делал: ассистент и терминал', () => {
    // Так выглядит запись из `settings.json` с прошлой версии панели: цели
    // выбраны, потребителей не существует.
    const legacy = { ...PLATFORM, targets: ['assistant', 'claude'] } as Platform;
    delete (legacy as { consumers?: string[] }).consumers;
    connect(legacy);

    // Чат НЕ уезжает в контур сам: до Т3 ни один прогон через него не шёл.
    expect(resolveRunRoute(deps, 'chat')).toEqual({ routed: false, reason: 'consumer_off' });

    const options = listConsumerOptions(legacy);
    expect(options.find((item) => item.id === 'assistant')?.selected).toBe(true);
    expect(options.find((item) => item.id === 'terminal')?.selected).toBe(true);
    expect(options.find((item) => item.id === 'chat')?.selected).toBe(false);
  });

  it('пустой список — это выбор человека, а не старая запись', () => {
    const options = listConsumerOptions({ ...PLATFORM, targets: ['claude'], consumers: [] });
    expect(options.every((item) => !item.selected)).toBe(true);
  });
});

describe('список «Где работает контур»', () => {
  it('собирается из реестра: прогоны, ассистент, чужие CLI и терминал', () => {
    const options = listConsumerOptions({ ...PLATFORM, consumers: ['chat'] });
    const ids = options.map((item) => item.id);

    expect(ids.slice(0, 4)).toEqual(['chat', 'groups', 'tests', 'assistant']);
    expect(ids.at(-1)).toBe('terminal');
    expect(ids).toContain('foreign:codex');
    // Ассистент ходит профилем панели, терминал пишет файлы, прогон живёт в
    // своём процессе — человеку видна разница, а не один общий «включено».
    expect(options.find((item) => item.id === 'chat')?.scope).toBe('run');
    expect(options.find((item) => item.id === 'assistant')?.scope).toBe('profile');
    expect(options.find((item) => item.id === 'terminal')?.scope).toBe('files');
  });

  it('недоступный потребитель не бывает отмеченным', () => {
    // Даже если галочка сохранена (осталась от прежней версии реестра или
    // приехала импортом), на экран она не выходит: обещание, которого панель не
    // держит, хуже прочерка с причиной.
    const options = listConsumerOptions({ ...PLATFORM, consumers: ['foreign:codex'] });
    const codex = options.find((item) => item.id === 'foreign:codex');
    expect(codex?.reason).toBe('file_only');
    expect(codex?.selected).toBe(false);
  });

  it('имя встроенного потребителя сервер не придумывает', () => {
    // Язык интерфейса знает только клиент; сервер называет лишь чужой CLI —
    // это имя собственное.
    const options = listConsumerOptions(PLATFORM);
    expect(options.find((item) => item.id === 'chat')?.title).toBe('');
    expect(options.find((item) => item.id === 'foreign:codex')?.title).toBeTruthy();
  });
});
