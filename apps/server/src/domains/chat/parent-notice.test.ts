import { describe, it, expect, vi } from 'vitest';
import { createParentNotice } from './parent-notice.ts';

/**
 * Куда уходят слова панели родителю разделения. Проверяется ровно развилка: тот
 * же вызов у Claude идёт событием прогона, а у чужого CLI — репликой хранилища,
 * и обе стороны обязаны честно отвечать, вышло ли сказать.
 */
describe('createParentNotice', () => {
  const event = { kind: 'notice', code: 'overlap', text: 'общий файл: shared.ts' } as const;

  it('родитель Claude получает событие прогона', () => {
    const emitRun = vi.fn().mockReturnValue(true);
    const appendForeign = vi.fn();

    const said = createParentNotice({ emitRun, appendForeign })('c1a2', event);

    expect(said).toBe(true);
    expect(emitRun).toHaveBeenCalledWith('c1a2', event);
    expect(appendForeign).not.toHaveBeenCalled();
  });

  it('родитель чужого CLI получает реплику своего хранилища', () => {
    const emitRun = vi.fn();
    const appendForeign = vi.fn().mockReturnValue(true);

    const said = createParentNotice({ emitRun, appendForeign })('codex:qa1', event);

    expect(said).toBe(true);
    // Ключ разобран: провайдеру уходит его собственный идентификатор разговора.
    expect(appendForeign).toHaveBeenCalledWith('codex', 'qa1', 'общий файл: shared.ts');
    expect(emitRun).not.toHaveBeenCalled();
  });

  it('прогона у родителя нет — «не сказано», и факт подождёт', () => {
    const said = createParentNotice({
      emitRun: () => false,
      appendForeign: () => true,
    })('c1a2', event);

    expect(said).toBe(false);
  });

  it('разговора чужого провайдера нет — тоже «не сказано»', () => {
    const said = createParentNotice({
      emitRun: () => true,
      appendForeign: () => false,
    })('codex:qa1', event);

    expect(said).toBe(false);
  });

  it('событие без текста чужому родителю не пересказывается', () => {
    const appendForeign = vi.fn();

    const said = createParentNotice({ emitRun: () => true, appendForeign })('codex:qa1', {
      kind: 'session',
      sessionId: 's1',
      model: 'gpt',
      tools: 0,
    });

    expect(said).toBe(false);
    expect(appendForeign).not.toHaveBeenCalled();
  });
});
