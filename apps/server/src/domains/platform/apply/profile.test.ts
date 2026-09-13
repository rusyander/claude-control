import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EndpointProfile, Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import {
  buildManagedProfile,
  gatewayUrlFor,
  isManagedProfile,
  managedProfileId,
  reconcileManagedProfiles,
} from './profile.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Управляемый профиль: то, ЧЕМ контур применяется.
 *
 * Проверяется главное свойство пометки «принадлежит контуру» — профиль всегда
 * пересобирается из контура, а не живёт своей жизнью. Без этого правки руками,
 * смена порта шлюза и удаление контура оставляли бы в списке эндпоинтов
 * профиль, указывающий в никуда, и ассистент панели молча ходил бы на мёртвый
 * порт.
 */

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
  projectPaths: [],
  consumers: [],
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
let store: AppStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-profile-'));
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  store = new AppStore(join(root, 'agentdeck'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('адрес шлюза под вид API', () => {
  it('openai-совместимым — с версией, anthropic — корень', () => {
    expect(gatewayUrlFor(5179, 'enterprise-platform-dev', 'openai-compat')).toBe(
      'http://127.0.0.1:5179/enterprise-platform-dev/v1',
    );
    // Клиенты anthropic дописывают `/v1` сами: отдать им адрес с версией
    // значило бы получить `/v1/v1/messages` на первом же запросе.
    expect(gatewayUrlFor(5179, 'enterprise-platform-dev', 'anthropic')).toBe(
      'http://127.0.0.1:5179/enterprise-platform-dev',
    );
  });
});

describe('профиль контура', () => {
  it('собирается из контура и настроек шлюза, токен не пишет', () => {
    const profile = buildManagedProfile(PLATFORM, store.getSettings().platformGateway, 'gpt-4o');
    expect(profile).toEqual({
      id: 'contour-enterprise-platform-dev',
      name: 'Контур · EnterprisePlatform · dev',
      baseUrl: 'http://127.0.0.1:5179/enterprise-platform-dev/v1',
      apiKind: 'openai-compat',
      model: 'gpt-4o',
      // Ключ контура живёт в панели, подставляет его шлюз. Галочка «писать
      // токен» здесь означала бы готовность положить ключ в чужой файл.
      writeToken: false,
      // Адрес генерации картинок (Т9) у управляемого профиля пуст, и это не
      // пробел: картинка через контур идёт дорогой контура, а профили, которые
      // он породил, режим картинки в расчёт не берёт вовсе.
      imagesUrl: '',
      ownerPlatformId: 'enterprise-platform-dev',
    });
    expect(isManagedProfile(profile)).toBe(true);
  });

  it('профиль человека управляемым не считается', () => {
    const own: EndpointProfile = {
      id: 'ep-1',
      name: 'Локальная модель',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'openai-compat',
      model: '',
      writeToken: false,
      imagesUrl: '',
      ownerPlatformId: '',
    };
    expect(isManagedProfile(own)).toBe(false);
  });
});

describe('сверка управляемых профилей', () => {
  const managed = (patch: Partial<EndpointProfile> = {}): EndpointProfile => ({
    ...buildManagedProfile(PLATFORM, store.getSettings().platformGateway, 'gpt-4o'),
    ...patch,
  });

  it('контур исчез — профиль ушёл вместе с ним', () => {
    store.updateSettings({ platforms: [], endpointProfiles: [managed()] });
    expect(reconcileManagedProfiles(store)).toEqual(['contour-enterprise-platform-dev']);
    expect(store.getSettings().endpointProfiles).toEqual([]);
  });

  it('ассистент, смотревший в исчезнувший профиль, возвращается в облако вендора', () => {
    store.updateSettings({
      platforms: [],
      endpointProfiles: [managed()],
      assistantEndpointId: managedProfileId(PLATFORM.id),
    });
    reconcileManagedProfiles(store);
    // Пустой адрес у ассистента — это молча неработающий ассистент; прежнее
    // поведение честнее.
    expect(store.getSettings().assistantEndpointId).toBe('');
  });

  it('смена порта шлюза переписывает адрес профиля', () => {
    store.updateSettings({ platforms: [PLATFORM], endpointProfiles: [managed()] });
    store.updateSettings({ platformGateway: { enabled: true, port: 5200, forceStream: true } });

    expect(reconcileManagedProfiles(store)).toEqual([]);
    expect(store.getSettings().endpointProfiles[0]?.baseUrl).toBe(
      'http://127.0.0.1:5200/enterprise-platform-dev/v1',
    );
  });

  it('правка руками отменяется, а выбор модели переживает сверку', () => {
    store.updateSettings({
      platforms: [PLATFORM],
      endpointProfiles: [
        managed({ baseUrl: 'https://куда-то-ещё', name: 'моё имя', model: 'qwen-max' }),
      ],
    });

    reconcileManagedProfiles(store);
    const profile = store.getSettings().endpointProfiles[0];
    expect(profile?.baseUrl).toBe('http://127.0.0.1:5179/enterprise-platform-dev/v1');
    expect(profile?.name).toBe('Контур · EnterprisePlatform · dev');
    // Модель выбирает человек — терять её при каждой записи настроек было бы
    // ровно тем поведением, за которое ругают «умные» панели.
    expect(profile?.model).toBe('qwen-max');
  });

  it('чужие профили не трогаются вовсе', () => {
    const own: EndpointProfile = {
      id: 'ep-1',
      name: 'Локальная модель',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'openai-compat',
      model: 'qwen3',
      writeToken: true,
      imagesUrl: '',
      ownerPlatformId: '',
    };
    store.updateSettings({ platforms: [], endpointProfiles: [own] });
    expect(reconcileManagedProfiles(store)).toEqual([]);
    expect(store.getSettings().endpointProfiles).toEqual([own]);
  });
});
