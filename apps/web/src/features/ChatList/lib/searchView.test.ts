import { describe, it, expect } from 'vitest';
import { searchView } from './searchView';

const MIN = 2;
const view = (mode: 'title' | 'messages', query: string, bodyQuery = query.trim()) =>
  searchView({ mode, query, bodyQuery, minLength: MIN });

describe('searchView — что под полем поиска разговоров', () => {
  it('«По названию»: ни совпадений сервера, ни подсказки', () => {
    expect(view('title', 'кактус', '')).toEqual({ useBodyHits: false, showHint: false });
    expect(view('title', '')).toEqual({ useBodyHits: false, showHint: false });
  });

  it('«По сообщениям», запрос набран — список из ответа сервера, счётчик', () => {
    expect(view('messages', 'кактус')).toEqual({ useBodyHits: true, showHint: false });
  });

  it('кейс chat-006: стёртое поле — весь список и счётчик, а не прежнее совпадение', () => {
    expect(view('messages', '')).toEqual({ useBodyHits: false, showHint: false });
    // Дебаунс ещё несёт прежний запрос, а поле уже пустое.
    expect(view('messages', '', 'кактус')).toEqual({ useBodyHits: false, showHint: false });
    expect(view('messages', '   ')).toEqual({ useBodyHits: false, showHint: false });
  });

  it('запрос короче минимума — подсказка и весь список', () => {
    expect(view('messages', 'к')).toEqual({ useBodyHits: false, showHint: true });
    expect(view('messages', 'к', 'кактус')).toEqual({ useBodyHits: false, showHint: true });
  });
});
