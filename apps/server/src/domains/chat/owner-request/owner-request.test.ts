import { describe, expect, it } from 'vitest';
import {
  OWNER_REQUEST_END,
  OWNER_REQUEST_HEADER,
  OWNER_TEXT_MAX,
  ownerCoverageLine,
  ownerRequestBlock,
  reviewPublishGranted,
  splitOwnerRequest,
  withOwnerRequest,
} from '@agentdeck/contracts/quality-floor';
import {
  SPLIT_REQUEST_LINE,
  SPLIT_SYSTEM_PROMPT,
  buildGroupPrompt,
  environmentPreamble,
} from '@agentdeck/contracts/task-split';
import { withChildrenBrief } from '../children-brief/children-brief.ts';
import { withoutPanelPreamble } from '../panel-preamble.ts';
import type { TranscriptRecord } from '../ChatHistory/ChatHistory.ts';
import { ownerMessagesOf, ownerWords } from './owner-request.ts';

/**
 * U1 — слова владельца дословно. Пересказ агента родителя терял условия
 * владельца (живое ревью MR, 12.10.2026), поэтому реплики берёт панель.
 */
const user = (content: unknown, extra = {}) =>
  ({ type: 'user', message: { role: 'user', content }, ...extra }) as unknown as TranscriptRecord;

describe('ownerMessagesOf — реплики владельца из транскрипта', () => {
  it('берёт слова человека дословно, с переводами строк, и только их', () => {
    const records = [
      user('Сделай ревью MR.\n\nПункт 1: два входа.\nПункт 2: отпиши в MR.'),
      user([{ type: 'tool_result', content: 'вывод инструмента' }]),
      user('<system-reminder>напоминание среды</system-reminder>'),
      user('мета', { isMeta: true }),
      user('ветка субагента', { isSidechain: true }),
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'ответ агента' },
      } as unknown as TranscriptRecord,
      user(`${SPLIT_REQUEST_LINE} Return the block…`),
      user(
        withChildrenBrief('А ещё проверь доки.', '<agentdeck-children>сводка</agentdeck-children>'),
      ),
      user('<ide_selection>выделение</ide_selection>Третье: тесты рядом.'),
    ];
    expect(ownerMessagesOf(records)).toEqual([
      'Сделай ревью MR.\n\nПункт 1: два входа.\nПункт 2: отпиши в MR.',
      'А ещё проверь доки.',
      'Третье: тесты рядом.',
    ]);
  });

  it('родитель — группа прошлого разделения: уходят слова владельца из её задания, не задание целиком', () => {
    const block = ownerRequestBlock(['исходная просьба владельца']) as string;
    const groupPrompt = `${environmentPreamble({})}\n\n${buildGroupPrompt(
      { title: 'g', branch: 'b', tasks: ['задача агента'] },
      `${block}\n\nдобавка агента`,
    )}`;
    expect(ownerWords(groupPrompt)).toEqual(['исходная просьба владельца']);
  });

  it('слеш-команда с аргументами — слова владельца: «/имя аргументы» (TQ-08)', () => {
    const typed =
      '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n' +
      '<command-args>https://git.example/x/-/merge_requests/975 оба входа, отпиши замечания в MR</command-args>';
    expect(ownerWords(typed)).toEqual([
      '/review https://git.example/x/-/merge_requests/975 оба входа, отпиши замечания в MR',
    ]);
    expect(reviewPublishGranted(ownerRequestBlock(ownerWords(typed)), [])).toBe(true);
  });

  it('команда без аргументов слов владельца не даёт', () => {
    const typed =
      '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
    expect(ownerWords(typed)).toEqual([]);
  });

  it('реплика, целиком написанная панелью, слов владельца не даёт', () => {
    expect(ownerWords(`${SPLIT_REQUEST_LINE} rest`)).toEqual([]);
    expect(ownerWords(environmentPreamble({}))).toEqual([]);
  });
});

