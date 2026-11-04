import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { geminiRunFacts } from '@agentdeck/providers/gemini';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
import type { SessionSpec } from '../../../adapter.types.ts';
import { createGeminiAdapter, GEMINI_CHANNELS, GEMINI_FILES } from '../../../gemini/index.ts';
import { createKimiAdapter, KIMI_CHANNELS, KIMI_FILES } from '../../../kimi/index.ts';
import type { RpcAdapter, RpcAdapterOptions } from '../../../rpc-stdio/rpc-adapter.ts';
import { GEMINI_RESUME, KIMI_RESUME } from './resume-seeds.ts';
import type { ResumeProfile } from './rpc-profile.types.ts';
import { ENDPOINT } from './shared.ts';

/**
 * Профиль переходника поверх ACP для набора соответствия (`acp.conformance.test.ts`): записи
 * живого CLI в контейнере `tools/core-linux.mjs --clis` (02.11, stub-model, подставной git)
 * проигрывает `replay-rpc.mjs`. Своя форма: у ACP нет шага доверия хуку (Codex), а защита ядра —
 * либо хук в файле сеанса (`hook`), либо файл оверлея (`overlay`).
 */
export interface AcpProfile {
  id: string;
  /** Продолжение разговора — у переходника с `caps.resume`. */
  resume?: ResumeProfile;
  make(options: RpcAdapterOptions): RpcAdapter;
  command: string;
  endpoint: SessionSpec['endpoint'];
  argv: string[];
  fixtures: {
    /** Два хода текстом (`ANSWER_ONE`, `ANSWER_TWO`). */
    basic: string;
    /** `git status` под вопросом о праве; ответ «да» → вызов исполнен, `DONE_AFTER_TOOL`. */
    permit: string;
    /** `git push origin main` отказан защитой ядра (хук или политика) → `DONE_AFTER_TOOL`. */
    blocked: string;
  };
  /** Имя инструмента оболочки, как его видят хук ядра и судья. */
  shellTool: string;
  /** Вариант ответа «разрешить один раз» в вопросе о праве записи. */
  allowOnce: string;
  /** Текст защиты ядра в файлах сеанса: команда хука или правила оверлея. */
  guard(dir: string): string;
  /** Отчёт об использовании токенов в ответе хода (у Kimi 2.4.1 его нет). */
  usage: boolean;
}

const fixture = (cli: string, name: string): string =>
  fileURLToPath(new URL(`../../../${cli}/__fixtures__/acp-${name}.jsonl`, import.meta.url));

export const GEMINI_ACP_PROFILE: AcpProfile = {
  id: geminiRunFacts.id,
  resume: GEMINI_RESUME,
  make: (options) => createGeminiAdapter(options),
  command: geminiRunFacts.binary.command,
  endpoint: {
    channel: GEMINI_CHANNELS[0]!,
    endpoint: { ...ENDPOINT, dialect: 'google-genai' },
  },
  argv: ['--acp'],
  fixtures: {
    basic: fixture('gemini', 'basic'),
    permit: fixture('gemini', 'status'),
    blocked: fixture('gemini', 'push'),
  },
  shellTool: 'run_shell_command',
  allowOnce: 'proceed_once',
  guard: (dir) => readFileSync(join(dir, GEMINI_FILES.policy), 'utf8'),
  usage: true,
};

export const KIMI_ACP_PROFILE: AcpProfile = {
  id: kimiRunFacts.id,
  resume: KIMI_RESUME,
  make: (options) => createKimiAdapter(options),
  command: kimiRunFacts.binary.command,
  endpoint: {
    channel: KIMI_CHANNELS[0]!,
    endpoint: { ...ENDPOINT, dialect: 'openai-chat' },
  },
  argv: ['acp'],
  fixtures: {
    basic: fixture('kimi', 'basic'),
    permit: fixture('kimi', 'status'),
    blocked: fixture('kimi', 'push'),
  },
  shellTool: 'Bash',
  allowOnce: 'approve_once',
  guard: (dir) => readFileSync(join(dir, KIMI_FILES.config), 'utf8'),
  usage: false,
};

export const ACP_PROFILES: readonly AcpProfile[] = [GEMINI_ACP_PROFILE, KIMI_ACP_PROFILE];
