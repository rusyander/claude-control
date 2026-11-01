import { describe, expect, it } from 'vitest';
import { commandsFor, globsOf } from './askCommands';
import type { AskCardAsk } from './askCommands.types';

/** Выбор на карточке вопроса → команды ядра: какой командой уходит каждый вид ответа. */

const TASK = '01900000-0000-7000-8000-000000000001';
const ASK = '01900000-0000-7000-8000-000000000301';
const SPLIT = '01900000-0000-7000-8000-000000000401';

const ask = (extra: Partial<AskCardAsk>): AskCardAsk => ({
  askId: ASK,
  point: 1,
  source: 'ask_human',
  question: 'q',
  options: [],
  defaultAction: null,
  splitId: null,
  permit: null,
  repoKey: null,
  ...extra,
});

describe('команды карточки вопроса', () => {
  it('вариант обычного вопроса — answer с текстом варианта', () => {
    expect(
      commandsFor(TASK, ask({ source: 'round-cap' }), {
        type: 'option',
        option: 'extend',
        cancelReason: 'x',
      }),
    ).toEqual([{ kind: 'answer', taskId: TASK, fields: { askId: ASK, answer: 'extend' } }]);
  });

  it('свободный ответ обрезается по краям, пустой — без команды', () => {
    expect(commandsFor(TASK, ask({}), { type: 'text', text: '  да  ' })).toEqual([
      { kind: 'answer', taskId: TASK, fields: { askId: ASK, answer: 'да' } },
    ]);
    expect(commandsFor(TASK, ask({}), { type: 'text', text: '   ' })).toBeNull();
  });

  it('вопрос запуска: одобрение — approve-split по делению, отмена — cancel, правка — без команды', () => {
    const launch = ask({ source: 'launch', point: 10, splitId: SPLIT });
    const opt = (option: string) => ({ type: 'option' as const, option, cancelReason: 'человек' });
    expect(commandsFor(TASK, launch, opt('approve-split'))).toEqual([
      { kind: 'approve-split', taskId: TASK, fields: { splitId: SPLIT } },
    ]);
    expect(commandsFor(TASK, launch, opt('cancel'))).toEqual([
      { kind: 'cancel', taskId: TASK, fields: { reason: 'человек' } },
    ]);
    expect(commandsFor(TASK, launch, opt('edit-split'))).toBeNull();
  });

  it('грант — сначала grant, затем answer grant; неполная форма — без команды', () => {
    const permit = ask({ source: 'permit', point: 5 });
    expect(
      commandsFor(TASK, permit, {
        type: 'grant',
        project: ' repo-a ',
        globs: ['infra/**'],
        ops: ['edit'],
      }),
    ).toEqual([
      {
        kind: 'grant',
        taskId: TASK,
        fields: { project: 'repo-a', globs: ['infra/**'], ops: ['edit'] },
      },
      { kind: 'answer', taskId: TASK, fields: { askId: ASK, answer: 'grant' } },
    ]);
    expect(
      commandsFor(TASK, permit, { type: 'grant', project: 'r', globs: [], ops: ['edit'] }),
    ).toBeNull();
    expect(
      commandsFor(TASK, permit, { type: 'grant', project: 'r', globs: ['a'], ops: [] }),
    ).toBeNull();
  });

  it('глобы — по строке, пустые строки отброшены', () => {
    expect(globsOf('infra/**\r\n\n  src/a.ts  \n')).toEqual(['infra/**', 'src/a.ts']);
  });
});
