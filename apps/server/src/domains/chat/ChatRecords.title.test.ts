import { localizeMediaTitle } from '@agentdeck/contracts/chat-title';
import { describe, it, expect } from 'vitest';
import type { Deck } from '@agentdeck/contracts';
import {
  deckBlockRequest,
  deckReviseRequest,
  mediaRequestOf,
  pictureBlockRequest,
} from '@agentdeck/contracts/media-block';
import {
  chatTitleText,
  firstMeaningfulText,
  isDialogMessage,
  normalizeRecord,
  type Record,
} from './ChatRecords.ts';

const user = (content: string): Record => ({
  type: 'user',
  message: { role: 'user', content },
});

/**
 * Живой прогон 24.09.2026: задание начиналось ссылкой из трекера, и чат в
 * списке назывался самой ссылкой. Название берёт ключ задачи из ссылки и
 * текст после неё; текст задания для переноса ссылку сохраняет.
 */
describe('название чата по первой реплике', () => {
  it('ссылка с ключом задачи — остаётся ключ и текст после неё', () => {
    const records = [
      user('https://tracker.example.com/browse/PROJ-1064\nПоправь валидацию формы входа'),
    ];
    expect(chatTitleText(records)).toBe('PROJ-1064 Поправь валидацию формы входа');
    // Текст задания — без изменений: агенту ссылка нужна целиком.
    expect(firstMeaningfulText(records)).toContain('https://tracker.example.com/browse/PROJ-1064');
  });

  it('реплика из одной ссылки без ключа — берётся следующая реплика', () => {
    const records = [
      user('https://tracker.example.com/secure/Dashboard.jspa'),
      user('Почини вход'),
    ];
    expect(chatTitleText(records)).toBe('Почини вход');
  });

  it('текст без ссылок не меняется', () => {
    expect(chatTitleText([user('Почини   вход')])).toBe('Почини вход');
  });
});

/**
 * Живой прогон 26.09.2026: разговоры режима «Презентация» назывались первой
 * строкой правил из каталога — все колоды в списке звались одинаково.
 */
describe('название чата-просьбы режима', () => {
  const RULES =
    'You are building a presentation on the topic the person named.\nTopic: a rules line';

  it('колода, правка и рисунок зовутся словами человека, а не правилами', () => {
    expect(chatTitleText([user(deckBlockRequest(RULES, 'История кофе'))])).toBe(
      'Презентация: История кофе',
    );
    const deck = { title: 'Кофе', slides: [{ title: 'Эфиопия' }] } as unknown as Deck;
    expect(chatTitleText([user(deckReviseRequest(RULES, deck, 'добавь слайд про Бразилию'))])).toBe(
      'Правка презентации: добавь слайд про Бразилию',
    );
    expect(chatTitleText([user(pictureBlockRequest('Рисуй SVG.', 'кот на окне'))])).toBe(
      'Картинка: кот на окне',
    );
  });

  // Ревью 26.09: тема в несколько строк и «Просьба:» в правилах возвращали
  // название по правилам — ту самую ошибку, которую закрывает разбор конверта.
  it('тема в несколько строк и похожие строки в правилах', () => {
    expect(mediaRequestOf(deckBlockRequest(RULES, 'История кофе\nс картой стран'))).toEqual({
      kind: 'deck',
      topic: 'История кофе\nс картой стран',
    });
    expect(mediaRequestOf(pictureBlockRequest('Рисуй SVG.', 'кот\nна окне'))?.topic).toBe(
      'кот\nна окне',
    );
    const deck = { title: 'Кофе', slides: [{ title: 'Эфиопия' }] } as unknown as Deck;
    const rules = `${RULES}\nRequest: a rules line`;
    expect(mediaRequestOf(deckReviseRequest(rules, deck, 'убери слайд 2\nи добавь карту'))).toEqual(
      { kind: 'deck-revise', topic: 'убери слайд 2\nи добавь карту' },
    );
  });

  // Конверт перевели на английский 26.09.2026; просьбы в сохранённых разговорах
  // написаны прежним русским, и название по-прежнему берётся из слов человека.
  it('прежний русский конверт узнаётся так же', () => {
    const legacyDeck = [
      'Правила.',
      '',
      'Готовый ответ — РОВНО ОДИН блок кода с языком agentdeck:deck, внутри — JSON.',
      '',
      'Тема: История кофе',
    ].join('\n');
    expect(chatTitleText([user(legacyDeck)])).toBe('Презентация: История кофе');
    const legacyRevise = [
      'Правила.',
      '',
      'Колода уже собрана — её структура ниже. Просят поправить.',
      '',
      'Просьба: убери слайд 2',
      '',
      'Меняй только то, о чём просят. Остальное дословно.',
    ].join('\n');
    expect(mediaRequestOf(legacyRevise)).toEqual({ kind: 'deck-revise', topic: 'убери слайд 2' });
    const legacyPicture = [
      'Правила.',
      '',
      'Ответ — РОВНО ОДИН блок кода с языком agentdeck:svg, внутри — svg.',
      '',
      'Рисунок: кот на окне',
    ].join('\n');
    expect(mediaRequestOf(legacyPicture)).toEqual({ kind: 'picture', topic: 'кот на окне' });
  });

  it('обычный текст с похожими словами — не просьба режима', () => {
    expect(mediaRequestOf('Тема: кофе')).toBeUndefined();
    expect(mediaRequestOf('Topic: coffee')).toBeUndefined();
    expect(mediaRequestOf('Ответ — блок кода agentdeck:deck\nТема: кофе')).toBeUndefined();
    expect(chatTitleText([user('Тема: кофе')])).toBe('Тема: кофе');
  });
});

