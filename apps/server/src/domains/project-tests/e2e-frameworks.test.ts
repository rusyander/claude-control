import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSpec } from './e2e-parse.ts';
import { parsePytest } from './e2e-parse-pytest.ts';
import { groupIdOfFile, syncE2eFolder, syncE2eIfChanged } from './e2e-sync.ts';
import { e2eFolderView, SPEC_FILE } from './e2e-folder.ts';
import { importResults } from './import-results.ts';
import { readGroups } from './store.ts';

/**
 * Cypress и pytest: разбор без запуска, сверка с кейсами и сопоставление их
 * junit — на временном проекте, по-настоящему. Отчёты junit написаны так, как
 * их пишут сами каркасы (mocha-junit-reporter и `pytest --junitxml`), — иначе
 * совпадение имён доказывало бы только согласие теста с самим собой.
 */

const CYPRESS = `describe('Корзина', () => {
  context('гость', () => {
    it('[cart-001] добавляет товар @smoke', () => {
      // Given открыт каталог
      // When жмёт «В корзину»
      // Then счётчик корзины 1
      cy.visit('/');
    });
    specify('очищает корзину', () => {
      cy.get('[data-test=clear]').click();
    });
  });
  for (const size of ['S', 'M']) {
    it(\`размер \${size}\`, () => {});
  }
});
`;

const PYTEST = `"""Оформление заказа."""
import pytest

pytestmark = pytest.mark.checkout


@pytest.mark.smoke
def test_pay_by_card():
    """[order-001] оплата картой @critical

    Given корзина не пуста
    When платит картой
    Then заказ оплачен
    """
    assert True


@pytest.mark.parametrize("qty", [1, 2])
def test_quantity(qty):
    # When меняет количество
    # Then сумма пересчитана
    def test_helper_inside():
        pass
    assert qty


@pytest.mark.regression
class TestRefund:
    @pytest.mark.slow
    def test_full_refund(self):
        """полный возврат"""
        def test_nested_in_method():
            pass
        assert True

    def helper(self):
        pass


def helper_not_a_test():
    pass


for n in range(2):
    globals()[f"test_generated_{n}"] = lambda: None
`;

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp.
  }
}

describe('разбор Cypress', () => {
  it('describe/context/it/specify, метка, теги, сценарий; имя из шаблона — пропущено', () => {
    const spec = parseSpec(CYPRESS);
    expect(spec.tests.map((test) => test.title)).toEqual([
      '[cart-001] добавляет товар @smoke',
      'очищает корзину',
    ]);
    const [first, second] = spec.tests;
    expect(first).toMatchObject({
      id: 'cart-001',
      caseTitle: 'добавляет товар',
      titlePath: ['Корзина', 'гость'],
      precondition: 'открыт каталог',
      steps: ['жмёт «В корзину»'],
      expected: 'счётчик корзины 1',
    });
    expect(first?.tags).toContain('smoke');
    // mocha-junit-reporter склеивает заголовки пробелом, а не « › ».
    expect(first?.testName).toBe('Корзина гость [cart-001] добавляет товар @smoke');
    expect(second?.testName).toBe('Корзина гость очищает корзину');
    expect(spec.skipped.map((item) => item.reason)).toEqual(['dynamic-title']);
  });
});

