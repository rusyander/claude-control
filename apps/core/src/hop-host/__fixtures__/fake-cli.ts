// Подставной CLI (P112): настоящий процесс с окружением сеанса. Сбрасывает своё окружение и
// argv в файл (тест ищет там посаженный ключ), затем ходит в звено так, как ходит Claude Code:
// адрес — `ANTHROPIC_BASE_URL`, ключ — `ANTHROPIC_API_KEY` в `x-api-key`.
import { writeFileSync } from 'node:fs';

const [, , dumpPath, prompt] = process.argv;
if (!dumpPath) throw new Error('dump path missing');
writeFileSync(dumpPath, JSON.stringify({ env: process.env, argv: process.argv }));
const base = process.env.ANTHROPIC_BASE_URL ?? '';
const response = await fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
  },
  body: JSON.stringify({
    model: 'stub-model',
    max_tokens: 64,
    messages: [{ role: 'user', content: prompt ?? 'hello' }],
  }),
}).catch((error: unknown) => ({ status: 0, text: async () => String(error) }));
process.stdout.write(`STATUS ${response.status} ${await response.text()}\n`);
