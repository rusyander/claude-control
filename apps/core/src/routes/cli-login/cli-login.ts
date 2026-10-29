import type {
  ReleaseOutcome,
  Route,
  RouteAcquireSpec,
  RouteCaps,
  RouteLease,
} from '@agentdeck/contracts/core/routes';
import type { CliRunFacts } from '@agentdeck/providers/types';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { routeFactDecls } from '../facts.ts';
import { throwIfAborted } from '../lease.ts';

/**
 * Маршрут «свой вход CLI» (11 R:PR-01/03): подписка или вход в хранилище самого CLI. Адреса нет
 * (`endpoint` → `null`), привязка — к ОДНОМУ переходнику, доступ ядро не читает никогда (09).
 * Ресурсов маршрут не заводит: процесс CLI — ресурс сессии, а не маршрута.
 *
 * Доступность: задокументированное чтение состояния входа у переходника, иначе `unknown` →
 * запуск, отказ читается в потоке (класс объявлен как `run`). Окно — событие в потоке, где оно
 * задокументировано, иначе `unknown`.
 */

export interface CliLoginRouteOptions {
  /** Задокументированное чтение «вход выполнен» у переходника; нет — `unknown`. */
  loginState?: () => Promise<boolean>;
  /** Модели, которые CLI называет у себя (документация, лестница переходника). */
  models?: readonly string[];
}

type LoginFacts = Pick<CliRunFacts, 'id' | 'windowEvent'>;

export function cliLoginRouteId(adapter: string): string {
  return `cli-login:${adapter}`;
}

export function createCliLoginRoute(facts: LoginFacts, options: CliLoginRouteOptions = {}): Route {
  const id = cliLoginRouteId(facts.id);
  const caps: RouteCaps = {
    dialects: [],
    tools: true,
    images: false,
    streaming: true,
    // DLP-звено тело входа не разбирает никогда: адресной привязки у входа CLI нет (11 R:PR-02),
    // звену негде встать — при требовании DLP совместимость откажет (`dlp_opaque`, F-93).
    // Флага «разбирается» у маршрута нет: объявить его без дороги маскирования было бы ложью.
    maskable: false,
    offline: false,
    binding: { via: 'cli-login', adapter: facts.id },
    limitsToTell: false,
  };
  return {
    kind: 'cli-login',
    id,
    caps,
    facts: routeFactDecls({ availability: 'run', credential: 'run' }),
    read: {
      availability: () =>
        readFact('route.availability', async () => {
          if (!options.loginState) throw new Error('no documented login-state read');
          return (await options.loginState()) ? { state: 'up' as const } : absent();
        }),
      models: () =>
        readFact('route.models', () => {
          if (!options.models) throw new Error('adapter names no models');
          return options.models.map((model) => ({ id: model }));
        }),
      limit: () =>
        readFact('route.limit', () => ({
          kind: 'window' as const,
          source: facts.windowEvent ? ('in-band-event' as const) : ('unknown' as const),
        })),
      // Подписка тратит единицы окна, не деньги (правило владельца о счёте).
      price: () => readFact('route.price', () => ({ unit: 'window' as const })),
      // Хранилище CLI ядро не читает: наличие неизвестно, вид — известен.
      credential: () =>
        readFact('route.credential', () => {
          throw new Error('cli store is never read by the core');
        }),
      context: () =>
        readFact('route.context', () => {
          throw new Error('context of a cli-login model comes from adapter docs');
        }),
    },
    acquire: async (spec: RouteAcquireSpec) => {
      throwIfAborted(spec, 'cli-login lease');
      const lease: RouteLease = { leaseId: newId(), routeId: id, model: spec.model, resources: [] };
      return lease;
    },
    // Адреса нет вовсе: CLI идёт своим входом, решения о живости не нужно.
    endpoint: async () => null,
    // Ресурсов нет — освобождать и сверять нечего.
    release: async (): Promise<ReleaseOutcome> => ({ verified: [], leaks: [] }),
  };
}
