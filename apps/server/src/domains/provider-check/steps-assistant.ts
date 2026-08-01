import type { ProviderCheckStep } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import { runAssistant, type AssistantRunResult } from '../assistant-runner.ts';
import { reason, step } from './step.ts';
import type { ProviderCheckDeps } from './types.ts';

/** Промпт проверки: ответ короткий, стоит копейки, по нему видно, что канал жив. */
const PROBE_PROMPT = 'Ответь ровно одним словом: готов. Ничего больше не пиши и ничего не делай.';

const ASSISTANT_TIMEOUT_MS = 90_000;

/** Один настоящий запуск ассистента: доказывает, что канал до модели живой. */
export async function checkAssistant(
  provider: ConfigProvider,
  deps: ProviderCheckDeps,
): Promise<ProviderCheckStep> {
  if (!deps.withAssistant)
    return step('assistant', 'skipped', 'Запуск ассистента отключён в этой проверке.');
  if (provider.capabilities.chat !== 'ready')
    return step('assistant', 'skipped', 'Ассистент у этого провайдера не поддержан.');

  const run = deps.runAssistantImpl ?? runAssistant;
  let result: AssistantRunResult;
  try {
    result = await run(provider, [{ role: 'user', content: PROBE_PROMPT }], {
      appDataDir: deps.appDataDir,
      detect: deps.detectCli,
      models: deps.models,
      timeoutMs: deps.assistantTimeoutMs ?? ASSISTANT_TIMEOUT_MS,
    });
  } catch (error) {
    return step('assistant', 'fail', `Запуск не состоялся: ${reason(error)}`);
  }

  if (result.reason === 'no_key_no_cli' || result.reason === 'unsupported')
    return step(
      'assistant',
      'skipped',
      'Запускать нечем: CLI не найден и ключ не задан — это не отказ провайдера.',
    );

  if (!result.ok) return step('assistant', 'fail', result.error ?? 'Ассистент ответил ошибкой.');

  const reply = result.reply.trim();
  if (!reply) return step('assistant', 'fail', 'Ассистент ответил пустым сообщением.');

  return step(
    'assistant',
    'pass',
    `Ассистент ответил через ${result.mode === 'cli' ? 'CLI' : 'API'}: «${reply.slice(0, 80)}».`,
  );
}
