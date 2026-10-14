import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Ревью из набора: подсказка навыка и страж публикации — настоящие файлы
 * набора. Человек без своих настроек получает именно их, поэтому быстрый
 * запрос не должен обходить навык, тред должен быть карточкой находки, а
 * «блокеров нет» — нести строку покрытия.
 */

// Состояние стража живёт в отдельном каталоге: модуль читает его при импорте.
process.env.AGENTDECK_KIT_STATE = mkdtempSync(join(tmpdir(), 'kit-review-gates-'));
const HOOKS = join(builtinKitDir(), 'hooks', 'lib');

type Verdict = { decision: string; reason: string } | null;
type HookInput = Record<string, unknown>;
const guardModule = (await import(pathToFileURL(join(HOOKS, 'review-publish-guard.mjs')).href)) as {
  default: (input: HookInput) => Verdict;
  recordReviewRead: (input: HookInput) => null;
};
const hintModule = (await import(pathToFileURL(join(HOOKS, 'prompt', 'skill-hint.mjs')).href)) as {
  default: (input: HookInput, prompt: string) => string | null;
};
const guard = guardModule.default;
const record = guardModule.recordReviewRead;
const hint = (prompt: string) => hintModule.default({}, prompt) ?? '';

const MR = { project_id: 'team/app', merge_request_iid: '42' };
const THREAD = 'mcp__gitlab__create_merge_request_thread';
const NOTE = 'mcp__gitlab__create_merge_request_note';
const CARD =
  '🟡 F-01 **Ключ кэша не учитывает арендатора.**\n\n**Где:** `src/cache.ts:10-14`\n\nПричина.';

let seq = 0;
/** Сессия с прочитанными тредами и версиями MR: проверяется только форма. */
function session(): string {
  const id = `rg${seq++}x${Date.now()}`;
  record({ tool_name: 'mcp__gitlab__mr_discussions', session_id: id, tool_input: MR });
  record({ tool_name: 'mcp__gitlab__list_merge_request_versions', session_id: id, tool_input: MR });
  return id;
}
const write = (tool: string, id: string, body: string, extra: HookInput = {}) =>
  guard({ tool_name: tool, session_id: id, tool_input: { ...MR, body, ...extra } });
const loadSkill = (id: string) =>
  record({
    tool_name: 'Skill',
    session_id: id,
    tool_input: { skill: 'agentdeck-kit:deep-review' },
  });

describe('подсказка навыка ревью в наборе', () => {
  it('«просто сделай» не глушит deep-review', () => {
    expect(hint('просто сделай ревью моей ветки')).toContain('agentdeck-kit:deep-review');
  });

  it('остальные подсказки «просто сделай» по-прежнему глушит', () => {
    expect(hint('просто сделай ревью и напиши тесты')).not.toContain('unit-integration-tests');
  });

  it('подсказка ревью говорит, что навык обязателен; без ревью строки нет', () => {
    expect(hint('сделай ревью моей ветки')).toContain('is not optional for a review');
    expect(hint('напиши тесты для корзины')).not.toContain('is not optional for a review');
  });

  it('«посмотри задачу … замечания в MR» и английский вариант ведут к ревью', () => {
    expect(hint('посмотри задачу GOR-1 и оставь замечания в MR')).toContain('deep-review');
    expect(hint('look at the ticket and leave comments on the PR')).toContain('deep-review');
  });
});

