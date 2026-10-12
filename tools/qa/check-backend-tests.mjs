/**
 * Тесты бэкенда в разделе «Тесты» — живой стенд, НАСТОЯЩИЕ go, cargo и pytest
 * (через uv), настоящий UI.
 *
 * Одноразовая панель (`throwaway-stand.mjs`), в ней четыре проекта:
 *
 * - `goshop` — модуль Go: зелёный, красный, пропущенный тест, подтесты и пакет,
 *   который не собирается. Путь проходит ЧЕРЕЗ ЭКРАН: блок «Команда прогона»
 *   показывает рецепт → «Взять» → «Сохранить» → «Прогнать автотесты» →
 *   «Завести кейсы (N)»; дальше API: второй прогон ложится на кейсы целиком,
 *   «Только группа» сужает `go test` до пакета группы;
 * - `rshop` — крейт Cargo: юнит-тесты модулей, интеграционный, doc-тест,
 *   игнорируемый; суть падения — текст assert'а; пока идёт сборка, команду не
 *   переписать (409);
 * - `pyshop` — pytest через uv: параметризованный тест — один кейс на все
 *   наборы;
 * - `mvnshop` — Maven без `mvn` на машине: рецепт называет нехватку и ссылку
 *   на установку ДО прогона (экран), прогон честно говорит «отчёта нет», в
 *   выводе — причина.
 *
 * Gradle здесь не гоняется: на машине проверки его нет, а качать дистрибутив
 * и зависимости ради одной строки — дольше всей проверки. Его рецепт доказан
 * юнит-тестами (`recipes.test.ts`) и общим путём каталога отчётов (Maven).
 *
 * Тулчейны берутся настоящие из PATH; дом стенда — временный, поэтому каталоги
 * rustup/cargo, кэши go и uv передаются явно (иначе rustup без своего дома не
 * знает тулчейна, а uv и go собирали бы кэш заново).
 *
 * Запуск: `node tools/qa/check-backend-tests.mjs`. Снимки — в
 * `.agent/screenshots/before-after/backend-tests/`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { NotChecked, REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { dismissAccess } from './chat-walk.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'backend-tests');
mkdirSync(SHOTS, { recursive: true });

const has = (command, args) =>
  spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: true }).status === 0;
const goEnv = (name) =>
  spawnSync('go', ['env', name], { encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';

/** Каталоги настоящих тулчейнов: дом стенда временный, а они живут в доме человека. */
function toolchainEnv() {
  const home = homedir();
  const env = {
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(home, '.rustup'),
    CARGO_HOME: process.env.CARGO_HOME ?? join(home, '.cargo'),
  };
  for (const name of ['GOCACHE', 'GOPATH', 'GOMODCACHE']) {
    const value = goEnv(name);
    if (value) env[name] = value;
  }
  const uvCache = spawnSync('uv', ['cache', 'dir'], { encoding: 'utf8', windowsHide: true });
  if (uvCache.status === 0) env.UV_CACHE_DIR = uvCache.stdout.trim();
  return env;
}

