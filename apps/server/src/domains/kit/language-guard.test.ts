import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * language-guard комплекта: машинная нагрузка в `.agent/tmp` (блок ```agentdeck:*``` — ответы
 * сит, данные доставки) не считается прозой. Её строки — доказательства, их читает инструмент,
 * лента панели их вырезает (аудит g0, F-07: группа обошла отказ маркером для людских файлов).
 * Запуск — через диспетчер событий, как его зовёт hooks.json.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-lang-guard-'));
const AG = join(dir, '.agent');
const TMP = join(AG, 'tmp');
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ru =
  '# Заметки агента\n\nЭтот документ описывает архитектуру проекта и содержит важные сведения о том, ' +
  'как устроены хуки, скиллы и правила работы агента в этом репозитории. Здесь накапливаются решения.';
const en =
  '# Notes\n\nThis document describes the architecture and the hooks used in this repository, with ' +
  'decisions and gotchas collected over time by the agent.';
const sieveJson =
  '{"sieve":"tests","verdict":"fail","evidence":"Кейс номер семь красный на основной ветке, ' +
  'причина в окружении стенда: база не поднялась, повтор не помог, задача ждёт решения человека."}';
const fenced = (body: string, tag = 'agentdeck:sieves') => '```' + tag + '\n' + body + '\n```\n';
const payload = 'Sieve answers for this delivery.\n\n' + fenced(sieveJson);
const STALE = 'reloads every session';

const onDisk = join(TMP, 'answer-disk.md');
writeFileSync(onDisk, payload, 'utf8');
const proseNote = join(TMP, 'note-disk.md');
writeFileSync(proseNote, en, 'utf8');

/** The language-guard verdict only: another kit guard's word is not this module's. */
function guard(tool_name: string, tool_input: object): { decision: string; reason: string } {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input,
      session_id: 'kit-lang-guard',
      cwd: dir,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
    },
    timeout: 15_000,
  }).stdout.trim();
  const hook = out
    ? (
        JSON.parse(out) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        }
      ).hookSpecificOutput
    : undefined;
  const reason = hook?.permissionDecisionReason ?? '';
  const own = /language-guard|non-English language/.test(reason);
  return {
    decision: own ? (hook?.permissionDecision ?? 'allow') : 'allow',
    reason: own ? reason : '',
  };
}

const write = (file: string, content: string) => guard('Write', { file_path: file, content });

describe('language-guard: машинная нагрузка в .agent/tmp', () => {
  it('буквы внутри блока agentdeck:* в tmp не считаются', () => {
    expect(write(join(TMP, 'answer-sieves.md'), payload).decision).toBe('allow');
  });

  it('незакрытый блок agentdeck:* в tmp — всё ещё данные', () => {
    const open = 'Sieve answers.\n\n```agentdeck:sieves\n' + sieveJson + '\n';
    expect(write(join(TMP, 'answer-open.md'), open).decision).toBe('allow');
  });

  it('блок agentdeck:* вне tmp судится как проза', () => {
    expect(write(join(AG, 'answer-sieves.md'), payload).decision).toBe('deny');
  });

  it('обычный блок кода в tmp судится как проза', () => {
    expect(write(join(TMP, 'plain.md'), 'Notes.\n\n' + fenced(sieveJson, 'json')).decision).toBe(
      'deny',
    );
  });

  it('русская проза рядом с блоком в tmp судится, без «reloads every session»', () => {
    const v = write(join(TMP, 'mixed.md'), ru + '\n\n' + fenced('{"verdict":"pass"}'));
    expect(v.decision).toBe('deny');
    expect(v.reason).not.toContain(STALE);
    expect(v.reason).toContain('agentdeck:');
  });

  it('правка внутри блока agentdeck:* файла в tmp проходит', () => {
    const v = guard('Edit', {
      file_path: onDisk,
      old_string: '"verdict":"fail"',
      new_string:
        '"verdict":"fail","note":"Кейс красный на основной ветке, причина в окружении стенда: ' +
        'база не поднялась, повтор не помог, задача ждёт решения человека."',
    });
    expect(v.decision).toBe('allow');
  });

  it('правка прозы заметки в tmp судится', () => {
    const v = guard('Edit', { file_path: proseNote, old_string: 'This document', new_string: ru });
    expect(v.decision).toBe('deny');
    expect(v.reason).not.toContain(STALE);
  });

  it('отказ вне tmp сохраняет причину о перезагрузке', () => {
    const v = write(join(AG, 'reload-reason.md'), ru);
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain(STALE);
  });
});
