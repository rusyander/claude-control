import { describe, it, expect } from 'vitest';
import { buildGroupPrompt, environmentPreamble } from '@agentdeck/contracts/task-split';
import { buildHandoffPrompt } from '@agentdeck/contracts/chat-handoff';
import { chatTitleText, type Record } from './ChatRecords.ts';

/**
 * Название чата не берётся из преамбулы панели (живой стенд 24–25.09.2026): чаты
 * групп назывались «Панель подготовила эту копию: Локальный слой: перенесено
 * 235,…», звенья — «Это новая сессия: работа велась моделью claude-opus…».
 * Реплики собраны ТЕМИ ЖЕ функциями, что пишут их в транскрипт, и лежат в
 * записи так, как её пишет CLI: строкой и массивом блоков.
 *
 * Задания звеньев ревью, правок, доставки, преамбулу доставки группы и вводную работы в чужом MR панель
 * больше не пишет (планировщик звеньев уехал в ядро, этап 10): они — текстом,
 * как лежат в транскриптах на диске; первая строка дословно та, что писали
 * прежние построители.
 */

const LEGACY_REVIEW = [
  'This is a new session: the work was done by the model claude-opus-4-8 on the branch fix/login; you do not have its context — read the code and the diff.',
  'Task of the work:',
  'Поправь валидацию формы входа',
].join('\n');
const LEGACY_REVIEW_OTHER = [
  'This is a new session: the work was done by another model on the branch fix/login; you do not have its context — read the code and the diff.',
  'Task of the work:',
  'x',
].join('\n');
const LEGACY_FIX = [
  'This is a new session: a stronger model reviewed the work on the branch fix/login — here are its findings.',
  '1. Нет теста на пустой пароль',
].join('\n\n');
const LEGACY_DELIVER = [
  'This is a new session: the work of this group was reviewed and the review found nothing. Your stage is delivering the branch fix/login to a ready MR; you have no context of the previous stages — read the copy, git and the checkpoint files in .agent/.',
  'Deliver the branch.',
].join('\n\n');
const LEGACY_MR_WORK = [
  'This session works in the merge request https://git.acme.local/team/app/-/merge_requests/7.',
  'The working copy is already on its branch feat/x: edit here and commit into it.',
].join('\n');
// Преамбула доставки группы: полная и для работы перед звеном доставки (`deliverLater`).
const LEGACY_DELIVERY = [
  "Delivering a ready MR is this group's duty: the human enabled it on the project, and that is their permission to commit, push, create and update the MR and to move the tracker tasks of this group. Merging and deleting branches stay forbidden; so does force-push, except for the one case below about your own branch.",
  "The panel has already created the copy's branch: fix/login. Do not create another.",
].join('\n');
const LEGACY_DELIVERY_WORK = [
  "Delivering a ready MR is this group's duty, and the panel runs it as a separate stage after the work. The work stage makes the change and commits it on this branch following the project convention for messages, and does not push: the push, the MR and its threads belong to the delivery stage.",
  "The panel has already created the copy's branch: fix/login. Do not create another.",
].join('\n');

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
    // `deliverLater` — то, что шлёт группа с доставкой отдельным звеном (23.10).
    for (const delivery of [LEGACY_DELIVERY, LEGACY_DELIVERY_WORK]) {
      const prompt = `${environmentPreamble({})}\n\n${delivery}\n\n${buildGroupPrompt(GROUP)}`;

      expect(chatTitleText([userBlocks(prompt)])).toBe('Поправь валидацию формы входа');
    }
  });

  it('работа в чужом MR: преамбула MR пропущена', () => {
    const prompt = `${LEGACY_MR_WORK}\n\n${buildGroupPrompt(GROUP)}`;

    expect(chatTitleText([user(prompt)])).toBe('Поправь валидацию формы входа');
  });

  it('продолжение в чистой сессии: название — что делать дальше', () => {
    const prompt = buildHandoffPrompt(
      { checkpoint: '.agent/PROGRESS.md', next: 'Допиши тесты формы входа' } as never,
      'Поправь валидацию формы входа',
    );

    // Справка об исходном задании и строка языка ответа — английский хвост
    // панели (D-E): в названии их нет, название — что делать дальше.
    expect(chatTitleText([user(prompt)])).toBe('Допиши тесты формы входа');
  });

  it('звенья ревью, правок и доставки целиком — панель: названия из них нет', () => {
    expect(chatTitleText([user(LEGACY_REVIEW)])).toBe('');
    expect(chatTitleText([user(LEGACY_FIX)])).toBe('');
    expect(chatTitleText([userBlocks(LEGACY_DELIVER)])).toBe('');
  });

  it('после целиком панельной реплики — следующая реплика человека', () => {
    expect(chatTitleText([user(LEGACY_REVIEW_OTHER), user('Почему упал линт?')])).toBe(
      'Почему упал линт?',
    );
  });

  it('звено за преамбулой панели — тоже целиком панель', () => {
    const prompt = `${environmentPreamble({})}\n\n${LEGACY_DELIVERY}\n\n${LEGACY_REVIEW_OTHER}`;

    expect(chatTitleText([user(prompt)])).toBe('');
  });

  /**
   * G1 (12.10.2026): строка звена В СЕРЕДИНЕ слов человека — цитата, а не
   * задание панели. Раньше любая такая строка выбрасывала реплику целиком, и
   * человек, спросивший о присланном агенту тексте, оставался без названия чата.
   */
  it('человек цитирует строку звена — его реплика остаётся его словами', () => {
    const quoted = LEGACY_REVIEW_OTHER.split('\n')[0] ?? '';
    const said = `Почему ревью получило вот это?\n${quoted}\nОно же ничего не правит.`;

    expect(chatTitleText([user(said)]).startsWith('Почему ревью получило вот это?')).toBe(true);
  });

  it('реплика человека, начатая теми же словами не с начала строки, не пропускается', () => {
    expect(chatTitleText([user('Объясни, что значит «Это новая сессия: …» в чате')])).toBe(
      'Объясни, что значит «Это новая сессия: …» в чате',
    );
  });
});
