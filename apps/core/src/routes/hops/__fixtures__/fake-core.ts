// Подставное ядро (P123): настоящий процесс, который находит или запускает хост звеньев тем же
// клиентом, что ядро (`routes/hops`), регистрирует метку сеанса, печатает строку `HOP <json>` и
// ждёт, пока его не убьют, — смерть ядра посреди запроса сеанса.
import type { HopRegisterSpec } from '@agentdeck/contracts/core/hops';
import { ensureHopHost, registerTag } from '../hops.ts';

const input = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8')) as {
  home: string;
  spec: HopRegisterSpec;
};
const handle = await ensureHopHost({ home: input.home, retryPauseMs: 10 });
const reply = await registerTag(handle, input.spec);
process.stdout.write(`HOP ${JSON.stringify({ handle, reply })}\n`);
setInterval(() => undefined, 60_000);
