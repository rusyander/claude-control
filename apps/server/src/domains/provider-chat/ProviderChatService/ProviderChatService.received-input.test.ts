import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunInputRecord } from '@agentdeck/contracts/run-input';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { ProviderChatService } from './ProviderChatService.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../ProviderChatRun/ProviderChatRun.ts';
import { createChat } from '../store/store.ts';

/**
 * «Что получил агент» у чужого CLI (U8): запись — то, что прогон сообщил
 * ушедшим CLI (`onInput`: указание панели, блоки навыков и хуков, переписка —
 * TQ-09), с моделью и системной строкой, если та ушла своим каналом. Прогон
 * здесь подменён: что он сообщает на каждом пути, проверяют его тесты.
 */
class CapturingRun implements ProviderChatRunLike {
  options?: ProviderChatRunOptions;
  input?: string;

  start(
    options: ProviderChatRunOptions,
    _onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    this.options = options;
    this.input = `ВХОД ПРОГОНА\n\n${options.history.map((message) => message.content).join('\n\n')}`;
    options.onInput?.(this.input);
    return new Promise<void>(() => undefined);
  }

  stop(): void {}
}

const PROVIDER = { id: 'codex', name: 'Codex' } as ConfigProvider;

describe('ProviderChatService: «что получил агент»', () => {
  let dir: string;
  let run: CapturingRun;
  let service: ProviderChatService;
  let written: Array<{ key: string; record: RunInputRecord }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-input-'));
    run = new CapturingRun();
    service = new ProviderChatService(() => run);
    written = [];
    service.setInputJournal((key, record) => void written.push({ key, record }));
    createChat(dir, 'codex', { id: 'chat', workdir: dir, model: 'gpt-5.3-codex' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (text: string) =>
    service.send(dir, 'codex', 'chat', { text }, { provider: PROVIDER });

  it('реплика — та, что ушла прогону: со сводкой детей и строкой о каталоге', () => {
    service.setChildrenBrief(() => 'Сводка детей: группа 2 ждёт.');
    service.setWorkspaceNote(() => 'Тесты проекта: npm test.');

    send('Слова человека');

    expect(written).toHaveLength(1);
    expect(written[0]?.key).toBe('codex:chat');
    expect(written[0]?.record.prompt).toBe(run.input);
    expect(written[0]?.record.prompt).toContain('Сводка детей: группа 2 ждёт.');
    expect(written[0]?.record.prompt).toContain('Тесты проекта: npm test.');
    expect(written[0]?.record.prompt).toContain('Слова человека');
    expect(written[0]?.record.model).toBe('gpt-5.3-codex');
    expect(written[0]?.record.appendSystemPrompt).toBeUndefined();
  });

  it('строка о каталоге ушла системным каналом — записана им, а не в реплике', () => {
    service.setWorkspaceNote(() => 'Тесты проекта: npm test.');
    service.setSystemNote(() => ({ QWEN_SYSTEM_SETTINGS_PATH: '/tmp/s.json' }));

    send('Слова человека');

    expect(written[0]?.record.appendSystemPrompt).toBe('Тесты проекта: npm test.');
    expect(written[0]?.record.prompt).toBe('ВХОД ПРОГОНА\n\nСлова человека');
    expect(run.options?.history.at(-1)?.content).toBe('Слова человека');
  });

  it('отказ контура — прогон ничего не получил, записи нет', () => {
    service.setPlatformRouting(() => ({ env: {}, refusal: 'Контур обязателен' }));

    send('Слова человека');

    expect(written).toEqual([]);
  });
});
