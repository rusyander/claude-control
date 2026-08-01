import type { ConfigProvider } from '../../providers/types.ts';
import { resolveRunner, getRawKey } from '../provider-keys.ts';
import { flattenPrompt, runClaudeDelegate, runProviderCli, runSessionServer } from './cli.ts';
import { runProviderApi } from './api.ts';
import type { AssistantMessage, AssistantRunResult, RunAssistantDeps } from './types.ts';

// --- Публичный switch --------------------------------------------------------

/**
 * Запуск ассистента активного провайдера по switch. Claude → делегирует своему
 * существующему CLI-пути (не через раннеры прочих); остальные — по режиму раннера.
 */
export async function runAssistant(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  deps: RunAssistantDeps,
): Promise<AssistantRunResult> {
  const resolution = resolveRunner(provider, deps.appDataDir, deps.detect);

  // Claude — ОТДЕЛЬНАЯ ветка: делегируем существующему пути, не переписываем.
  if (provider.id === 'claude') {
    if (resolution.mode === 'cli')
      return runClaudeDelegate(provider, messages, deps, resolution.cliCommandFound);
    // Claude без CLI, но с ключом → его же Anthropic API как фолбэк.
    if (resolution.mode === 'api') {
      const key = getRawKey(provider, deps.appDataDir);
      if (key) return runProviderApi(provider, messages, key, deps);
    }
    return noneResult(
      provider.id,
      resolution.reason === 'unsupported' ? 'unsupported' : 'no_key_no_cli',
    );
  }

  if (resolution.mode === 'cli') {
    // IDEA-8: сначала сессионный режим (если провайдер его заявил и диалог
    // опознан), при любой заминке — привычный one-shot.
    const session = await runSessionServer(provider, messages, deps, resolution.cliCommandFound);
    if (session) return session;

    const cliResult = await runProviderCli(
      provider,
      flattenPrompt(messages),
      deps,
      resolution.cliCommandFound,
    );
    // CLI без задокументированного флага → пробуем платный API как фолбэк.
    if (cliResult.reason === 'cli_not_scriptable') {
      const key = getRawKey(provider, deps.appDataDir);
      if (provider.assistant?.apiKind !== 'none' && provider.assistant?.apiKind && key) {
        return runProviderApi(provider, messages, key, deps);
      }
      return noneResult(provider.id, 'no_key_no_cli');
    }
    return cliResult;
  }

  if (resolution.mode === 'api') {
    const key = getRawKey(provider, deps.appDataDir);
    if (!key) return noneResult(provider.id, 'no_key_no_cli');
    return runProviderApi(provider, messages, key, deps);
  }

  return noneResult(
    provider.id,
    resolution.reason === 'unsupported' ? 'unsupported' : 'no_key_no_cli',
  );
}

function noneResult(
  providerId: string,
  reason: 'no_key_no_cli' | 'unsupported',
): AssistantRunResult {
  return { ok: false, providerId, mode: 'none', reply: '', experimental: false, reason };
}
