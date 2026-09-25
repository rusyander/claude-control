import { describe, it, expect } from 'vitest';
import {
  buildGroupPrompt,
  deliveryPreamble,
  environmentPreamble,
} from '@agentdeck/contracts/task-split';
import {
  deliverStagePrompt,
  fixStagePrompt,
  mergeRequestWorkPreamble,
  reviewStagePrompt,
} from '@agentdeck/contracts/model-cascade';
import { buildHandoffPrompt } from '@agentdeck/contracts/chat-handoff';
import { chatTitleText, type Record } from './ChatRecords.ts';

/**
 * Название чата не берётся из преамбулы панели (живой стенд 24–25.09.2026): чаты
 * групп назывались «Панель подготовила эту копию: Локальный слой: перенесено
 * 235,…», звенья — «Это новая сессия: работа велась моделью claude-opus…».
 * Реплики собраны ТЕМИ ЖЕ функциями, что пишут их в транскрипт, и лежат в
 * записи так, как её пишет CLI: строкой и массивом блоков.
 */

const user = (content: string): Record => ({
  type: 'user',
  message: { role: 'user', content },
});

const userBlocks = (text: string): Record => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const GROUP = {
  title: 'Форма входа',
  branch: 'fix/login',
  tasks: ['Поправь валидацию формы входа'],
};

describe('название чата мимо преамбулы панели', () => {
  it('группа в копии: преамбула окружения пропущена — название из задания', () => {
    const prompt = `${environmentPreamble({
      mirror: 'Локальный слой: перенесено 235, пропущено 3',
      bootstrap: {
        status: 'ok',
        command: 'pnpm install --frozen-lockfile',
        logTail: '',
      } as never,
    })}\n\n${buildGroupPrompt(GROUP)}`;

    expect(chatTitleText([user(prompt)])).toBe('Поправь валидацию формы входа');
  });

  it('копия без подготовки и доставка до MR: обе преамбулы пропущены', () => {
    const prompt = `${environmentPreamble({})}\n\n${deliveryPreamble({ branch: 'fix/login' })}\n\n${buildGroupPrompt(GROUP)}`;

    expect(chatTitleText([userBlocks(prompt)])).toBe('Поправь валидацию формы входа');
  });

  it('работа в чужом MR: преамбула MR пропущена', () => {
    const prompt = `${mergeRequestWorkPreamble({
      url: 'https://git.acme.local/team/app/-/merge_requests/7',
      branch: 'feat/x',
    })}\n\n${buildGroupPrompt(GROUP)}`;

    expect(chatTitleText([user(prompt)])).toBe('Поправь валидацию формы входа');
  });

  it('продолжение в чистой сессии: название — что делать дальше', () => {
    const prompt = buildHandoffPrompt(
      { checkpoint: '.agent/PROGRESS.md', next: 'Допиши тесты формы входа' } as never,
      'Поправь валидацию формы входа',
    );

    expect(chatTitleText([user(prompt)])).toBe(
      'Допиши тесты формы входа Исходное задание всей работы — для ориентира, сделанное по нему не переделывай: Поправь валидацию формы входа',
    );
  });

  it('звенья ревью, правок и доставки целиком — панель: названия из них нет', () => {
    const review = reviewStagePrompt({
      task: 'Поправь валидацию формы входа',
      model: 'claude-opus-4-8',
      branch: 'fix/login',
    });
    const fix = fixStagePrompt(['Нет теста на пустой пароль'], { branch: 'fix/login' });
    const deliver = deliverStagePrompt({ branch: 'fix/login', after: 'review' });

    expect(chatTitleText([user(review)])).toBe('');
    expect(chatTitleText([user(fix)])).toBe('');
    expect(chatTitleText([userBlocks(deliver)])).toBe('');
  });

  it('после целиком панельной реплики — следующая реплика человека', () => {
    const review = reviewStagePrompt({ task: 'x', branch: 'fix/login' });

    expect(chatTitleText([user(review), user('Почему упал линт?')])).toBe('Почему упал линт?');
  });

  it('реплика человека, начатая теми же словами не с начала строки, не пропускается', () => {
    expect(chatTitleText([user('Объясни, что значит «Это новая сессия: …» в чате')])).toBe(
      'Объясни, что значит «Это новая сессия: …» в чате',
    );
  });
});