describe('страж публикации ревью в наборе', () => {
  it('тред без загруженного deep-review — отказ', () => {
    const verdict = write(THREAD, session(), CARD);
    expect(verdict?.decision).toBe('deny');
    expect(verdict?.reason).toContain('deep-review');
  });

  it('загрузка засчитывается в форме любого CLI', () => {
    const shapes: HookInput[] = [
      { tool_name: 'Skill', tool_input: { skill: 'agentdeck-kit:deep-review' } },
      { tool_name: 'skill', tool_input: { name: 'deep-review' } },
      { tool_name: 'Read', tool_input: { file_path: '/kit/skills/deep-review/SKILL.md' } },
      { tool_name: 'Bash', tool_input: { command: 'cat ~/kit/skills/deep-review/SKILL.md' } },
    ];
    for (const shape of shapes) {
      const id = session();
      record({ ...shape, session_id: id });
      expect(write(THREAD, id, CARD), JSON.stringify(shape)).toBeNull();
    }
  });

  it('чужой навык и чтение другого файла загрузкой не считаются', () => {
    const id = session();
    record({
      tool_name: 'Skill',
      session_id: id,
      tool_input: { skill: 'agentdeck-kit:skill-map' },
    });
    record({
      tool_name: 'Read',
      session_id: id,
      tool_input: { file_path: '/kit/skills/x/SKILL.md' },
    });
    expect(write(THREAD, id, CARD)?.decision).toBe('deny');
  });

  it('введённая человеком /deep-review видна по транскрипту', () => {
    const id = session();
    const transcript = join(process.env.AGENTDECK_KIT_STATE ?? '', `${id}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        message: { content: '<command-name>/agentdeck-kit:deep-review</command-name>' },
      })}\n`,
    );
    expect(
      guard({
        tool_name: THREAD,
        session_id: id,
        transcript_path: transcript,
        tool_input: { ...MR, body: CARD },
      }),
    ).toBeNull();
  });

  it('ответ в существующем треде и заметка не о ревью навыка не требуют', () => {
    const id = session();
    expect(
      write('mcp__gitlab__create_merge_request_discussion_note', id, 'поправил замечание F-01', {
        discussion_id: 'abc',
      }),
    ).toBeNull();
    expect(write(NOTE, id, 'Пайплайн перезапущен')).toBeNull();
  });

  it('тред не по форме карточки — отказ с названной недостачей', () => {
    const id = session();
    loadSkill(id);
    const broken: [string, string][] = [
      ['severity marker', CARD.slice(CARD.indexOf('F-01'))],
      ['id `F-NN`', CARD.replace('F-01 ', '')],
      ['bold one-line thesis', CARD.replace(/\*\*Ключ[^*]+\*\*/, 'Ключ кэша')],
      ['path:start-end', CARD.replace('**Где:** `src/cache.ts:10-14`', 'в кэше')],
    ];
    for (const [need, body] of broken) {
      const verdict = write(THREAD, id, body);
      expect(verdict?.decision, need).toBe('deny');
      expect(verdict?.reason, need).toContain(need);
    }
    expect(write(THREAD, id, CARD)).toBeNull();
  });

  it('«блокеров нет» без строки покрытия — отказ, со строкой — проходит', () => {
    const id = session();
    loadSkill(id);
    expect(write(NOTE, id, 'Ревью: блокеров нет.')?.decision).toBe('deny');
    expect(write(NOTE, id, 'Review: no blocking findings.')?.decision).toBe('deny');
    expect(write(NOTE, id, 'Ревью: блокеров нет.\n**Ledger:** 12 of 12 files read')).toBeNull();
    expect(write(NOTE, id, '🔴 F-01 — `a.ts:1-2`')).toBeNull();
  });

  it('публикация через glab без загруженного навыка — отказ', () => {
    const id = `rg${seq++}cli`;
    record({ tool_name: 'Bash', session_id: id, tool_input: { command: 'glab mr view 42 -c' } });
    const verdict = guard({
      tool_name: 'Bash',
      session_id: id,
      tool_input: { command: 'glab mr note 42 -m "замечание"' },
    });
    expect(verdict?.reason).toContain('deep-review');
  });
});

