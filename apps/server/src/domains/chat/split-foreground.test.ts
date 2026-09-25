import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatRunRegistry, type BufferedEvent } from './ChatRunRegistry.ts';
import { BACKGROUND_PROMPT, SPLIT_FOREGROUND_PROMPT, initiativePrompt } from './initiative.ts';

/**
 * Группа разделения не уводит проверки в фон (журнал 60b) — на настоящем
 * запуске: реестр → ChatRun → процесс; подменён только CLI, который печатает
 * свою командную строку. Проверяется то, что CLI действительно получает.
 *
 * До правки ребёнок получал общую дописку целиком, и совет «долгие тесты можно
 * увести в фон и закончить ход» доезжал до группы: группа 0 живого прогона
 * 24.09.2026 ушла «жду конца гейтов», процесс сменился, гейты умерли.
 */

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-live-cli.mjs', import.meta.url));
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;

let cwd: string;
let registry: ChatRunRegistry;

afterEach(() => {
  registry?.stopAll();
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
});

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Системная дописка, которую получил CLI: аргументом или файлом (Windows). */
async function appendSeenByCli(child: boolean): Promise<string> {
  cwd = mkdtempSync(join(tmpdir(), 'split-fg-'));
  registry = new ChatRunRegistry();
  registry.setChildResolver(() => child);
  const append = initiativePrompt({ taskSplitInitiative: true, handoffInitiative: true });
  expect(append).toContain(BACKGROUND_PROMPT);
  registry.start(
    'new-fg',
    { prompt: 'ARGV', cwd, command: COMMAND, appendSystemPrompt: append },
    {},
  );
  await waitFor(() => !registry.isRunning('new-fg'));
  let text = '';
  registry.attach('new-fg', 0, {
    send: (buffered: BufferedEvent) => {
      if (buffered.event.kind === 'text') text += buffered.event.text;
    },
    close: () => {},
  });
  const argv = JSON.parse(text.replace(/^argv /, '')) as string[];
  const file = argv[argv.indexOf('--append-system-prompt-file') + 1];
  if (argv.includes('--append-system-prompt-file') && file && existsSync(file)) {
    return readFileSync(file, 'utf8');
  }
  return argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
}

describe('дописка группы разделения', { timeout: 30_000 }, () => {
  it('группе — запрет фоновых проверок вместо совета уводить их в фон', async () => {
    const seen = await appendSeenByCli(true);
    expect(seen).toContain(SPLIT_FOREGROUND_PROMPT);
    expect(seen).not.toContain(BACKGROUND_PROMPT);
  });

  it('обычному разговору совет про фон остаётся', async () => {
    const seen = await appendSeenByCli(false);
    expect(seen).toContain(BACKGROUND_PROMPT);
    expect(seen).not.toContain(SPLIT_FOREGROUND_PROMPT);
  });
});