describe('разбор pytest', () => {
  /**
   * F-317. Декораторы над `def` читались до первой строки-комментария, а скобки
   * внутри строк считались скобками: метки и id кейса терялись.
   */
  it('комментарий между декораторами и скобка в строке не рвут декораторы', () => {
    const text = [
      'import pytest',
      '',
      '@pytest.mark.case("pay-001")',
      '# оплата — главный путь',
      '@pytest.mark.smoke',
      'def test_pay():',
      '    pass',
      '',
      '@pytest.mark.regress',
      '@pytest.mark.parametrize("x", [")", "("])',
      '@pytest.mark.case("pay-002")',
      'def test_other(x):',
      '    pass',
      '',
    ].join('\n');
    const [pay, other] = parsePytest(text, 'tests/e2e/test_pay.py').tests;
    expect(pay).toMatchObject({ id: 'pay-001' });
    expect(pay?.tags).toContain('smoke');
    expect(other).toMatchObject({ id: 'pay-002' });
    expect(other?.tags).toContain('regress');
  });

  it('функции и методы Test*, docstring, метки, Given/When/Then; помощники и цикл — не тесты', () => {
    const spec = parsePytest(PYTEST, 'tests/e2e/test_checkout.py');
    expect(spec.tests.map((test) => test.testName)).toEqual([
      'tests.e2e.test_checkout.test_pay_by_card',
      'tests.e2e.test_checkout.test_quantity',
      'tests.e2e.test_checkout.TestRefund.test_full_refund',
    ]);
    const [card, qty, refund] = spec.tests;
    expect(card).toMatchObject({
      id: 'order-001',
      caseTitle: 'оплата картой',
      precondition: 'корзина не пуста',
      steps: ['платит картой'],
      expected: 'заказ оплачен',
    });
    expect(card?.tags.sort()).toEqual(['checkout', 'critical', 'smoke']);
    // parametrize — служебная метка, не тег кейса.
    expect(qty?.tags).toEqual(['checkout']);
    expect(qty).toMatchObject({ caseTitle: 'quantity', steps: ['меняет количество'] });
    expect(refund).toMatchObject({ titlePath: ['TestRefund'], caseTitle: 'полный возврат' });
    // Метка класса — тег каждого его теста; def внутри метода — помощник, не тест.
    expect(refund?.tags.sort()).toEqual(['checkout', 'regression', 'slow']);
    expect(spec.skipped).toEqual([{ line: 45, reason: 'dynamic-title' }]);
    expect(spec.topDescribe).toBe('Оформление заказа.');
  });

  it('имя группы: без docstring модуля — docstring первого класса', () => {
    const text = [
      'import pytest',
      '',
      'class TestProfile:',
      '    """Профиль пользователя',
      '',
      '    Правка имени и выход."""',
      '',
      '    def test_rename(self):',
      '        pass',
      '',
      'class TestOther:',
      '    """Другое"""',
      '',
      '    def test_x(self):',
      '        pass',
      '',
    ].join('\n');
    expect(parsePytest(text, 'tests/e2e/test_profile.py').topDescribe).toBe('Профиль пользователя');
    const bare = 'class TestProfile:\n    def test_rename(self):\n        pass\n';
    expect(parsePytest(bare, 'tests/e2e/test_profile.py').topDescribe).toBeUndefined();
  });

  it('группа по имени модуля: test_x.py и x_test.py', () => {
    expect(groupIdOfFile('tests/e2e/test_checkout.py')).toBe('checkout');
    expect(groupIdOfFile('tests/e2e/refund_test.py')).toBe('refund');
  });

  it('группа с дефисом возвращается в свою группу: и test_user_profile.py, и test_user-profile.py', () => {
    for (const file of ['tests/e2e/test_user_profile.py', 'tests/e2e/test_user-profile.py']) {
      expect(groupIdOfFile(file)).toBe('user-profile');
      expect(SPEC_FILE.test(file.slice(file.lastIndexOf('/') + 1))).toBe(true);
    }
    expect(groupIdOfFile('tests/e2e/main-form_test.py')).toBe('main-form');
  });
});