const put = (root, path, body) => {
  const full = join(root, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
};

const GO_FILES = {
  'go.mod': 'module example.com/goshop\n\ngo 1.22\n',
  'orders/orders.go': 'package orders\n\nfunc Total(a, b int) int { return a + b }\n',
  'orders/orders_test.go': `package orders

import "testing"

func TestTotal(t *testing.T) {
	if Total(2, 2) != 4 {
		t.Fatal("bad")
	}
}

func TestTotalBroken(t *testing.T) {
	if got := Total(2, 2); got != 5 {
		t.Errorf("Total(2,2) = %d, want 5", got)
	}
}

func TestSkipped(t *testing.T) { t.Skip("needs db") }

func TestTable(t *testing.T) {
	for _, name := range []string{"one", "two"} {
		t.Run(name, func(t *testing.T) {
			if name == "two" {
				t.Fatal("two fails")
			}
		})
	}
}
`,
  'pay/pay.go': 'package pay\n\nfunc Fee(sum int) int { return sum / 100 }\n',
  'pay/pay_test.go':
    'package pay\n\nimport "testing"\n\nfunc TestFee(t *testing.T) {\n\tif Fee(1000) != 10 {\n\t\tt.Fatal("fee")\n\t}\n}\n',
  'broken/broken.go': 'package broken\n\nfunc Bad() int { return "x" }\n',
  'broken/broken_test.go':
    'package broken\n\nimport "testing"\n\nfunc TestBad(t *testing.T) { _ = Bad() }\n',
};

const CARGO_FILES = {
  'Cargo.toml':
    '[package]\nname = "rshop"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
  'src/lib.rs': `pub mod orders;

/// Adds two numbers.
///
/// \`\`\`
/// assert_eq!(rshop::add(1, 2), 3);
/// \`\`\`
pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    #[test]
    fn adds() { assert_eq!(super::add(2, 2), 4); }

    #[test]
    #[ignore = "needs db"]
    fn slow() {}
}
`,
  'src/orders.rs': `pub fn total(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    #[test]
    fn total_ok() { assert_eq!(super::total(1, 1), 2); }

    #[test]
    fn total_broken() { assert_eq!(super::total(2, 2), 5, "want five"); }
}
`,
  'tests/api.rs': '#[test]\nfn api_works() { assert_eq!(rshop::add(0, 0), 0); }\n',
};

const PY_FILES = {
  'pyproject.toml':
    '[project]\nname = "pyshop"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  'tests/test_pay.py': `import pytest


def refund(a, b):
    return a - b


@pytest.mark.parametrize("a,b", [(3, 1), (5, 2)])
def test_refund(a, b):
    assert refund(a, b) > 0


def test_charge_fails():
    assert refund(1, 1) == 1, "charge must leave one"
`,
};

const MAVEN_FILES = {
  'pom.xml':
    '<project><modelVersion>4.0.0</modelVersion><groupId>com.shop</groupId><artifactId>api</artifactId><version>1</version></project>\n',
  'src/test/java/com/shop/PayTest.java': 'package com.shop;\n\nclass PayTest {}\n',
};

const tools = {
  go: has('go', ['version']),
  cargo: has('cargo', ['--version']),
  uv: has('uv', ['--version']),
  mvn: has('mvn', ['-v']),
};
if (!tools.go) throw new Error('go не найден в PATH — проверка гоняет настоящий go test');

let dirs = {};

await runOnStand(
  {
    label: 'backend-tests',
    settings: { theme: 'system' },
    env: toolchainEnv(),
    seed: ({ root }) => {
      dirs = {
        go: join(root, 'demo', 'goshop'),
        cargo: join(root, 'demo', 'rshop'),
        py: join(root, 'demo', 'pyshop'),
        mvn: join(root, 'demo', 'mvnshop'),
        stranger: join(root, 'outside', 'stranger'),
      };
      for (const [files, dir] of [
        [GO_FILES, dirs.go],
        [CARGO_FILES, dirs.cargo],
        [PY_FILES, dirs.py],
        [MAVEN_FILES, dirs.mvn],
      ]) {
        for (const [path, body] of Object.entries(files)) put(dir, path, body);
      }
      mkdirSync(dirs.stranger, { recursive: true });
      if (tools.uv) {
        // uv.lock — признак проекта uv: по нему рецепт и выбирает `uv run`.
        const lock = spawnSync('uv', ['lock', '--quiet'], {
          cwd: dirs.py,
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, ...toolchainEnv() },
        });
        tools.uvLock = lock.status === 0;
        if (!tools.uvLock) console.log(`uv lock не прошёл: ${lock.stderr}`);
      }
    },
  },
  async (stand, check) => {
    const ids = {};
    for (const [name, path] of Object.entries(dirs)) {
      if (name === 'stranger') continue;
      const added = await stand.api('/projects', { method: 'POST', body: { path, name } });
      if (added.status >= 300 || !added.body?.id) {
        throw new NotChecked(`проект ${name} не добавился: ${added.text}`);
      }
      ids[name] = added.body.id;
    }
    const q = (path) => `path=${encodeURIComponent(path)}`;
    const info = async (path) => (await stand.api(`/project-tests/automation?${q(path)}`)).body;
    const view = async (path) => (await stand.api(`/project-tests?${q(path)}`)).body;
    const save = (path, automation) =>
      stand.api('/project-tests/automation', { method: 'PUT', body: { path, ...automation } });
    const startRun = (path, extra = {}) =>
      stand.api('/project-tests/e2e/run', { method: 'POST', body: { path, ...extra } });
    const adopt = (path) =>
      stand.api('/project-tests/e2e/adopt', { method: 'POST', body: { path } });
    const settle = async (path, seconds = 300) => {
      for (let i = 0; i < seconds * 2; i += 1) {
        const current = await view(path);
        if (current.e2eRun?.finishedAt) return current;
        await wait(500);
      }
      throw new Error(`прогон ${path} не кончился за ${seconds} с`);
    };
    const cases = (current) => current.groups.flatMap((group) => group.cases);

    // ── Go через экран ────────────────────────────────────────────────────────
    console.log('Go: рецепт → запись → прогон → «Завести кейсы» (экран)');
    const goInfo = await info(dirs.go);
    const goRecipe = goInfo.recipes.find((recipe) => recipe.id === 'go:');
    check(
      'Go: рецепт по go.mod — go test -json по пакетам, go на машине есть',
      goRecipe?.automation.command === 'go test -json {packages} > {report}' &&
        goRecipe?.automation.format === 'go-test-json' &&
        !goRecipe?.missing,
      JSON.stringify(goRecipe),
    );

    const browser = await chromium.launch();
    try {
      // Своя страница из контекста: axe работает только на странице из newContext().
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        colorScheme: 'light',
      });
      const page = await context.newPage();
      // У раздела тестов свой запомненный проект (реестровый id), вкладка его не
      // переключает — без этой записи раздел открыл бы первый проект реестра.
      const openTests = async (key) => {
        await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
        await page.evaluate((id) => localStorage.setItem('agentdeck:tests-project', id), ids[key]);
        await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
        await dismissAccess(page);
        await page.locator('[data-testid="tests-e2e-card"]').waitFor({ timeout: 60_000 });
      };
      const card = page.locator('[data-testid="tests-e2e-card"]');

      await openTests('go');
      const recipes = page.locator('[data-testid="tests-automation-recipes"]');
      await recipes.waitFor({ timeout: 30_000 });
      const recipeText = await recipes.innerText();
      check(
        'экран: рецепт Go назван со стеком, файлом-признаком, числом файлов тестов и командой',
        /Go · корень проекта/.test(recipeText) &&
          /узнан по go\.mod/.test(recipeText) &&
          /3 файла тестов/.test(recipeText) &&
          recipeText.includes('go test -json {packages} > {report}'),
        recipeText,
      );
      await card.screenshot({ path: join(SHOTS, 'go-01-recipes.png') });

      await recipes.getByRole('button', { name: 'Взять' }).first().click();
      const command = card.getByLabel('Команда', { exact: true });
      check(
        'экран: «Взять» подставляет команду рецепта в поле',
        (await command.inputValue()) === 'go test -json {packages} > {report}',
      );
      // Отрицательная строка: пустая команда не сохраняется — кнопка закрыта.
      await command.fill('   ');
      check(
        'экран: пустая команда — «Сохранить» закрыта',
        await card.getByRole('button', { name: 'Сохранить' }).isDisabled(),
      );
      await command.fill('go test -json {packages} > {report}');
      await card.getByRole('button', { name: 'Сохранить' }).click();
      await page.locator('[data-testid="tests-automation-current"]').waitFor({ timeout: 15_000 });
      check(
        'экран: команда записана — строкой, с видом отчёта, и в automation.json',
        (await info(dirs.go)).automation?.format === 'go-test-json' &&
          /go test -json → панель переводит|вывод go test -json/.test(await card.innerText()),
      );

      await card.getByRole('button', { name: 'Прогнать автотесты' }).click();
      const adoptButton = card.getByRole('button', { name: /^Завести кейсы \(\d+\)$/ });
      await adoptButton.waitFor({ timeout: 180_000 });
      const firstRun = (await view(dirs.go)).e2eRun;
      check(
        'прогон Go: настоящий go test -json переведён — 8 результатов (7 тестов и «(build)»), go вышел с 1',
        firstRun?.status === 'done' &&
          firstRun.exitCode === 1 &&
          firstRun.imported?.read === 8 &&
          firstRun.imported?.matched === 0 &&
          firstRun.imported?.unmatched === 8,
        JSON.stringify({ ...firstRun, log: firstRun?.log.slice(-600) }),
      );
      check(
        'экран: «Завести кейсы (7)» — «(build)» в счёт кнопки не вошёл',
        firstRun?.adoptable === 7 && (await adoptButton.innerText()).includes('(7)'),
        String(firstRun?.adoptable),
      );
      // Итог прогона — блок role=status карточки; у папки e2e стенда своя кнопка «Обновить из папки».
      const outcomeText = async () => (await card.getByRole('status').allInnerTexts()).join('\n');
      const firstText = await outcomeText();
      check(
        'экран: итог называет тесты без кейса и несобравшийся пакет, а не «нет ни одного теста» и «странный код»',
        firstText.includes('Тестов в отчёте: 7 — кейсов у них пока нет.') &&
          firstText.includes('Не собрался 1 пакет') &&
          !firstText.includes('нет ни одного теста') &&
          !firstText.includes('хотя упавших тестов нет') &&
          !firstText.includes('Обновить из папки'),
        firstText.slice(0, 900),
      );
      await card.screenshot({ path: join(SHOTS, 'go-02-run-adopt.png') });

      await adoptButton.click();
      await card.getByText(/Заведено 7 кейсов/).waitFor({ timeout: 15_000 });
      const adoptedView = await view(dirs.go);
      const goCases = cases(adoptedView);
      const total = goCases.find((item) => item.title === 'TestTotal');
      check(
        'экран: 7 кейсов заведены, привязка — имя с пакетом и найденный файл',
        goCases.length === 7 &&
          total?.automation?.testName === 'example.com/goshop/orders.TestTotal' &&
          total?.automation?.file === 'orders/orders_test.go' &&
          (await adoptButton.count()) === 0,
        JSON.stringify(total),
      );
      const adoptedText = await outcomeText();
      check(
        'экран: после заведения строки «Без кейса» нет, строка о пакете осталась',
        !adoptedText.includes('Без кейса') &&
          !adoptedText.includes('кейсов у них пока нет') &&
          adoptedText.includes('кейсы заведены после прогона') &&
          adoptedText.includes('Не собрался 1 пакет'),
        adoptedText.slice(0, 900),
      );
      await card.screenshot({ path: join(SHOTS, 'go-03-adopted.png') });
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        // Планка check-a11y.mjs: теги WCAG, значимые — critical/serious.
        const axe = await new AxeBuilder({ page })
          .include('[data-testid="tests-e2e-card"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const serious = axe.violations.filter((item) =>
          ['critical', 'serious'].includes(item.impact ?? ''),
        );
        check(
          `axe (${scheme}): карточка с блоком команды без нарушений WCAG critical/serious`,
          serious.length === 0,
          serious
            .map(
              (item) =>
                `${item.id}: ${item.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
            )
            .join(', '),
        );
      }
      await page.emulateMedia({ colorScheme: 'light' });

      // Повтор с API: кнопку нажали со второго экрана — ничего не задвоилось.
      const twice = await adopt(dirs.go);
      check(
        'повторное «Завести кейсы» — 0 новых, кейсов по-прежнему 7',
        twice.body.adopt?.added === 0 && cases(twice.body.view).length === 7,
        twice.text.slice(0, 300),
      );

      // Второй прогон ложится на заведённые кейсы целиком.
      await startRun(dirs.go);
      const second = await settle(dirs.go);
      const status = Object.fromEntries(cases(second).map((item) => [item.title, item.status]));
      check(
        'второй прогон Go: 7 из 8 легли на кейсы, без кейса — только «(build)»',
        second.e2eRun?.imported?.matched === 7 &&
          second.e2eRun?.imported?.unmatched === 1 &&
          second.e2eRun?.adoptable === undefined &&
          status.TestTotal === 'passed' &&
          status.TestTotalBroken === 'failed' &&
          status.TestSkipped === 'skipped' &&
          status['TestTable/two'] === 'failed',
        JSON.stringify({ imported: second.e2eRun?.imported, status }),
      );

      // Новый пакет с тестом после заведения: полный прогон гонит ./..., а не
      // пакеты кейсов, — иначе новый тест никогда не дошёл бы до «Завести кейсы».
      put(
        dirs.go,
        'ship/ship_test.go',
        'package ship\n\nimport "testing"\n\nfunc TestShip(t *testing.T) {}\n',
      );
      await startRun(dirs.go);
      const fresh = await settle(dirs.go);
      check(
        'новый пакет после заведения: полный прогон его видит — «Завести кейсы (1)» с TestShip',
        fresh.e2eRun?.command.includes('go test -json ./... >') &&
          fresh.e2eRun?.adoptable === 1 &&
          fresh.e2eRun?.unmatchedNames?.includes('TestShip'),
        JSON.stringify({
          command: fresh.e2eRun?.command,
          adoptable: fresh.e2eRun?.adoptable,
          names: fresh.e2eRun?.unmatchedNames,
        }),
      );

      // «Только группа»: go test получает пакет группы, а не весь модуль.
      const ordersGroup = second.groups.find((group) =>
        group.cases.some((item) => item.title === 'TestTotal'),
      );
      await startRun(dirs.go, { groupId: ordersGroup?.id });
      const scoped = await settle(dirs.go);
      check(
        '«Только группа»: go test -json ./orders — без ./... и без чужих пакетов',
        scoped.e2eRun?.command.includes('go test -json ./orders >') &&
          !scoped.e2eRun?.command.includes('./...') &&
          scoped.e2eRun?.imported?.read <= 6,
        scoped.e2eRun?.command,
      );

      // Чужой каталог — отказ, и в нём ничего не появилось.
      const stranger = await save(dirs.stranger, { command: 'go test ./...' });
      check('чужой каталог: запись команды — 403', stranger.status === 403, stranger.text);

      // ── Maven без mvn: нехватка названа до прогона ──────────────────────────
      console.log('Maven: программы нет на машине');
      const mvnInfo = await info(dirs.mvn);
      const mvnRecipe = mvnInfo.recipes.find((recipe) => recipe.stack === 'maven');
      if (tools.mvn) {
        check('Maven: mvn на машине есть — строка нехватки не проверяется', true);
      } else {
        check(
          'Maven: рецепт есть, «mvn» назван недостающим, со ссылкой на установку',
          mvnRecipe?.missing === true &&
            mvnRecipe.tool === 'mvn' &&
            mvnRecipe.install?.startsWith('https://maven.apache.org') &&
            mvnRecipe.automation.report === 'target/surefire-reports/',
          JSON.stringify(mvnRecipe),
        );
        await openTests('mvn');
        await page.locator('[data-testid="tests-automation-recipes"]').waitFor({ timeout: 30_000 });
        const mvnText = await card.innerText();
        check(
          'экран: нехватка mvn видна в рецепте до прогона',
          /Программы «mvn» на этой машине нет/.test(mvnText) && /maven\.apache\.org/.test(mvnText),
          mvnText.slice(0, 600),
        );
        await card.screenshot({ path: join(SHOTS, 'mvn-01-missing.png') });
        await save(dirs.mvn, mvnRecipe.automation);
        await startRun(dirs.mvn);
        const mvnRun = (await settle(dirs.mvn)).e2eRun;
        check(
          'Maven без mvn: прогон — «отчёта нет», кейсы не тронуты, причина в выводе',
          mvnRun?.status === 'error' &&
            mvnRun.errorCode === 'e2e-run-no-report' &&
            /mvn/i.test(mvnRun.log),
          JSON.stringify({ ...mvnRun, log: mvnRun?.log.slice(-400) }),
        );
      }
    } finally {
      await browser.close();
    }

    // ── Cargo ────────────────────────────────────────────────────────────────
    if (!tools.cargo) {
      check('Cargo: cargo на машине нет — круг Cargo не проверен', false);
    } else {
      console.log('Cargo: настоящий cargo test');
      const cargoRecipe = (await info(dirs.cargo)).recipes.find((recipe) => recipe.id === 'cargo:');
      check(
        'Cargo: рецепт — cargo test с потоком ошибок в отчёт, вид cargo-test',
        cargoRecipe?.automation.command === 'cargo test --no-fail-fast > {report} 2>&1' &&
          cargoRecipe.automation.format === 'cargo-test' &&
          !cargoRecipe.missing,
        JSON.stringify(cargoRecipe),
      );
      await save(dirs.cargo, cargoRecipe.automation);
      await startRun(dirs.cargo);
      // Первая сборка крейта идёт секунды — посреди неё команду не переписать.
      const during = await view(dirs.cargo);
      if (during.e2eRun?.status === 'running') {
        const busy = await save(dirs.cargo, { command: 'cargo test' });
        check(
          'Cargo: посреди прогона запись команды — 409 «Автотесты уже идут»',
          busy.status === 409 && busy.body.messageCode === 'e2e-run-busy',
          busy.text,
        );
      } else {
        console.log('  (прогон кончился раньше записи — строка 409 не проверялась)');
      }
      const first = await settle(dirs.cargo);
      check(
        'Cargo: 6 результатов (юнит, интеграционный, doc, игнорируемый), без кейса — все',
        first.e2eRun?.imported?.read === 6 && first.e2eRun.adoptable === 6,
        JSON.stringify({ imported: first.e2eRun?.imported, summary: first.e2eRun?.summary }),
      );
      const adopted = await adopt(dirs.cargo);
      const files = Object.fromEntries(
        cases(adopted.body.view).map((item) => [item.title, item.automation?.file]),
      );
      check(
        'Cargo: кейсы с файлами модулей — src/orders.rs, src/lib.rs, tests/api.rs',
        adopted.body.adopt?.added === 6 &&
          files['orders::tests::total_broken'] === 'src/orders.rs' &&
          files['tests::adds'] === 'src/lib.rs' &&
          files.api_works === 'tests/api.rs',
        JSON.stringify(files),
      );
      await startRun(dirs.cargo);
      const second = await settle(dirs.cargo);
      const broken = cases(second).find((item) => item.title === 'orders::tests::total_broken');
      check(
        'Cargo: второй прогон — 6 из 6 на кейсах, упавший — красный',
        second.e2eRun?.imported?.matched === 6 &&
          second.e2eRun.imported.unmatched === 0 &&
          broken?.status === 'failed',
        JSON.stringify(second.e2eRun?.imported),
      );
      const report = (await stand.api(`/project-tests/runs?${q(dirs.cargo)}&limit=1`)).body;
      const message = JSON.stringify(report).match(/assertion[^"]*want five/)?.[0];
      check(
        'Cargo: суть падения в записи прогона — текст assert «want five»',
        Boolean(message),
        JSON.stringify(report).slice(0, 400),
      );
    }

    // ── pytest через uv ─────────────────────────────────────────────────────
    if (!tools.uv || !tools.uvLock) {
      check('pytest: uv на машине нет или uv lock не прошёл — круг pytest не проверен', false);
    } else {
      console.log('pytest: настоящий pytest через uv');
      const pyRecipe = (await info(dirs.py)).recipes.find((recipe) => recipe.id === 'pytest:');
      check(
        'pytest: рецепт через uv — pytest подтянет uv, отчёт JUnit',
        pyRecipe?.tool === 'uv' &&
          pyRecipe.automation.command === 'uv run --with pytest pytest --junitxml={report} {paths}',
        JSON.stringify(pyRecipe),
      );
      await save(dirs.py, pyRecipe.automation);
      await startRun(dirs.py);
      const first = await settle(dirs.py, 600);
      check(
        'pytest: 3 результата (два набора параметров), pytest вышел с 1',
        first.e2eRun?.status === 'done' &&
          first.e2eRun.exitCode === 1 &&
          first.e2eRun.imported?.read === 3,
        JSON.stringify({ ...first.e2eRun, log: first.e2eRun?.log.slice(-600) }),
      );
      const adopted = await adopt(dirs.py);
      const pyCases = cases(adopted.body.view);
      check(
        'pytest: параметризованный тест — один кейс; файл — tests/test_pay.py',
        adopted.body.adopt?.added === 2 &&
          pyCases.every((item) => item.automation?.file === 'tests/test_pay.py'),
        JSON.stringify(pyCases.map((item) => [item.title, item.automation])),
      );
      await startRun(dirs.py);
      const second = await settle(dirs.py, 600);
      const status = Object.fromEntries(cases(second).map((item) => [item.title, item.status]));
      check(
        'pytest: второй прогон — все результаты на кейсах, упавший красный',
        second.e2eRun?.imported?.unmatched === 0 &&
          status.test_refund === 'passed' &&
          status.test_charge_fails === 'failed',
        JSON.stringify({ imported: second.e2eRun?.imported, status }),
      );
    }
  },
);
