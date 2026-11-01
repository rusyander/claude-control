import { hopHostLaunchSchema } from '@agentdeck/contracts/core/hops';
import type { HopHostConfig } from './host.types.ts';
import { HopHostBusy, startHopHost } from './host.ts';

/**
 * Процесс хоста звеньев: ядро запускает его отвязанным (`routes/hops`) и находит по строке
 * `procs.json`. Настройка — одним аргументом base64url JSON (окружение через WMI не доходит).
 * Второй хост на тот же дом выходит сразу кодом 3: ядро возьмёт строку живого.
 */

function decodeConfig(arg: string | undefined): HopHostConfig {
  if (!arg) throw new Error('hop host: config argument missing');
  const raw = JSON.parse(Buffer.from(arg, 'base64url').toString('utf8')) as unknown;
  // Схема контракта, не догадки: незнакомое поле — отказ старта с названием, а не тихий пропуск.
  const parsed = hopHostLaunchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`hop host: bad config ${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`);
  }
  return parsed.data;
}

try {
  const host = await startHopHost(decodeConfig(process.argv[2]));
  const stop = (): void => void host.close().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(error instanceof HopHostBusy ? 3 : 1);
}
