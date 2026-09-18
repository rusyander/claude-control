import type { ProviderCheckStep } from '@agentdeck/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import { runAssistant, type AssistantRunResult } from '../assistant-runner.ts';
import { reason, step } from './step.ts';
import type { ProviderCheckDeps } from './types.ts';
import { serverText } from '../../lib/server-texts.ts';

/** Промпт проверки: ответ короткий, стоит копейки, по нему видно, что канал жив. */
const PROBE_PROMPT = 'Ответь ровно одним словом: готов. Ничего больше не пиши и ничего не делай.';

const ASSISTANT_TIMEOUT_MS = 90_000;

/** Один настоящий запуск ассистента: доказывает, что канал до модели живой. */
export async function checkAssistant(
  provider: ConfigProvider,
  deps: ProviderCheckDeps,
): Promise<ProviderCheckStep> {
  if (!deps.withAssistant) return step('assistant', 'skipped', serverText('checks-assistant-off'));
  if (provider.capabilities.chat !== 'ready')
    return step('assistant', 'skipped', serverText('checks-assistant-unsupported'));

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
    return step(
      'assistant',
      'fail',
      serverText('checks-assistant-launch-failed', { reason: reason(error) }),
    );
  }

  if (result.reason === 'no_key_no_cli' || result.reason === 'unsupported')
    return step('assistant', 'skipped', serverText('checks-assistant-nothing-to-run'));

  if (!result.ok)
    return step('assistant', 'fail', result.error ?? serverText('checks-assistant-error'));

  const reply = result.reply.trim();
  if (!reply) return step('assistant', 'fail', serverText('checks-assistant-empty'));

  return step(
    'assistant',
    'pass',
    serverText('checks-assistant-ok', {
      mode: result.mode === 'cli' ? 'CLI' : 'API',
      reply: reply.slice(0, 80),
    }),
  );
}
