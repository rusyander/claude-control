import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendMessage,
  createChat,
  deleteChat,
  listChats,
  patchChat,
  readChat,
  titleFromText,
} from './store.ts';

/**
 * Переписка чужого провайдера на диске. Главное здесь — что оборванная запись
 * не уносит разговор, а идентификатор из запроса не выводит за пределы каталога.
 */
describe('provider-chat store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('создаёт разговор и находит его в списке', () => {
    const chat = createChat(dir, 'codex', { id: 'first', title: 'Проба' });

    expect(chat?.id).toBe('first');
    expect(listChats(dir, 'codex').map((item) => item.id)).toEqual(['first']);
    expect(readChat(dir, 'codex', 'first')?.messages).toEqual([]);
  });

  it('называет разговор по первому вопросу', () => {
    createChat(dir, 'codex', { id: 'auto' });
    appendMessage(dir, 'codex', 'auto', { role: 'user', content: 'Почини сборку\nвторая строка' });

    expect(readChat(dir, 'codex', 'auto')?.title).toBe('Почини сборку');
  });

  it('не перебивает заданное вручную название', () => {
    createChat(dir, 'codex', { id: 'named', title: 'Моё' });
    appendMessage(dir, 'codex', 'named', { role: 'user', content: 'Привет' });

    expect(readChat(dir, 'codex', 'named')?.title).toBe('Моё');
  });

  it('копит реплики по порядку и считает их', () => {
    createChat(dir, 'codex', { id: 'talk' });
    appendMessage(dir, 'codex', 'talk', { role: 'user', content: 'Вопрос' });
    appendMessage(dir, 'codex', 'talk', {
      role: 'assistant',
      content: 'Ответ',
      transport: 'stream',
    });

    const chat = readChat(dir, 'codex', 'talk');
    expect(chat?.messages.map((message) => message.content)).toEqual(['Вопрос', 'Ответ']);
    expect(chat?.messageCount).toBe(2);
    expect(chat?.messages[1]?.transport).toBe('stream');
  });

  it('хранит время ответа и читает старую запись без него', () => {
    createChat(dir, 'codex', { id: 'timed' });
    appendMessage(dir, 'codex', 'timed', {
      role: 'assistant',
      content: 'Быстро',
      durationMs: 4200,
    });
    // Разговор, записанный до появления поля: время не выдумывается, его нет.
    appendFileSync(
      join(dir, 'provider-chats', 'codex', 'timed.jsonl'),
      `${JSON.stringify({
        kind: 'message',
        id: 'old',
        at: '2026-09-01T10:00:00.000Z',
        role: 'assistant',
        content: 'Старый',
      })}\n`,
      'utf8',
    );

    const messages = readChat(dir, 'codex', 'timed')?.messages ?? [];
    expect(messages[0]?.durationMs).toBe(4200);
    expect(messages[1]?.content).toBe('Старый');
    expect(messages[1]?.durationMs).toBeUndefined();
  });

  it('пропускает оборванную последнюю строку, а не теряет разговор', () => {
    createChat(dir, 'codex', { id: 'torn' });
    appendMessage(dir, 'codex', 'torn', { role: 'user', content: 'Целая' });
    appendFileSync(join(dir, 'provider-chats', 'codex', 'torn.jsonl'), '{"kind":"mess', 'utf8');

    expect(readChat(dir, 'codex', 'torn')?.messages).toHaveLength(1);
  });

  it('переименовывает и снимает рабочий каталог', () => {
    createChat(dir, 'codex', { id: 'meta', workdir: dir });
    appendMessage(dir, 'codex', 'meta', { role: 'user', content: 'Вопрос' });

    expect(patchChat(dir, 'codex', 'meta', { title: 'Новое' })?.title).toBe('Новое');
    expect(patchChat(dir, 'codex', 'meta', { workdir: '' })?.workdir).toBeUndefined();
    // Переписывание шапки не должно ронять реплики.
    expect(readChat(dir, 'codex', 'meta')?.messages).toHaveLength(1);
  });

  it('помнит подобранную модель и переживает переписывание шапки', () => {
    // Т12: назначение живёт в шапке разговора, поэтому его надо не потерять там,
    // где шапка переписывается целиком, — при названии по первому вопросу и при
    // переименовании. Потеря значила бы, что вторая реплика уехала на настройке
    // CLI, а не на подобранной модели.
    createChat(dir, 'codex', { id: 'plan', model: 'gpt-5.3-codex-spark', effort: 'medium' });
    appendMessage(dir, 'codex', 'plan', { role: 'user', content: 'Переименования' });

    expect(readChat(dir, 'codex', 'plan')).toMatchObject({
      title: 'Переименования',
      model: 'gpt-5.3-codex-spark',
      effort: 'medium',
    });
    expect(patchChat(dir, 'codex', 'plan', { title: 'Другое' })?.model).toBe('gpt-5.3-codex-spark');

    // Обычный разговор ничего не назначает: подбор — только у разделения.
    createChat(dir, 'codex', { id: 'plain' });
    expect(readChat(dir, 'codex', 'plain')?.model).toBeUndefined();
  });

  it('удаляет разговор и сообщает о повторной попытке честно', () => {
    createChat(dir, 'codex', { id: 'gone' });

    expect(deleteChat(dir, 'codex', 'gone')).toBe(true);
    expect(deleteChat(dir, 'codex', 'gone')).toBe(false);
    expect(readChat(dir, 'codex', 'gone')).toBeUndefined();
  });

  it('отказывает опасному идентификатору, ничего не создавая', () => {
    expect(createChat(dir, 'codex', { id: '../../escape' })).toBeUndefined();
    expect(createChat(dir, '../evil', { id: 'ok' })).toBeUndefined();
    expect(readChat(dir, 'codex', '../secret')).toBeUndefined();
    expect(deleteChat(dir, 'codex', '..')).toBe(false);
    // Отказ случился до записи: каталог хранилища даже не появился.
    expect(existsSync(join(dir, 'provider-chats'))).toBe(false);
  });

  it('дописывает только в существующий разговор', () => {
    expect(appendMessage(dir, 'codex', 'missing', { role: 'user', content: 'Э' })).toBeUndefined();
  });

  it('разделяет разговоры разных провайдеров', () => {
    createChat(dir, 'codex', { id: 'one' });
    createChat(dir, 'gemini', { id: 'two' });

    expect(listChats(dir, 'codex').map((item) => item.id)).toEqual(['one']);
    expect(listChats(dir, 'gemini').map((item) => item.id)).toEqual(['two']);
  });

  it('пишет по строке на запись — обрыв портит одну реплику', () => {
    createChat(dir, 'codex', { id: 'lines' });
    appendMessage(dir, 'codex', 'lines', { role: 'user', content: 'Раз' });
    appendMessage(dir, 'codex', 'lines', { role: 'assistant', content: 'Два' });

    const lines = readFileSync(join(dir, 'provider-chats', 'codex', 'lines.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it('обрезает длинное название до читаемой длины', () => {
    expect(titleFromText('  ')).toBe('Без названия');
    expect(titleFromText('я'.repeat(100))).toHaveLength(60);
  });
});
