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
