import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gooseSessionDb } from '../../../goose/transcript.ts';
import { GEMINI_HOME_DIR } from '../../../gemini/transcript.ts';
import { KIMI_HOME_DIR } from '../../../kimi/transcript.ts';
import type { ResumeProfile } from './rpc-profile.types.ts';

/**
 * Разговоры в доме прежней сессии ядра — в форме, которую снял пробой каждого CLI (02.11): Codex —
 * файл нити с `session_meta`, Goose — база с одной строкой `sessions`, Kimi — указатель и каталог
 * разговора с `state.json`. Набор соответствия проверяет по ним путь продолжения до CLI.
 */

const CODEX_THREAD = '01a19a70-fb10-7240-81fd-83da3012ce29';
const KIMI_SESSION = 'session_0b6f6a52-3a51-4c8e-9a3b-2f1d6c7e8a90';

export const CODEX_RESUME: ResumeProfile = {
  method: 'thread/resume',
  idParam: 'threadId',
  seed: (priorDir, cwd) => {
    const dir = join(priorDir, 'codex-home', 'sessions', '2026', '11', '02');
    mkdirSync(dir, { recursive: true });
    const meta = { type: 'session_meta', payload: { id: CODEX_THREAD, cwd } };
    writeFileSync(
      join(dir, `rollout-2026-11-02T09-07-38-${CODEX_THREAD}.jsonl`),
      `${JSON.stringify(meta)}\n`,
    );
    return CODEX_THREAD;
  },
  forged: '01a19a70-0000-7000-8000-000000000000',
};

export const GOOSE_RESUME: ResumeProfile = {
  method: 'session/load',
  idParam: 'sessionId',
  seed: (priorDir, cwd) => {
    const { DatabaseSync } = process.getBuiltinModule(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const file = gooseSessionDb(priorDir);
    mkdirSync(join(file, '..'), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL)');
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run('20261102_1', cwd);
    } finally {
      db.close();
    }
    return '20261102_1';
  },
  forged: '20261102_9',
};

const GEMINI_CHAT = '666fce9e-0bbe-438e-9d26-44e483366d60';

/** Gemini 0.66: файл разговора под меткой проекта и `.project_root` этой метки (проба 03.11). */
export const GEMINI_RESUME: ResumeProfile = {
  method: 'session/load',
  idParam: 'sessionId',
  seed: (priorDir, cwd) => {
    const tmp = join(priorDir, GEMINI_HOME_DIR, '.gemini', 'tmp', 'work');
    mkdirSync(join(tmp, 'chats'), { recursive: true });
    writeFileSync(join(tmp, '.project_root'), cwd);
    writeFileSync(
      join(tmp, 'chats', `session-2026-11-03T07-54-${GEMINI_CHAT.slice(0, 8)}.jsonl`),
      `${JSON.stringify({ sessionId: GEMINI_CHAT, projectHash: 'h', kind: 'main' })}\n`,
    );
    return GEMINI_CHAT;
  },
  forged: '666fce9e-0000-4000-8000-000000000000',
};

export const KIMI_RESUME: ResumeProfile = {
  method: 'session/load',
  idParam: 'sessionId',
  seed: (priorDir, cwd) => {
    const home = join(priorDir, KIMI_HOME_DIR);
    const dir = join(home, 'sessions', 'wd_work_ab12', KIMI_SESSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ id: KIMI_SESSION, cwd }));
    writeFileSync(
      join(home, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId: KIMI_SESSION, sessionDir: dir, workDir: cwd })}\n`,
    );
    return KIMI_SESSION;
  },
  forged: 'session_9d2c1e4b-0000-4000-8000-000000000000',
};
