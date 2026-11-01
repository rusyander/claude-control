import { join } from 'node:path';
import { BRAND_SLUG, LEGACY_BRAND_SLUG } from '@agentdeck/contracts/brand';
import { endpointProfileSchema } from '@agentdeck/contracts/endpoints';
import { platformSchema } from '@agentdeck/contracts/platform';
import { homeDir } from '../platform/os-kind.ts';
import { pathExists, readBytesSync } from '../platform/safe-io/files.ts';
import { apiKeyRouteId } from '../routes/api-key/api-key.ts';
import type { ApiKeyProfile } from '../routes/api-key/api-key.types.ts';
import type { GatewayProfile } from '../routes/gateway/gateway.types.ts';

/**
 * Профили маршрутов `api-key` и `gateway` из каталога данных панели — ТОЛЬКО чтение (решение
 * стадии 5, W2b): профили адресов (`settings.endpointProfiles`) и контуры (`settings.platforms`)
 * лежат в открытом `state.json` панели, ключи — в её зашифрованном хранилище (ядро читает лишь
 * наличие, `economy-wiring/r.ts`). Ядро в этот каталог не пишет никогда: ни переезда прежнего
 * имени, ни умолчаний — пишет только панель.
 */

/** Переменная, которой человек (или стенд) называет каталог данных панели явно. */
export const PANEL_DATA_ENV = 'AGENTDECK_PANEL_DATA';
const CORE_HOME_ENV = 'AGENTDECK_CORE_HOME';
const BRAND_DIR = BRAND_SLUG;
const LEGACY_BRAND_DIR = LEGACY_BRAND_SLUG;

/**
 * Каталог данных панели: явная переменная; иначе — тот же порядок, что у панели
 * (`brand.mjs` `resolveAppDataDir`, `claude-paths` `stickyStandaloneAppData`), без переезда.
 * Дом ядра перенесён переменной (стенд, набор тестов) — каталог панели только явный: чужой
 * стенд не должен молча читать настоящие профили человека.
 */
export function panelAppDataDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homeDir(),
): string | undefined {
  const named = env[PANEL_DATA_ENV]?.trim();
  if (named) return named;
  if (env[CORE_HOME_ENV]?.trim()) return undefined;
  const root = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  for (const dir of [join(root, BRAND_DIR), join(root, LEGACY_BRAND_DIR)]) {
    if (pathExists(dir)) return dir;
  }
  const standalone = join(home, `.${BRAND_DIR}`, 'data');
  return pathExists(join(standalone, 'state.json')) ? standalone : undefined;
}

export interface PanelProfiles {
  endpoints: ApiKeyProfile[];
  contours: GatewayProfile[];
  /** Общий выключатель раздела «Защита данных» (`settings.dlp.enabled`). */
  dlpOn: boolean;
  /** Выбор маски на карточке контура (`dataMask`); нет ключа — человек не выбирал. */
  contourMask: Record<string, boolean | undefined>;
  /**
   * Активный контур панели (`settings.activePlatformId`, тот же выбор, что `activePlatform`
   * сервера): id контура из `contours`, иначе `null` — не выбран или его запись не прочиталась.
   */
  activeContourId: string | null;
  /** Записи, которые не прочитались: названы, а не пропали молча. */
  problems: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function endpointOf(raw: unknown, at: string, problems: string[]): ApiKeyProfile | undefined {
  // Профиль, порождённый контуром, указывает на шлюз панели: маршрут контура — `gateway:<id>`,
  // второй маршрут к тому же контуру через шлюз панели был бы обходом звена ядра.
  if (isObj(raw) && typeof raw.ownerPlatformId === 'string' && raw.ownerPlatformId)
    return undefined;
  // Схема профиля — та же, по которой панель его пишет (`contracts/endpoints`).
  const parsed = endpointProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const id = isObj(raw) && typeof raw.id === 'string' ? ` (${raw.id})` : '';
    problems.push(`${at}${id}: ${parsed.error.issues[0]?.path.join('.') || 'shape'} unreadable`);
    return undefined;
  }
  const p = parsed.data;
  if (!p.baseUrl.trim()) {
    problems.push(`${at} (${p.id}): needs baseUrl`);
    return undefined;
  }
  return {
    routeId: apiKeyRouteId(`endpoint:${p.id}`),
    baseUrl: p.baseUrl,
    apiKind: p.apiKind,
    storeId: `endpoint:${p.id}`,
    ...(p.model ? { model: p.model } : {}),
    // Ключ — только через звено (11 §Policy, G5): в окружение сессии он не попадает.
    keyChannel: 'hop-injected',
  };
}

function contourOf(raw: unknown, at: string, problems: string[]): GatewayProfile | undefined {
  const parsed = platformSchema.safeParse(raw);
  if (!parsed.success) {
    const id = isObj(raw) && typeof raw.id === 'string' ? ` (${raw.id})` : '';
    problems.push(`${at}${id}: ${parsed.error.issues[0]?.path.join('.') || 'shape'} unreadable`);
    return undefined;
  }
  const p = parsed.data;
  return {
    id: p.id,
    title: p.title,
    driver: p.driver,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    mode: p.mode,
    budgetUsd: p.budgetUsd,
    defaultModel: p.defaultModel,
    consumerModels: p.consumerModels,
    modelMap: p.modelMap,
    caCertPath: p.caCertPath,
    transport: p.transport,
    ...(p.manifest ? { manifest: p.manifest } : {}),
    toolShim: p.toolShim,
    rules: p.rules,
  };
}

/** Профили из `<appData>/state.json`; нет файла — пусто, не читается — пусто + причина. */
export function readPanelProfiles(appData: string): PanelProfiles {
  const out: PanelProfiles = {
    endpoints: [],
    contours: [],
    dlpOn: false,
    contourMask: {},
    activeContourId: null,
    problems: [],
  };
  const file = join(appData, 'state.json');
  const bytes = readBytesSync(file);
  if ('absent' in bytes) return out;
  if (!('value' in bytes)) {
    out.problems.push(`${file}: ${bytes.unknown}`);
    return out;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.value.toString('utf8'));
  } catch (error) {
    out.problems.push(`${file}: not JSON (${(error as Error).message})`);
    return out;
  }
  const settings = isObj(doc) && isObj(doc.settings) ? doc.settings : {};
  out.dlpOn = isObj(settings.dlp) && settings.dlp.enabled === true;
  const endpoints = Array.isArray(settings.endpointProfiles) ? settings.endpointProfiles : [];
  endpoints.forEach((raw, i) => {
    const profile = endpointOf(raw, `endpointProfiles[${i}]`, out.problems);
    if (profile) out.endpoints.push(profile);
  });
  const platforms = Array.isArray(settings.platforms) ? settings.platforms : [];
  platforms.forEach((raw, i) => {
    const profile = contourOf(raw, `platforms[${i}]`, out.problems);
    if (!profile) return;
    out.contours.push(profile);
    const mask = isObj(raw) ? raw.dataMask : undefined;
    out.contourMask[profile.id] = typeof mask === 'boolean' ? mask : undefined;
  });
  const active = typeof settings.activePlatformId === 'string' ? settings.activePlatformId : '';
  if (active) {
    if (out.contours.some((c) => c.id === active)) out.activeContourId = active;
    else out.problems.push(`activePlatformId ${active}: no readable contour with this id`);
  }
  return out;
}