describe('сверка и junit на временном проекте', () => {
  let root = '';
  let appData = '';
  const now = '2026-09-26T10:00:00.000Z';

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-fw-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-fw-data-')));
  });

  afterEach(() => {
    dropTemp(root);
    dropTemp(appData);
  });

  it('pytest: папка tests/e2e узнана, кейсы заведены, отчёт --junitxml лёг на них', () => {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'tests', 'e2e', 'test_checkout.py'), PYTEST);
    const folder = e2eFolderView(root, appData);
    expect(folder).toMatchObject({ state: 'found', dir: 'tests/e2e', framework: 'pytest' });

    const sync = syncE2eFolder(root, now, { dir: 'tests/e2e', appData });
    expect(sync).toMatchObject({ files: 1, tests: 3, added: 3, groups: ['checkout'] });
    expect(sync.skipped).toEqual([
      { file: 'tests/e2e/test_checkout.py', reason: 'dynamic-title:45' },
    ]);
    const group = readGroups(root).find((item) => item.id === 'checkout');
    expect(group?.cases.map((item) => item.id).sort()).toEqual([
      'checkout-002',
      'checkout-003',
      'order-001',
    ]);

    // Так пишет pytest: classname — модуль (и класс), name — функция, у
    // параметризованной — с хвостом [набор данных].
    const junit =
      '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">' +
      '<testcase classname="tests.e2e.test_checkout" name="test_pay_by_card" time="0.1"/>' +
      '<testcase classname="tests.e2e.test_checkout" name="test_quantity[1]" time="0.1"/>' +
      '<testcase classname="tests.e2e.test_checkout" name="test_quantity[2]" time="0.1">' +
      '<failure message="assert 0"/></testcase>' +
      '<testcase classname="tests.e2e.test_checkout.TestRefund" name="test_full_refund" time="0.1">' +
      '<skipped message="нет стенда"/></testcase>' +
      '</testsuite></testsuites>';
    const result = importResults(root, { format: 'junit', content: junit, now });
    expect(result).toMatchObject({ read: 4, unmatched: [] });
    const byTest = new Map(
      readGroups(root)
        .find((item) => item.id === 'checkout')
        ?.cases.map((item) => [item.automation?.testName, item.status]),
    );
    expect(byTest.get('tests.e2e.test_checkout.test_pay_by_card')).toBe('passed');
    // Один кейс на все наборы данных: худший набор решает.
    expect(byTest.get('tests.e2e.test_checkout.test_quantity')).toBe('failed');
    expect(byTest.get('tests.e2e.test_checkout.TestRefund.test_full_refund')).toBe('skipped');
  });

  it('pytest с корнем не в проекте: classname короче или длиннее testName — отчёт всё равно ложится (F-129)', () => {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'tests', 'e2e', 'test_checkout.py'), PYTEST);
    syncE2eFolder(root, now, { dir: 'tests/e2e', appData });

    // pytest.ini внутри tests/e2e — classname от его папки; ini выше проекта
    // (монорепозиторий) — с лишним префиксом.
    const junit =
      '<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">' +
      '<testcase classname="test_checkout" name="test_pay_by_card" time="0.1">' +
      '<failure message="assert 0"/></testcase>' +
      '<testcase classname="test_checkout" name="test_quantity[2]" time="0.1">' +
      '<failure message="assert 0"/></testcase>' +
      '<testcase classname="shop.tests.e2e.test_checkout.TestRefund" name="test_full_refund" time="0.1">' +
      '<skipped message="нет стенда"/></testcase>' +
      '</testsuite></testsuites>';
    const result = importResults(root, { format: 'junit', content: junit, now });
    expect(result).toMatchObject({ read: 3, unmatched: [] });
    const byTest = new Map(
      readGroups(root)
        .find((item) => item.id === 'checkout')
        ?.cases.map((item) => [item.automation?.testName, item.status]),
    );
    expect(byTest.get('tests.e2e.test_checkout.test_pay_by_card')).toBe('failed');
    expect(byTest.get('tests.e2e.test_checkout.test_quantity')).toBe('failed');
    expect(byTest.get('tests.e2e.test_checkout.TestRefund.test_full_refund')).toBe('skipped');
  });

  it('Cypress: cypress/e2e узнана, отчёт mocha-junit-reporter сопоставлен по имени', () => {
    mkdirSync(join(root, 'cypress', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'cypress', 'e2e', 'cart.cy.ts'), CYPRESS);
    expect(e2eFolderView(root, appData)).toMatchObject({
      dir: 'cypress/e2e',
      framework: 'cypress',
    });
    const sync = syncE2eFolder(root, now, { dir: 'cypress/e2e', appData });
    expect(sync).toMatchObject({ tests: 2, added: 2, groups: ['cart'] });
    expect(sync.skipped).toHaveLength(1);

    const junit =
      '<testsuites name="Mocha Tests"><testsuite name="Root Suite" file="cypress/e2e/cart.cy.ts"/>' +
      '<testsuite name="гость">' +
      '<testcase name="Корзина гость [cart-001] добавляет товар @smoke" classname="добавляет товар" time="1"/>' +
      '<testcase name="Корзина гость очищает корзину" classname="очищает корзину" time="1">' +
      '<failure message="кнопки нет"/></testcase>' +
      '</testsuite></testsuites>';
    const result = importResults(root, { format: 'junit', content: junit, now });
    expect(result).toMatchObject({ read: 2, matched: 2, unmatched: [] });
    const cases = readGroups(root).find((item) => item.id === 'cart')?.cases ?? [];
    expect(cases.find((item) => item.id === 'cart-001')?.status).toBe('passed');
    expect(cases.find((item) => item.id !== 'cart-001')?.status).toBe('failed');
  });

  it('конец хода: не трогали — ничего; новый файл — кейс; удалили файл — кейс в «исчезнувших»', () => {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(
      join(root, 'e2e', 'auth.spec.ts'),
      "import { test } from '@playwright/test';\ntest('[auth-001] вход', async () => {});\n",
    );
    syncE2eFolder(root, now, { dir: 'e2e', appData });
    const before = JSON.stringify(readGroups(root));
    // Всё старое — «до хода»: времена файлов и каталогов в прошлом.
    const old = new Date('2026-01-01T00:00:00.000Z');
    for (const path of [join(root, 'e2e', 'auth.spec.ts'), join(root, 'e2e')]) {
      utimesSync(path, old, old);
    }
    const turn = Date.parse('2026-06-01T00:00:00.000Z');

    expect(syncE2eIfChanged(root, turn, now, appData)).toBeUndefined();
    expect(JSON.stringify(readGroups(root))).toBe(before);

    writeFileSync(
      join(root, 'e2e', 'cart.spec.ts'),
      "import { test } from '@playwright/test';\ntest('в корзину', async () => {});\n",
    );
    const added = syncE2eIfChanged(root, turn, now, appData);
    expect(added).toMatchObject({ added: 1, groups: ['cart'] });

    utimesSync(join(root, 'e2e', 'cart.spec.ts'), old, old);
    rmSync(join(root, 'e2e', 'auth.spec.ts'));
    const gone = syncE2eIfChanged(root, Date.now(), now, appData);
    expect(gone?.missing).toEqual([
      { groupId: 'auth', caseId: 'auth-001', file: 'e2e/auth.spec.ts' },
    ]);
    // Кейс не удалён: удалённый тест — решение человека, не сверки.
    expect(readGroups(root).find((item) => item.id === 'auth')?.cases[0]?.id).toBe('auth-001');
  });
});
