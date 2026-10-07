/**
 * Одноразовый стенд не передаёт чужому CLI переменные его дома из оболочки человека.
 *
 * Зачем. `throwaway-stand.mjs` подменяет HOME/USERPROFILE/APPDATA, но `XDG_*`,
 * `CODEX_HOME`, `GOOSE_*`, `KIMI_*`, `OPENCODE_CONFIG*`, `GEMINI_CLI_*` раньше
 * наследовались как есть: заданная в оболочке, такая переменная направила бы
 * настоящий CLI на стенде в настоящий дом человека.
 *
 * Как. Проверка запускает саму себя второй раз с этими переменными в окружении
 * запуска — это и есть «оболочка человека». Второй запуск поднимает стенд с
 * фальшивым `goose`, который сбрасывает своё окружение в файл, и вызывает
 * `GET /api/chat/cli?provider=goose&refresh=1`: панель сама запускает
 * `goose --version` тем же путём, что и всегда. Сверяется то, что ДОШЛО до
 * процесса CLI:
 *   - переменные из оболочки отрезаны;
 *   - переменные, которые проверка задала сама (`process.env` после импорта
 *     стенда, или опцией `env`), дошли — так работают `check-foreign-steer` и
 *     соседи, и чистка не должна их сломать;
 *   - посторонняя переменная оболочки дошла — чистка не режет лишнего;
 *   - настоящие каталоги CLI человека не изменились (снимок до/после).
 *
 * Запуск: node tools/qa/check-stand-env-scrub.mjs — код 0/1, 2 = стенд не поднялся.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffRealProviderDirs, runOnStand, snapshotRealProviderDirs } from './throwaway-stand.mjs';

const SELF = fileURLToPath(import.meta.url);

/** Пришло «из оболочки» — обязано быть отрезано. */
const FROM_SHELL = {
  GOOSE_TEST_VAR: 'shell-goose',
  XDG_CONFIG_HOME: 'C:/shell/xdg-config',
  XDG_DATA_HOME: 'C:/shell/xdg-data',
  CODEX_HOME: 'C:/shell/codex',
  KIMI_CODE_HOME: 'C:/shell/kimi',
  OPENCODE_CONFIG: 'C:/shell/opencode.json',
  OPENCODE_CONFIG_DIR: 'C:/shell/opencode',
  GEMINI_CLI_HOME: 'C:/shell/gemini',
  QWEN_HOME: 'C:/shell/qwen',
};
/** Посторонняя переменная оболочки — обязана дойти. */
const UNRELATED = { SCRUB_PROBE_UNRELATED: 'shell-unrelated' };

if (process.argv[2] !== '--child') {
  const result = spawnSync(process.execPath, [SELF, '--child'], {
    env: { ...process.env, ...FROM_SHELL, ...UNRELATED },
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exit(result.status ?? 1);
}

// Второй запуск: то, что проверка задаёт сама после импорта стенда.
process.env.QWEN_HOME = 'check-qwen';
process.env.GOOSE_PROVIDER = 'check-goose';

const FAKE_GOOSE = `import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'goose-env.json'), JSON.stringify({ ...process.env }), 'utf8');
console.log('goose 1.0.0');
`;

/** Значение переменной без учёта регистра имени (Windows). */
const pick = (env, name) =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];

const before = snapshotRealProviderDirs();

await runOnStand(
  {
    web: false,
    noClaude: true,
    label: 'env-scrub',
    settings: { provider: 'goose' },
    fakeCli: { goose: FAKE_GOOSE },
    env: { KIMI_EXPLICIT_PROBE: 'explicit' },
  },
  async (stand, check) => {
    const cli = await stand.api('/chat/cli?provider=goose&refresh=1');
    const dump = join(stand.bin, 'goose-env.json');
    check(
      'панель запустила фальшивый goose (--version) и он сбросил окружение',
      existsSync(dump),
      `статус ${cli.status}: ${cli.text.slice(0, 300)}`,
    );
    if (!existsSync(dump)) return;
    const seen = JSON.parse(readFileSync(dump, 'utf8'));

    for (const [name, value] of Object.entries(FROM_SHELL)) {
      const got = pick(seen, name);
      check(`${name} из оболочки до CLI не дошла`, got !== value, `CLI увидел ${name}=${got}`);
    }
    check(
      'QWEN_HOME, переставленная проверкой, дошла её значением',
      pick(seen, 'QWEN_HOME') === 'check-qwen',
      `увидел ${pick(seen, 'QWEN_HOME')}`,
    );
    check(
      'GOOSE_PROVIDER, заданная проверкой, дошла',
      pick(seen, 'GOOSE_PROVIDER') === 'check-goose',
      `увидел ${pick(seen, 'GOOSE_PROVIDER')}`,
    );
    check(
      'опция env дошла (KIMI_EXPLICIT_PROBE)',
      pick(seen, 'KIMI_EXPLICIT_PROBE') === 'explicit',
      `увидел ${pick(seen, 'KIMI_EXPLICIT_PROBE')}`,
    );
    check(
      'посторонняя переменная оболочки дошла — чистка не режет лишнего',
      pick(seen, 'SCRUB_PROBE_UNRELATED') === 'shell-unrelated',
      `увидел ${pick(seen, 'SCRUB_PROBE_UNRELATED')}`,
    );
    check(
      'дом CLI — временный дом стенда',
      pick(seen, 'USERPROFILE') === stand.home && pick(seen, 'HOME') === stand.home,
      `USERPROFILE=${pick(seen, 'USERPROFILE')}`,
    );

    const changed = diffRealProviderDirs(before, snapshotRealProviderDirs());
    check(
      'настоящие каталоги CLI человека не изменились',
      changed.length === 0,
      changed
        .slice(0, 10)
        .map((entry) => `${entry.path}: ${entry.before} → ${entry.after}`)
        .join('\n    '),
    );
  },
);
