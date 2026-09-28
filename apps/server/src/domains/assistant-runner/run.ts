import type { ConfigProvider } from '../../providers/types.ts';
import { resolveRunner, getRawKey } from '../provider-keys.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flattenPrompt,
  userImages,
  runClaudeDelegate,
  runProviderCli,
  runSessionServer,
  withImagePaths,
} from './cli.ts';
import { runProviderApi } from './api.ts';
import { SECRET_MASK, maskSecretsInText, restoreMaskedSecrets } from '../../lib/secret-mask.ts';
import type { AssistantMessage, AssistantRunResult, RunAssistantDeps } from './types.ts';

// --- Публичный switch --------------------------------------------------------

/**
 * Хэши коммитов и содержимого окну ассистента и группам нужны как есть (ревью F6):
 * без имени рядом это не секрет, а под секретным именем их ловят именные правила.
 */
const RUNNER_MASK = { keepHashes: true } as const;

/**
 * Запуск ассистента активного провайдера по switch. Claude → делегирует своему
 * существующему CLI-пути (не через раннеры прочих); остальные — по режиму раннера.
 *
 * Секреты (U6, 28.09): любая модель — CLI, API, свой эндпоинт — видит текст
 * реплик через маску (детектор общий с агентом панели и помощником формы).
 * Маска в ответе возвращается секретом только в строке, слово в слово равной
 * прочитанной; в новом месте (`?k=••••••` к чужому адресу) она остаётся маской.
 */
export async function runAssistant(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  deps: RunAssistantDeps,
): Promise<AssistantRunResult> {
  const masked = messages.map((message) => ({
    ...message,
    content: maskSecretsInText(message.content, RUNNER_MASK),
  }));
  const result = await runMasked(provider, masked, deps);
  if (!result.ok || !result.reply.includes(SECRET_MASK)) return result;
  const saved = messages.map((message) => message.content).join('\n');
  return {
    ...result,
    reply: restoreMaskedSecrets(saved, result.reply, RUNNER_MASK) ?? result.reply,
  };
}

async function runMasked(
  provider: ConfigProvider,
  messages: AssistantMessage[],
  deps: RunAssistantDeps,
): Promise<AssistantRunResult> {
  // Свой эндпоинт выбран — идём прямо туда, для ЛЮБОГО провайдера, включая
  // Claude. Обычный порядок «подписка через CLI, потом ключ» здесь неуместен:
  // подписочный CLI отправил бы разговор в облако вендора, а профиль заведён
  // ровно затем, чтобы этого не происходило. Ключ провайдера не подставляем —
  // у эндпоинта свой токен (или его нет вовсе).
  if (deps.endpoint) return runProviderApi(provider, messages, '', deps);

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
    const hasImages = userImages(messages).length > 0;
    // IDEA-8: сначала сессионный режим (если провайдер его заявил и диалог
    // опознан), при любой заминке — привычный one-shot. С картинками — сразу
    // one-shot: сессионный вход принимает только текст.
    const session = hasImages
      ? undefined
      : await runSessionServer(provider, messages, deps, resolution.cliCommandFound);
    if (session) return session;

    // Картинки чужому CLI — файлами во временной папке и путями в тексте. Папка
    // же — рабочий каталог хода: Gemini и Qwen читают файлы только внутри
    // рабочей области, и путь во временной папке ОС был бы им недостижим.
    const imageDir = hasImages ? mkdtempSync(join(tmpdir(), 'cc-assistant-images-')) : undefined;
    let cliResult: AssistantRunResult;
    try {
      cliResult = await runProviderCli(
        provider,
        flattenPrompt(imageDir ? withImagePaths(messages, imageDir) : messages),
        deps,
        resolution.cliCommandFound,
        imageDir,
      );
    } finally {
      if (imageDir) rmSync(imageDir, { recursive: true, force: true });
    }
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
