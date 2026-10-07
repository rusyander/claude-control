import { describe, expect, it } from 'vitest';
import { listProviders } from './registry.ts';

/**
 * `editsControl` — обещание клиенту, что переключатель «Разрешить правки» дойдёт
 * до CLI. Объявление и argv живут в одном файле каталога, но меняются порознь:
 * здесь объявление сверяется с тем, что код делает на самом деле, чтобы правка
 * argv без правки поля (или наоборот) краснела, а не врала человеку.
 */
const flips = (args: ((p: string, run?: { allowEdits?: boolean }) => string[]) | undefined) =>
  args !== undefined &&
  JSON.stringify(args('x', { allowEdits: true })) !==
    JSON.stringify(args('x', { allowEdits: false }));

describe('editsControl совпадает с кодом запуска', () => {
  const chatCapable = listProviders().filter((provider) => provider.id !== 'claude');

  it.each(chatCapable.map((provider) => [provider.id, provider] as const))(
    '%s',
    (_id, provider) => {
      const assistant = provider.assistant;
      const control = assistant?.editsControl ?? 'none';
      // Режим окружением (Goose `GOOSE_MODE`) — тот же переключатель, что и флаг argv.
      const envFlips =
        assistant?.oneShotEnv !== undefined &&
        JSON.stringify(assistant.oneShotEnv({ allowEdits: true })) !==
          JSON.stringify(assistant.oneShotEnv({ allowEdits: false }));
      const oneShotFlips = flips(assistant?.oneShotArgs) || envFlips;
      if (control === 'flag') expect(oneShotFlips).toBe(true);
      if (control === 'live') {
        expect(oneShotFlips).toBe(false);
        expect(assistant?.liveServer).toBeDefined();
      }
      if (control === 'none') {
        expect(oneShotFlips).toBe(false);
        expect(assistant?.liveServer).toBeUndefined();
      }
    },
  );

  it('значения на 06.10.2026: codex/qwen/continue/gemini флагом, kimi тоже флагом, goose живым сервером, прочие никак', () => {
    const map = Object.fromEntries(
      listProviders()
        .filter((provider) => provider.id !== 'claude')
        .map((provider) => [provider.id, provider.assistant?.editsControl]),
    );
    expect(map).toEqual({
      codex: 'flag',
      qwen: 'flag',
      goose: 'flag', // `GOOSE_MODE` окружением + режим сессии `goose acp` (L-goose)
      kimi: 'flag', // `-p` — профиль `--agent-file` только для чтения (L-kimi)
      gemini: 'flag',
      continue: 'flag',
      cursor: undefined, // чата нет вовсе — поле не задано, значит `none`
      opencode: 'flag', // `run --auto` + правила сессии `opencode serve` (L-opencode)
      aider: 'flag', // `--yes-always` / `--dry-run` (L-aider)
    });
  });
});
