import { describe, expect, it } from 'vitest';
import { createDraftBox } from '@shared/lib/draft/useDraftBox';
import { createForkAsk, watchForkDraft } from './forkDraft';

/**
 * Ветка после правки своей реплики (Telegram 26.10, R2). Ящик черновика —
 * настоящий, тот же, что держит поле ввода; без ключа он не пишет на диск.
 */
describe('пометка ветки живёт, пока в поле правленый текст', () => {
  const armed = () => {
    const draft = createDraftBox(undefined);
    const state = { fork: true };
    const stop = watchForkDraft(draft, () => {
      state.fork = false;
    });
    return { draft, state, stop };
  };

  it('очистил поле — следующая отправка уходит в этот же разговор', () => {
    const { draft, state } = armed();
    draft.set('правленый текст');
    expect(state.fork).toBe(true);

    draft.set('');
    expect(state.fork).toBe(false);
  });

  it('поле из одних пробелов — тоже очищено', () => {
    const { draft, state } = armed();
    draft.set('текст');
    draft.set('   \n');
    expect(state.fork).toBe(false);
  });

  it('правка текста пометку не снимает', () => {
    const { draft, state } = armed();
    draft.set('правленый');
    draft.set('правленый текст, дописанный');
    expect(state.fork).toBe(true);
  });

  it('после отписки поле пометку не трогает', () => {
    const { draft, state, stop } = armed();
    draft.set('текст');
    stop();
    draft.set('');
    expect(state.fork).toBe(true);
  });
});

describe('вопрос «отправить веткой?» до отправки', () => {
  it('отправка ждёт ответа; «да» — веткой, окно закрывается', async () => {
    const open: boolean[] = [];
    const fork = createForkAsk((isOpen) => open.push(isOpen));

    const answer = fork.ask();
    expect(open).toEqual([true]);
    fork.answer(true);

    await expect(answer).resolves.toBe(true);
    expect(open).toEqual([true, false]);
  });

  it('отмена — не отправлять', async () => {
    const fork = createForkAsk(() => {});
    const answer = fork.ask();
    fork.answer(false);
    await expect(answer).resolves.toBe(false);
  });

  it('второй вопрос снимает первый отказом — двух отправок одним «да» не бывает', async () => {
    const fork = createForkAsk(() => {});
    const first = fork.ask();
    const second = fork.ask();
    fork.answer(true);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
  });
});
