import type { ProviderCheckStep } from '@agentdeck/contracts';
import type { ConfigProvider } from '../../providers/types/types.ts';
import type { OneShotResult } from '../core-ask/core-ask.types.ts';
import { reason, step } from './step.ts';
import type { ProviderCheckDeps } from './types.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';

/** Промпт проверки: ответ короткий, стоит копейки, по нему видно, что канал жив. */
const PROBE_PROMPT = 'Reply with exactly one word: ready. Write nothing else and do nothing.';

const ASSISTANT_TIMEOUT_MS = 90_000;

/** Один настоящий вопрос ядра этим CLI: доказывает, что канал до модели живой. */
export async function checkAssistant(
  provider: ConfigProvider,
  deps: ProviderCheckDeps,
): Promise<ProviderCheckStep> {
  if (!deps.withAssistant || !deps.ask)
    return step('assistant', 'skipped', serverText('checks-assistant-off'));
  if (provider.capabilities.chat !== 'ready')
    return step('assistant', 'skipped', serverText('checks-assistant-unsupported'));

  let result: OneShotResult;
  try {
    result = await deps.ask(
      provider.id,
      PROBE_PROMPT,
      deps.assistantTimeoutMs ?? ASSISTANT_TIMEOUT_MS,
    );
  } catch (error) {
    return step(
      'assistant',
      'fail',
      serverText('checks-assistant-launch-failed', { reason: reason(error) }),
    );
  }

  if (!result.ok && result.reason === 'unsupported')
    return step('assistant', 'skipped', serverText('checks-assistant-nothing-to-run'));

  if (!result.ok)
    return step('assistant', 'fail', result.error || serverText('checks-assistant-error'));

  const reply = result.reply.trim();
  if (!reply) return step('assistant', 'fail', serverText('checks-assistant-empty'));

  return step(
    'assistant',
    'pass',
    serverText('checks-assistant-ok', {
      // Ход ведёт ядро процессом CLI: прямого вызова API у проверки больше нет.
      mode: 'CLI',
      reply: reply.slice(0, 80),
    }),
  );
}
