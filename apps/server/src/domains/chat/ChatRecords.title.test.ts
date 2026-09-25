import { describe, it, expect } from 'vitest';
import { chatTitleText, firstMeaningfulText, type Record } from './ChatRecords.ts';

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
