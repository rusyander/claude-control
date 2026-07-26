import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * EPIPE у помощника форм не должен уносить сервер.
 *
 * Промпт со схемой и всем содержимым формы легко перекрывает буфер канала, а
 * CLI закрывается мгновенно (сломан, не залогинен, протух `--resume`). Тогда
 * недописанный stdin отдаёт `error`, и без слушателя Node убивает весь процесс
 * Fastify — панель гаснет у всех вкладок, а не только у этой формы. `spawn`
 * подменён: фальшивый поток запоминает необработанный `error` вместо смерти
 * прогона тестов.
 */

class FakeStdin extends EventEmitter {
  readonly unhandled: string[] = [];
  /** EPIPE прилетает прямо на записи — так же, как у закрытого канала. */
  failOnWrite = false;

  // Само содержимое записи тесту неинтересно — важен только исход попытки.
  write(): boolean {
    if (!this.failOnWrite) return true;
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    if (this.listenerCount('error') === 0) this.unhandled.push('EPIPE');
    else this.emit('error', error);
    return false;
  }

  end(): void {}
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

let child: FakeChild;
const spawnMock = vi.fn(() => child);

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...(args as [])),
  // process-tree импортирует spawnSync из того же модуля.
  spawnSync: () => ({ status: 0 }),
}));

const { askAssistant } = await import('./assistant.ts');

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockClear();
});

const request = {
  kind: 'rule',
  message: 'заполни',
  fields: { name: 'x' },
  schema: { name: 'имя правила' },
};

describe('askAssistant: CLI закрылся раньше промпта', () => {
  it('EPIPE на stdin гасится, ответ — обычная ошибка помощника', async () => {
    child.stdin.failOnWrite = true;
    const answer = askAssistant(request, 'claude');
    child.stderr.emit('data', Buffer.from('Not logged in'));
    child.emit('close', 1);

    const result = await answer;
    // Главное: слушатель был — иначе Node убил бы процесс сервера.
    expect(child.stdin.unhandled).toEqual([]);
    // И провал не притворяется удачей: поля формы не трогаем, ошибка видна.
    expect(result.error).toContain('Not logged in');
    expect(result.fields).toEqual({});
  });
});
