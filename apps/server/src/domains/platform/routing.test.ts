import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { promptText, savePrompt } from '../prompts.ts';
import { buildManagedProfile } from './apply/profile.ts';
import { writePlatform, writeToken } from './store.ts';
import { listConsumerOptions, resolveRunRoute, type PlatformRoutingDeps } from './routing.ts';

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
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
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
  caCertPath: '',
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
    expect(decision.platformId).toBe('enterprise-platform-dev');
    // Клиент anthropic дописывает `/v1` сам: адрес с версией дал бы
    // `/v1/v1/messages` на первом же запросе.
    expect(decision.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5179/enterprise-platform-dev');
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
    expect(decision.systemPrompt).toBe(promptText(dir, 'contour-agent'));
    expect(decision.systemPrompt).toContain('инструмент');
  });

  it('правка человека в каталоге едет прогону, а не встроенный текст', () => {
    connect();
    savePrompt(dir, 'contour-agent', 'короткий свой промпт');
    const decision = resolveRunRoute(deps, 'chat');
    expect(decision.routed && decision.systemPrompt).toBe('короткий свой промпт');
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
      'http://127.0.0.1:5182/enterprise-platform-dev',
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
    expect(resolveRunRoute(deps, 'chat')).toEqual({ routed: false, reason: 'gateway_down' });

    connect();
    writeToken(dir, PLATFORM.id, '');
    expect(resolveRunRoute(deps, 'chat')).toEqual({ routed: false, reason: 'no_token' });
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
      'http://127.0.0.1:5179/enterprise-platform-dev/v1',
    );
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

  it('неизвестный потребитель маршрута не получает', () => {
    connect({ ...PLATFORM, consumers: ['foreign:nosuchcli'] });
    expect(resolveRunRoute(deps, 'foreign:nosuchcli')).toEqual({
      routed: false,
      reason: 'not_a_run',
    });
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
