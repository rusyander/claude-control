import type { DlpStatus } from '@agentdeck/contracts';
import type { CoreDlpProxyReply } from '@agentdeck/contracts/core/hops';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../lib/listen-identity/listen-identity.ts';
import { codedIf } from '../../lib/server-text/server-text.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { forwardToCore, locateCore, verifyCore } from '../core-proxy/core-proxy.ts';

/**
 * Прокси защиты данных глазами панели (C3c). Слушателя у панели больше нет: адрес
 * `http://127.0.0.1:<порт>`, который человек вписывает в свой CLI, держит хост звеньев ядра по
 * настройкам раздела (`settings.dlp`) и правилам (`dlp-rules.json`), а журнал срабатываний он
 * пишет в каталог данных панели. Здесь — состояние для страницы в прежней форме `DlpStatus` и
 * просьба к ядру применить настройки сейчас (`POST /v1/dlp-proxy/apply`): тумблер записан —
 * ответ называет, держит ли ядро порт, а не «применится через такт».
 *
 * Кода ядра здесь нет (граница depcruise): строка `procs.json`, сверка ОС до отправки токена,
 * запрос на loopback — тот же путь, что у учёта контуров.
 */

export interface DlpProxy {
  /** Держит ли ядро слушатель — по последнему ответу ядра. */
  readonly running: boolean;
  status(): DlpStatus;
  /** Тумблер уже записан «включено»: ядро применяет; не открыло — исключение с его причиной. */
  start(): Promise<void>;
  /** Тумблер уже записан «выключено»: ядро закрывает слушатель. */
  stop(): Promise<void>;
  /** Спросить ядро заново (страница открыта, правила сохранены). */
  refresh?(): Promise<void>;
}

export interface CoreDlpOptions {
  /** Дом ядра (`procs.json`, токен). */
  home: () => string;
  identity?: (port: number) => CoreIdentityDeps;
  /** Порт из настроек — адрес, пока ядро не ответило. */
  settingsPort: () => number;
}

/**
 * Ядро не открыло прокси: причина ядра (код раздела) и слова — их увидит человек. Код из словаря
 * текстов сервера вешается на ошибку (`codedIf`), и ответ 409 несёт `messageCode` — клиент
 * показывает строку на языке человека. Причина с параметром, которого ядро не прислало
 * (`dlp-upstream-unparsed` без адреса), остаётся словами ядра.
 */
export class DlpStartError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    if (code === 'dlp-rules-unparsed') codedIf(this, code, { reason: message });
    else if (code !== 'dlp-upstream-unparsed') codedIf(this, code);
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createCoreDlpProxy(options: CoreDlpOptions): DlpProxy {
  const identity = options.identity ?? createCoreIdentityDeps();
  let last: CoreDlpProxyReply | null = null;
  let unreachable: string | null = null;

  const ask = async (method: 'GET' | 'POST', path: string): Promise<CoreDlpProxyReply> => {
    const core = locateCore(options.home());
    // Причина уйдёт в `status().error` и в отказ 409 — человеку, поэтому строка пишется по коду:
    // маршрут восстановит код разбором, и английская панель покажет её по-английски.
    if ('missing' in core)
      throw new Error(serverText('dlp-core-missing', { reason: core.missing }));
    const proven = await verifyCore(core, identity(core.entry.port));
    if (!('value' in proven))
      throw new Error(
        'unknown' in proven
          ? serverText('dlp-core-unverified', { reason: proven.unknown })
          : serverText('dlp-core-unverified-bare'),
      );
    const response = await forwardToCore(core, { method, path });
    if (!response.ok)
      throw new Error(serverText('dlp-core-http', { status: response.status, path }));
    return (await response.json()) as CoreDlpProxyReply;
  };

  const call = async (method: 'GET' | 'POST', path: string): Promise<CoreDlpProxyReply | null> => {
    try {
      last = await ask(method, path);
      unreachable = null;
      return last;
    } catch (error) {
      unreachable = reasonOf(error);
      return null;
    }
  };

  const listening = (): boolean => last?.proxy?.state === 'listening';

  return {
    get running() {
      return listening();
    },
    status(): DlpStatus {
      const port = last?.proxy?.port ?? last?.port ?? options.settingsPort();
      const proxy = last?.proxy;
      const waiting =
        proxy?.state === 'waiting'
          ? (proxy.lastError ?? serverText('dlp-core-port-waiting'))
          : undefined;
      const error = unreachable
        ? serverText('dlp-core-down', { reason: unreachable })
        : (last?.problem?.detail ?? waiting);
      return {
        running: listening(),
        address: port > 0 ? `http://127.0.0.1:${port}` : '',
        upstream: proxy?.upstream ?? '',
        ...(error ? { error } : {}),
        requests: proxy?.requests ?? 0,
        masked: proxy?.masked ?? 0,
        blocked: proxy?.blocked ?? 0,
      };
    },
    async start() {
      const reply = await call('POST', '/v1/dlp-proxy/apply');
      if (!reply) throw new DlpStartError('dlp-core-unreachable', this.status().error ?? '');
      if (reply.problem) throw new DlpStartError(reply.problem.code, reply.problem.detail);
      if (reply.proxy?.state !== 'listening')
        throw new DlpStartError(
          'dlp-port-busy',
          serverText('dlp-core-port-busy', {
            port: reply.port,
            reason: reply.proxy?.lastError ?? serverText('dlp-core-listener-silent'),
          }),
        );
    },
    async stop() {
      await call('POST', '/v1/dlp-proxy/apply');
    },
    async refresh() {
      await call('GET', '/v1/dlp-proxy');
    },
  };
}