// Слово режима пишется по-русски; клиент на другом языке ставит своё (ревью z4 C15
// и i18n-пробел названия чата), прежнее «Рисунок» из кэша сводок — тоже.
describe('слово режима в названии на языке клиента', () => {
  const english = (mode: string) =>
    ({ deck: 'Presentation', 'deck-revise': 'Edit', picture: 'Image' })[mode] ?? '';

  it('меняет только слово режима, слова человека — как есть', () => {
    expect(localizeMediaTitle('Картинка: кот на окне', english)).toBe('Image: кот на окне');
    expect(localizeMediaTitle('Правка презентации: слайд 2', english)).toBe('Edit: слайд 2');
    expect(localizeMediaTitle('Презентация: кофе', english)).toBe('Presentation: кофе');
    expect(localizeMediaTitle('Рисунок: кот', english)).toBe('Image: кот');
  });

  it('обычное название не трогает', () => {
    expect(localizeMediaTitle('Почини тесты', english)).toBe('Почини тесты');
    expect(localizeMediaTitle('Картинка без двоеточия', english)).toBe('Картинка без двоеточия');
  });
});

// Сообщение посреди хода (CLI 2.1.285) пишется вставкой `queued_command`, а не
// репликой: без перевода оно пропадало бы из ленты после перезагрузки.
describe('normalizeRecord', () => {
  it('queued_command — реплика человека на своём месте, прочее как есть', () => {
    const queued = {
      type: 'attachment',
      uuid: 'u1',
      timestamp: '2026-09-30T14:09:35.000Z',
      attachment: { type: 'queued_command', prompt: 'нашёл баг' },
    } as Record;
    expect(normalizeRecord(queued)).toMatchObject({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'нашёл баг' },
    });
    expect(isDialogMessage(normalizeRecord(queued))).toBe(true);

    const other = { type: 'attachment', attachment: { type: 'date' } } as Record;
    expect(normalizeRecord(other)).toBe(other);
    const empty = {
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: ' ' },
    } as Record;
    expect(normalizeRecord(empty)).toBe(empty);
  });
});