describe('блок слов владельца', () => {
  it('туда и обратно: реплики и добавки агента разбираются без потерь', () => {
    const block = ownerRequestBlock(['первая\n\nс абзацем', 'вторая']) as string;
    expect(block.startsWith(OWNER_REQUEST_HEADER)).toBe(true);
    // За концом блока — след требований (U2): он едет в каждое звено с заданием.
    expect(block.endsWith(`${OWNER_REQUEST_END}\n\n${ownerCoverageLine()}`)).toBe(true);
    expect(splitOwnerRequest(`${block}\n\nдобавка`)).toEqual({
      messages: ['первая\n\nс абзацем', 'вторая'],
      rest: `${ownerCoverageLine()}\n\nдобавка`,
    });
  });

  it('слова владельца, переписанные агентом списком или одним абзацем, второй раз не идут (TQ-07)', () => {
    const said = [
      'Посмотри MR 975 из двух входов и отпиши замечания в MR, когда закончишь',
      'Потом исправь в ветке: тесты, локали, гейт зелёный, миграций не делать',
      'Отдельно — доставка теряется после смены адреса, найди причину',
    ];
    const block = ownerRequestBlock(said) as string;
    const numbered = said.map((text, index) => `${index + 1}. ${text}`).join('\n');
    const quoted = said.map((text) => `> «${text}»`).join('\n');
    for (const copy of [numbered, quoted]) {
      const shared = withOwnerRequest(
        `${copy}\n\nДобавка агента: начни с логов доставки.`,
        block,
      ) as string;
      for (const text of said) expect(shared.split(text).length - 1).toBe(1);
      expect(shared).toContain('Добавка агента: начни с логов доставки.');
    }
  });

  it('инструкция разделения не велит переписывать слова владельца — их ставит панель (TQ-07)', () => {
    expect(SPLIT_SYSTEM_PROMPT).not.toMatch(/quoted verbatim/);
    expect(SPLIT_SYSTEM_PROMPT).toMatch(/panel puts the owner's messages/);
  });

  it('шапка говорит группе: это просьба на всё разделение, её доля — задачи ниже (TQ-02, F12)', () => {
    const block = ownerRequestBlock(['посмотри MR', 'исправь баг доставки']) as string;
    expect(block).toMatch(/WHOLE split/);
    expect(block).toMatch(/your share of the work is this group's tasks below/);
    expect(block).not.toMatch(/They define the work/);
    expect(ownerCoverageLine()).toMatch(/another group of this split .*"n\/a"/);
    expect(ownerCoverageLine()).not.toMatch(/before the first edit/);
  });

  it('блок со старой шапкой из записи конвейера разбирается как прежде', () => {
    const legacy =
      "Owner's request, verbatim — the owner's own messages from the conversation this work was split from, oldest first. They define the work; everything after them only adds to it.\n\n" +
      '[owner message 1 of 1]\n\nпосмотри MR и отпиши ревью в MR\n\n' +
      `${OWNER_REQUEST_END}\n\nдобавка`;
    expect(splitOwnerRequest(legacy)).toEqual({
      messages: ['посмотри MR и отпиши ревью в MR'],
      rest: 'добавка',
    });
    expect(reviewPublishGranted(legacy, [])).toBe(true);
  });

  it('сверх потолка уходят самые старые реплики — с меткой, молча ничего', () => {
    const big = 'я'.repeat(OWNER_TEXT_MAX - 10);
    const block = ownerRequestBlock(['старая', big, 'последняя']) as string;
    expect(block).toContain('left out by the panel');
    expect(block).not.toContain('старая');
    expect(block).toContain('последняя');
  });

  it('нет слов — нет блока', () => {
    expect(ownerRequestBlock(['', '  '])).toBeUndefined();
  });

  it('абзац агента, дословно повторяющий владельца, второй раз не идёт; свои добавки остаются', () => {
    const quote = 'Проверь документацию во всех трёх локалях, не только русскую.';
    const block = ownerRequestBlock([quote]) as string;
    const shared = withOwnerRequest(`«${quote}»\n\nСтек: React 19.\n\nОк.`, block) as string;
    expect(shared.split(quote)).toHaveLength(2);
    expect(shared).toContain('Стек: React 19.');
    expect(shared).toContain('Ок.');
    expect(shared.startsWith(OWNER_REQUEST_HEADER)).toBe(true);
  });

  it('название чата группы — из слов владельца, а не из шапки блока', () => {
    const shared = withOwnerRequest('добавка', ownerRequestBlock(['Почини логин']));
    const prompt = `${environmentPreamble({})}\n\n${buildGroupPrompt({ title: 'g', branch: 'b', tasks: ['t'] }, shared)}`;
    expect(withoutPanelPreamble(prompt).startsWith('Почини логин')).toBe(true);
  });

  it('строка навыков панели в слова владельца не попадает (U12)', () => {
    const prompt = buildGroupPrompt({ title: 'g', branch: 'b', tasks: ['Почини логин'] });
    expect(withoutPanelPreamble(prompt).trim()).toBe('Почини логин');
  });
});

describe('reviewPublishGranted — разрешение из слов владельца', () => {
  it('«отпиши ревью» в реплике о ревью разрешает публикацию', () => {
    const shared = ownerRequestBlock(['посмотри MR и отпиши ревью']);
    expect(reviewPublishGranted(shared, ['ревью'])).toBe(true);
  });

  it('«отпиши» о другом деле в том же разговоре разрешением не считается', () => {
    const shared = ownerRequestBlock(['отпиши в чат команды, что релиз завтра', 'посмотри MR']);
    expect(reviewPublishGranted(shared, ['ревью'])).toBe(false);
  });

  it('последняя реплика владельца о публикации решает: запрет после разрешения — запрет', () => {
    const shared = ownerRequestBlock([
      'посмотри MR и отпиши ревью в MR',
      'в MR ничего не пиши, итог мне',
    ]);
    expect(reviewPublishGranted(shared, ['ревью'])).toBe(false);
  });

  it('разрешение после запрета — разрешение', () => {
    const shared = ownerRequestBlock([
      'посмотри MR, в MR ничего не пиши',
      'ок, теперь отпиши ревью в MR',
    ]);
    expect(reviewPublishGranted(shared, ['ревью'])).toBe(true);
  });

  it('запрет владельца не перебивают слова агента в задачах', () => {
    const shared = ownerRequestBlock(['посмотри MR, но в MR ничего не публикуй']);
    expect(reviewPublishGranted(shared, ['ревью и опубликуй замечания'])).toBe(false);
  });

  it('добавки агента и задачи — как раньше, целиком', () => {
    const shared = withOwnerRequest('опубликуй замечания', ownerRequestBlock(['посмотри']));
    expect(reviewPublishGranted(shared, [])).toBe(true);
    expect(reviewPublishGranted(undefined, ['отпиши ревью в MR'])).toBe(true);
  });
});