describe('чтение обсуждений: вызов ещё не прочитанный список', () => {
  const DISCUSSIONS = 'mcp__gitlab__mr_discussions';
  const text = (value: unknown) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
  ];
  const thread = (n: number) => ({
    id: `d${n}`,
    notes: [{ id: n, author: { username: 'kudimov', name: 'Андрей Кудимов' }, body: 'x' }],
  });
  const page = (n: number, pages: number, total = 27) =>
    text({ items: [thread(n)], pagination: { x_total: total, x_total_pages: pages, x_page: n } });
  /** Сессия с навыком и версиями, но без чтения обсуждений: его делает сам случай. */
  function fresh(): string {
    const id = `rg${seq++}z${Date.now()}`;
    loadSkill(id);
    record({
      tool_name: 'mcp__gitlab__list_merge_request_versions',
      session_id: id,
      tool_input: MR,
    });
    return id;
  }
  const readList = (id: string, tool_response: unknown, extra: HookInput = {}) =>
    record({
      tool_name: DISCUSSIONS,
      session_id: id,
      tool_input: { ...MR, ...extra },
      tool_response,
    });
  const attempt = (id: string) => write(NOTE, id, 'Сводка по MR');

  it('jmespath [].notes[] вернул null — это сбой чтения, а не «обсуждений нет»', () => {
    const id = fresh();
    readList(id, text('null'), { jmespath: '[].notes[].{id:id}' });
    const verdict = attempt(id);
    expect(verdict?.decision).toBe('deny');
    expect(verdict?.reason).toContain('FAILED read');
    expect(verdict?.reason).toContain('items[]');
  });

  it('пустой результат, ошибка, items [] без x_total, голый счётчик и пустая проекция — сбои', () => {
    const failed: [string, unknown, HookInput][] = [
      ['null', null, {}],
      ['isError', { isError: true, content: text('Error: 404') }, {}],
      ['текст ошибки', text('Error: 401 unauthorized'), {}],
      ['items [] при x_total 27', text({ items: [], pagination: { x_total: 27 } }), {}],
      ['items [] без x_total', text({ items: [] }), {}],
      ['счётчик из проекции', text('27'), { jmespath: 'pagination.x_total' }],
      ['пустой список из проекции', text([]), { jmespath: '[].notes[]' }],
      ['pagination без items', text({ pagination: { x_total: 3 } }), {}],
    ];
    for (const [name, response, extra] of failed) {
      const id = fresh();
      readList(id, response, extra);
      expect(attempt(id)?.decision, name).toBe('deny');
    }
  });

  it('настоящая форма с items, доказанно пустой список и сырой массив открывают проверку', () => {
    const ok: [string, unknown][] = [
      ['items', text({ items: [thread(1)], pagination: { x_total: 1, x_total_pages: 1 } })],
      ['x_total 0', text({ items: [], pagination: { x_total: 0 } })],
      ['сырой непустой', text([thread(1)])],
      ['сырой пустой без проекции', text([])],
    ];
    for (const [name, response] of ok) {
      const id = fresh();
      readList(id, response);
      expect(attempt(id), name).toBeNull();
    }
  });

  it('первая страница из двух не открывает проверку, обе — открывают', () => {
    const id = fresh();
    readList(id, page(1, 2));
    const verdict = attempt(id);
    expect(verdict?.decision).toBe('deny');
    expect(verdict?.reason).toContain('page(s) 2 of 2');
    readList(id, page(2, 2), { page: 2 });
    expect(attempt(id)).toBeNull();
  });

  it('неудачное перечитывание не отменяет свежее удачное; удачное после отказа открывает', () => {
    const id = fresh();
    readList(id, page(1, 1, 1));
    readList(id, text('null'), { jmespath: 'x' });
    expect(attempt(id)).toBeNull();

    const refused = fresh();
    expect(attempt(refused)?.decision).toBe('deny');
    readList(refused, text('null'), { jmespath: 'x' });
    expect(attempt(refused)?.decision).toBe('deny');
    readList(refused, page(1, 1, 1));
    expect(attempt(refused)).toBeNull();
  });

  it('без tool_response (CLI не присылает) чтение засчитывается как раньше', () => {
    const id = fresh();
    readList(id, undefined);
    expect(attempt(id)).toBeNull();
  });

  it('чтение через glab api: массив открывает, пустой вывод с --jq — нет', () => {
    const cliRead = (id: string, command: string, stdout: string) =>
      record({
        tool_name: 'Bash',
        session_id: id,
        tool_input: { command },
        tool_response: { stdout, stderr: '', interrupted: false },
      });
    const cliWrite = (id: string) =>
      guard({
        tool_name: 'Bash',
        session_id: id,
        tool_input: { command: 'glab mr note 42 -m "замечание F-01"' },
      });
    const good = fresh();
    cliRead(good, 'glab api projects/1/merge_requests/42/discussions', JSON.stringify([thread(1)]));
    expect(cliWrite(good)).toBeNull();
    const bad = fresh();
    cliRead(bad, 'glab api projects/1/merge_requests/42/discussions --jq ".[].nope"', '');
    expect(cliWrite(bad)?.decision).toBe('deny');
  });

  it('версии читаются в начале ревью: отказ называет discover_tools', () => {
    const id = `rg${seq++}v${Date.now()}`;
    loadSkill(id);
    readList(id, page(1, 1, 1));
    const verdict = write(THREAD, id, CARD);
    expect(verdict?.reason).toContain('START of a review');
    expect(verdict?.reason).toContain('discover_tools');
  });
});

