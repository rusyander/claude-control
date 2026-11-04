import type { CoreDlpProxyReply, HopDlpProxyConfig } from '@agentdeck/contracts/core/hops';
import { resolveDlpUpstream } from '@agentdeck/dlp/proxy-config';
import { readRules } from '@agentdeck/dlp/rules-file';
import { configureDlpProxy, HopHostError } from '../routes/hops/hops.ts';
import type { HopAccess } from './hop-access.ts';
import { readPanelListenerSettings, type PanelListenerSettings } from './panel-profiles.ts';

/**
 * Прокси защиты данных человека (C3c, перенос `DlpProxy` панели): тумблер, порт, адрес наверх и
 * политика неразобранного — в настройках панели (`settings.dlp`), правила — в её файле
 * `dlp-rules.json`; слушатель держит хост звеньев. Ядро повторяет настройку каждый такт (хост
 * мог перезапуститься пустым, человек мог поменять тумблер), а панель просит такт сразу после
 * своего изменения (`POST /v1/dlp-proxy/apply`), чтобы ответ «включено» был правдой.
 *
 * Прокси, который ничего не ищет, — не защита: без включённого правила или без адреса наверх
 * слушатель не открывается, а причина называется тем же кодом, что у отказа панели.
 */

export interface DlpProxyWiringOptions {
  hops: HopAccess;
  /** Каталог данных панели: настройки (`state.json`) и правила. */
  appData: string;
  intervalMs?: number;
  note: (event: string, data: Record<string, unknown>) => void;
}

export interface DlpProxyWiring {
  /** Последнее, что назвал хост, + причина, почему прокси не открыт. */
  state(): CoreDlpProxyReply;
  /** Такт сейчас; возвращает свежее состояние. */
  tick(): Promise<CoreDlpProxyReply>;
  stop(): void;
}

const INTERVAL_MS = 5_000;

/**
 * Настройка прокси — прочтение настроек, а не класс решений ядра (P01 `decision-classes`): тип с
 * окончанием `Decision` вне реестра там красный.
 */
type DlpProxySetup = { config: HopDlpProxyConfig | null; problem: CoreDlpProxyReply['problem'] };

/** Настройка прокси из настроек и правил панели — без сети, отдельно, чтобы тест видел итог. */
export function dlpProxySetup(settings: PanelListenerSettings, appData: string): DlpProxySetup {
  const { dlp } = settings;
  if (!dlp.enabled) return { config: null, problem: null };
  let enabledRules: number;
  try {
    enabledRules = readRules(appData).filter((rule) => rule.enabled).length;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { config: null, problem: { code: 'dlp-rules-unparsed', detail } };
  }
  if (enabledRules === 0)
    return {
      config: null,
      problem: { code: 'dlp-no-rules', detail: 'нет ни одного включённого правила' },
    };
  const upstream = resolveDlpUpstream(dlp, settings.endpointProfiles);
  if (!('url' in upstream))
    return { config: null, problem: { code: upstream.code, detail: upstream.detail } };
  return {
    config: {
      port: dlp.port,
      upstream: upstream.url,
      passUnknown: dlp.passUnknown,
      journal: dlp.journal,
    },
    problem: null,
  };
}

export function startDlpProxyWiring(options: DlpProxyWiringOptions): DlpProxyWiring {
  let last: CoreDlpProxyReply = { enabled: false, port: 0, proxy: null, problem: null };
  let lastNote: string | null = null;
  let running: Promise<CoreDlpProxyReply> | undefined;

  const once = async (): Promise<CoreDlpProxyReply> => {
    const settings = readPanelListenerSettings(options.appData);
    const setup = dlpProxySetup(settings, options.appData);
    const base = { enabled: settings.dlp.enabled, port: settings.dlp.port };
    try {
      const proxy = await configureDlpProxy(await options.hops.handle(), setup.config);
      last = { ...base, proxy, problem: setup.problem };
    } catch (error) {
      if (error instanceof HopHostError && error.code === 'unreachable') options.hops.forget();
      const detail = error instanceof Error ? error.message : String(error);
      const code = error instanceof HopHostError ? `dlp-${error.code}` : 'dlp-start-failed';
      last = { ...base, proxy: null, problem: { code, detail } };
    }
    // Журнал слышит смену состояния, а не каждый такт.
    const now = `${last.proxy?.state ?? 'closed'}:${last.proxy?.port ?? 0}:${last.problem?.code ?? ''}`;
    if (now !== lastNote) {
      lastNote = now;
      options.note('dlp-proxy', {
        state: last.proxy?.state ?? 'closed',
        port: last.port,
        ...(last.problem ? { problem: last.problem.code } : {}),
      });
    }
    return last;
  };

  const tick = (): Promise<CoreDlpProxyReply> =>
    (running ??= once().finally(() => (running = undefined)));
  const timer = setInterval(() => void tick(), options.intervalMs ?? INTERVAL_MS);
  timer.unref();
  return { state: () => last, tick, stop: () => clearInterval(timer) };
}
