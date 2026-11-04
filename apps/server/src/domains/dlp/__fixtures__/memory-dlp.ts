import type { DlpStatus } from '@agentdeck/contracts';
import { DlpStartError, type DlpProxy } from '../core-dlp.ts';

/**
 * Прокси защиты данных в памяти — для тестов маршрутов и действий агента панели, которым нужен
 * только тумблер (C3c: слушатель держит ядро, `createCoreDlpProxy` ходит к нему по HTTP).
 * Настоящий слушатель — `apps/core/src/hop-host/dlp-proxy/dlp-proxy.test.ts` и
 * `apps/core/src/bootstrap/boot.dlp-proxy.integration.test.ts`; клиент панели к ядру —
 * `domains/dlp/core-dlp.test.ts`.
 */
export interface MemoryDlpProxy extends DlpProxy {
  /** Следующий `start()` откажет этим кодом (как ядро, не открывшее порт). */
  failNextStart(code: string, message?: string): void;
  readonly calls: readonly ('start' | 'stop' | 'refresh')[];
}

export function createMemoryDlpProxy(port = 5179): MemoryDlpProxy {
  let running = false;
  let failure: DlpStartError | undefined;
  const calls: ('start' | 'stop' | 'refresh')[] = [];
  return {
    get running() {
      return running;
    },
    calls,
    status(): DlpStatus {
      return {
        running,
        address: `http://127.0.0.1:${port}`,
        upstream: '',
        requests: 0,
        masked: 0,
        blocked: 0,
      };
    },
    async start() {
      calls.push('start');
      if (failure) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      running = true;
    },
    async stop() {
      calls.push('stop');
      running = false;
    },
    async refresh() {
      calls.push('refresh');
    },
    failNextStart(code, message = code) {
      failure = new DlpStartError(code, message);
    },
  };
}