describe('тред стоит на диапазоне из карточки', () => {
  const SHAS = { base_sha: 'a', start_sha: 'b', head_sha: 'c', position_type: 'text' };
  const FILE = { old_path: 'src/cache.ts', new_path: 'src/cache.ts' };
  const range = {
    ...SHAS,
    ...FILE,
    new_line: 14,
    old_line: null,
    line_range: {
      start: { line_code: 'x_10_10', type: 'new', old_line: null, new_line: 10 },
      end: { line_code: 'x_10_14', type: 'new', old_line: null, new_line: 14 },
    },
  };
  const thread = (id: string, position: unknown, body = CARD, extra: HookInput = {}) =>
    write(THREAD, id, body, { position, ...extra });
  const ready = () => {
    const id = session();
    loadSkill(id);
    return id;
  };

  it('карточка 10-14 на однострочной позиции — отказ с готовой формой и инструментом', () => {
    const verdict = thread(ready(), { ...SHAS, ...FILE, new_line: 14, old_line: null });
    expect(verdict?.decision).toBe('deny');
    expect(verdict?.reason).toContain('RANGE');
    expect(verdict?.reason).toContain('review-position');
    expect(verdict?.reason).toContain('10-14');
    expect(verdict?.reason).toContain('anchors 14');
  });

  it('та же карточка с line_range 10..14 проходит, в том числе позицией-строкой JSON', () => {
    const id = ready();
    expect(thread(id, range)).toBeNull();
    expect(thread(id, JSON.stringify(range))).toBeNull();
  });

  it('другой диапазон и другой файл — отказ', () => {
    const id = ready();
    expect(
      thread(id, { ...range, line_range: { start: { new_line: 11 }, end: { new_line: 14 } } })
        ?.decision,
    ).toBe('deny');
    expect(
      thread(id, { ...range, new_path: 'src/other.ts', old_path: 'src/other.ts' })?.decision,
    ).toBe('deny');
  });

  it('однострочная карточка: своя строка проходит (и удалённая по old_line), чужая — отказ', () => {
    const id = ready();
    const one = CARD.replace('src/cache.ts:10-14', 'src/cache.ts:14');
    expect(thread(id, { ...SHAS, ...FILE, new_line: 14 }, one)).toBeNull();
    expect(thread(id, { ...SHAS, ...FILE, old_line: 14, new_line: null }, one)).toBeNull();
    expect(thread(id, { ...SHAS, ...FILE, new_line: 15 }, one)?.decision).toBe('deny');
  });

  it('форма GitHub start_line + line проверяется так же', () => {
    const id = ready();
    expect(write(THREAD, id, CARD, { path: 'src/cache.ts', start_line: 10, line: 14 })).toBeNull();
    expect(write(THREAD, id, CARD, { path: 'src/cache.ts', line: 14 })?.decision).toBe('deny');
  });

  it('без номеров строк в вызове проверка молчит', () => {
    expect(write(THREAD, ready(), CARD)).toBeNull();
  });
});

describe('имя человека в публикуемом тексте — только из данных', () => {
  const text = (value: unknown) => [{ type: 'text', text: JSON.stringify(value) }];
  function seeded(people: { username: string; name: string }[]): string {
    const id = session();
    loadSkill(id);
    record({
      tool_name: 'mcp__gitlab__get_merge_request',
      session_id: id,
      tool_input: MR,
      tool_response: text({ iid: 42, author: people[0], reviewers: people.slice(1) }),
    });
    return id;
  }
  const note = (id: string, body: string) => write(NOTE, id, body);

  it('«треды Андрея», когда в данных лишь username kudimov, — отказ', () => {
    const id = seeded([{ username: 'kudimov', name: 'kudimov' }]);
    const verdict = note(id, 'Сводка: открытые треды Андрея не повторены.');
    expect(verdict?.decision).toBe('deny');
    expect(verdict?.reason).toContain('Андрея');
    expect(verdict?.reason).toContain('impersonal');
    expect(note(id, 'Сводка: открытые треды не повторены.')).toBeNull();
    expect(note(id, 'Сводка: открытые треды @kudimov не повторены.')).toBeNull();
  });

  it('то же имя из данных API (в другом падеже) проходит', () => {
    const id = seeded([{ username: 'kudimov', name: 'Андрей Кудимов' }]);
    expect(note(id, 'Сводка: открытые треды Андрея не повторены.')).toBeNull();
  });

  it('английские формы: «Andrew’s threads» без данных — отказ, с данными — проходит', () => {
    const bad = seeded([{ username: 'kudimov', name: 'kudimov' }]);
    expect(note(bad, 'Summary: Andrew’s threads were not repeated.')?.decision).toBe('deny');
    const good = seeded([{ username: 'kudimov', name: 'Andrew Kudimov' }]);
    expect(note(good, 'Summary: Andrew’s threads were not repeated.')).toBeNull();
  });

  it('@-упоминание не прочитанного логина — отказ; в коде и e-mail — не упоминание', () => {
    const id = seeded([{ username: 'kudimov', name: 'kudimov' }]);
    expect(note(id, 'Спасибо @andrey за идею.')?.reason).toContain('@andrey');
    expect(note(id, 'Сводка: декоратор `@Transactional` на месте.')).toBeNull();
    expect(note(id, 'Сводка: писать на dev@example.com')).toBeNull();
  });

  it('без прочитанных имён проверка молчит; ответ в треде проверяется тоже', () => {
    const quiet = session();
    loadSkill(quiet);
    expect(note(quiet, 'Сводка: открытые треды Андрея.')).toBeNull();
    const id = seeded([{ username: 'kudimov', name: 'kudimov' }]);
    expect(
      write('mcp__gitlab__create_merge_request_discussion_note', id, 'Спасибо Андрею', {
        discussion_id: 'x',
      })?.decision,
    ).toBe('deny');
  });
});
