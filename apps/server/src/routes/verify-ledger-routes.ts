import type { FastifyInstance } from 'fastify';
import type { LedgerSummary } from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { ledgerSummary } from '../domains/verify-ledger/verify-ledger.ts';
import type { LedgerInstall } from '../domains/verify-ledger/verify-ledger.types.ts';

/** Сводка журнала проверок для плитки: замер тени, повторы, расхождения, пульс CLI. */
export function registerVerifyLedgerRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  install: LedgerInstall,
): void {
  app.get('/api/verify-ledger', async (): Promise<LedgerSummary> =>
    ledgerSummary(ctx.location.paths.appData, install),
  );
}
