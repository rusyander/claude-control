import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Свой temp на прогон набора. Сотни тестов заводят каталоги через `tmpdir()`, и
 * часть их переживала тест: процесс, отпущенный тестом, дописывал файлы уже после
 * уборки, отделившийся браузер печати держал профиль, а каталог, бывший cwd живого
 * ребёнка, не удалялся. За три дня в настоящем temp легли тысячи каталогов `cc-*`.
 * Здесь всё временное ложится в один каталог прогона, и он уходит целиком в конце.
 * Сам каталог — в настоящем temp, а не в репозитории: тесты «вне репозитория»
 * полагаются на то, что над их проектом нет git.
 */
// GIT_CEILING_DIRECTORIES: git в проекте теста не ищет репозиторий выше temp. Без
// неё проект без своего `git init`, оказавшийся внутри чужого репозитория,
// становился его частью: 07.10 прогон завёл в настоящем репозитории 128 копий
// с ветками — песочница тогда лежала внутри него.
const VARS = ['TEMP', 'TMP', 'TMPDIR', 'GIT_CEILING_DIRECTORIES'] as const;
const saved = new Map<string, string | undefined>();
let sandbox: string | undefined;

export function setup(): void {
  // Имя короткое и без слов продукта: «agentdeck…» в пути прятал процессы теста
  // от сканера CLI (свои процессы панели он пропускает), «agent» ломал сверки
  // путей, а лишние 30 знаков в каждом пути выводили инструкции набора за предел
  // и запрос — в 414.
  sandbox = mkdtempSync(join(tmpdir(), 'vt-'));
  for (const name of VARS) {
    saved.set(name, process.env[name]);
    // Потолок — сам каталог прогона: репозиторий, заведённый тестом внутри него,
    // находится, а всё, что выше, — нет. Путём «как на диске»: короткое имя
    // Windows (`RUSYAN~1`) git с потолком не сопоставляет.
    process.env[name] = name === 'GIT_CEILING_DIRECTORIES' ? realpathSync.native(sandbox) : sandbox;
  }
}

export async function teardown(): Promise<void> {
  for (const name of VARS) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (!sandbox) return;
  // Дети, отпущенные последними тестами, ещё выходят и держат свой cwd: ждём их
  // до 10 с. Не дождались — каталог прогона один, а не тысячи.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(sandbox, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
