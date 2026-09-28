import { describe, expect, it } from 'vitest';
import { editDraft, isChangedElsewhere, savedDraft, settleDraft } from './diskDraft';

describe('черновик файла инструкций поверх диска (ревью 28.09 F-90, F-91)', () => {
  it('правка запоминает текст диска, от которого начата, и не сдвигает его дальше', () => {
    const first = editDraft(undefined, 'A1', 'A');
    expect(first).toEqual({ value: 'A1', base: 'A' });
    expect(editDraft(first, 'A12', 'A')).toEqual({ value: 'A12', base: 'A' });
  });

  it('текст, вернувшийся к диску (в том числе с CRLF), — не черновик', () => {
    expect(editDraft({ value: 'x', base: 'a\r\nb' }, 'a\nb', 'a\r\nb')).toBeUndefined();
  });

  it('своё сохранение вернулось с CRLF — черновик снят, редактор не перечитан', () => {
    const saved = savedDraft({ value: 'B\nline', base: 'A' }, 'B\nline');
    expect(settleDraft(saved, 'B\r\nline')).toEqual({ draft: undefined, reload: false });
  });

  it('после снятия внешняя запись доходит до редактора', () => {
    expect(settleDraft(undefined, 'C')).toEqual({ draft: undefined, reload: true });
  });

  it('черновик с другим текстом переживает смену диска и говорит о чужой записи', () => {
    const draft = { value: 'B', base: 'A' };
    expect(settleDraft(draft, 'C')).toEqual({ draft, reload: false });
    expect(isChangedElsewhere(draft, 'C')).toBe(true);
    expect(isChangedElsewhere(draft, 'A')).toBe(false);
  });

  it('набранное во время сохранения считается от отправленного, а не от старого диска', () => {
    const typed = savedDraft({ value: 'B+', base: 'A' }, 'B');
    expect(typed).toEqual({ value: 'B+', base: 'B' });
    expect(isChangedElsewhere(typed, 'B')).toBe(false);
    expect(settleDraft(typed, 'B').draft).toEqual(typed);
  });

  it('без черновика или без диска расхождения нет', () => {
    expect(isChangedElsewhere(undefined, 'C')).toBe(false);
    expect(isChangedElsewhere({ value: 'B', base: 'A' }, undefined)).toBe(false);
    expect(savedDraft(undefined, 'B')).toBeUndefined();
  });
});
