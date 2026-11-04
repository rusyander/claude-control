import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EndpointProfile, Platform } from '@agentdeck/contracts';
import { serverMessagesEn } from '../../../../../web/src/shared/config/i18n/server-messages/en.ts';
import { serverMessagesRu } from '../../../../../web/src/shared/config/i18n/server-messages/ru.ts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { managedProfileId, reconcileManagedProfiles } from './profile.ts';

/**
 * Имя профиля контура под английским интерфейсом.
 *
 * Найдено живьём: профиль контура и в en звался «Контур · …» — сервер хранил
 * русскую приставку в имени. Проверка идёт по настоящему пути: профиль,
 * сохранённый прежней сборкой, пересобирает `reconcileManagedProfiles` из
 * хранилища; показ повторяет `endpointProfileName` клиента — профиль контура
 * кодом `contour-profile-name` словаря, профиль человека именем как есть.
 */

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
  root = mkdtempSync(join(tmpdir(), 'cc-contour-en-'));
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  store = new AppStore(join(root, 'agentdeck'));
  store.updateSettings({
    platforms: [PLATFORM],
    platformGateway: { enabled: true, port: 5179, forceStream: true },
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Подстановка `{{name}}` — как у i18next на клиенте. */
function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => params[name] ?? '');
}

/** Как `endpointProfileName` клиента. */
function profileName(profile: EndpointProfile, dictionary: Record<string, string>): string {
  if (!profile.ownerPlatformId) return profile.name;
  const template = dictionary['contour-profile-name'];
  return template === undefined ? profile.name : interpolate(template, { title: profile.name });
}

describe('профиль контура под английским интерфейсом', () => {
  it('имя без русской приставки; приставка — кодом на языке экрана', () => {
    // Профиль, сохранённый прежней сборкой, — с русской приставкой в имени.
    store.updateSettings({
      endpointProfiles: [
        {
          id: managedProfileId(PLATFORM.id),
          name: 'Контур · Company · dev',
          baseUrl: 'http://127.0.0.1:5179/v1',
          apiKind: 'openai-compat',
          model: '',
          writeToken: false,
          imagesUrl: '',
          ownerPlatformId: PLATFORM.id,
        },
      ],
    });
    reconcileManagedProfiles(store);

    const managed = store.getSettings().endpointProfiles.find((item) => item.ownerPlatformId);
    expect(managed?.name).toBe(PLATFORM.title);
    expect(profileName(managed!, serverMessagesEn)).toBe('Contour · Company · dev');
    expect(profileName(managed!, serverMessagesRu)).toBe('Контур · Company · dev');
  });
});
