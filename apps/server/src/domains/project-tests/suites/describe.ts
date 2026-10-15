import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import type { ProjectTestCase, ProjectTestStep } from '@agentdeck/contracts';
import { readText } from '../../project-runner/stacks/fs-probe.ts';
import type { DiscoveredSuite, SuiteStack } from './suites.types.ts';

/**
 * Текст кейса-набора — из самих тестов, без модели. Кейс «прогнать тесты
 * каталога — все проходят» читать незачем: он не говорит, ЧТО проверено. А
 * названия тестов это уже говорят — `it('уводит на логин, когда сессии нет')`,
 * docstring pytest, `TestLogin_ExpiredToken`. Шаг — проверяемое поведение,
 * ожидание шага — тест, который его доказывает; токенов не стоит ни одного.
 */

/** Поведений, которые ещё читаются шагом каждое (потолок линтера — 15 шагов). */
const STEP_CHECKS = 14;
/** Файлов шагами, когда проверок больше: дальше — одной строкой «остальные». */
const STEP_FILES = 12;
/** Названий в ожидании шага-файла: длиннее его не прочтут. */
const STEP_TITLES = 8;
const MAX_FILE = 256 * 1024;
const TITLE_CAP = 160;

export interface SuiteCheck {
  /** Что проверяет тест — словами автора. */
  text: string;
  /** Имя теста в коде (`TestLogin`, `test_reads_yaml`), если оно не совпадает с текстом. */
  name?: string;
  /** Строка табличного теста Go: проверка — вариант поведения функции `name`. */
  variant?: string;
}

export interface SuiteFileFacts {
  /** Путь файла от корня проекта, через `/`. */
  file: string;
  checks: SuiteCheck[];
  /** Крупные блоки: `describe` у JS; заголовок кейса берётся из них. */
  groups: string[];
  /** Docstring модуля pytest: первая мысль о том, зачем файл. */
  about?: string;
}

export type SuiteText = Pick<
  ProjectTestCase,
  'title' | 'purpose' | 'precondition' | 'steps' | 'expected' | 'oracle'
>;

const clip = (text: string, cap = TITLE_CAP): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1).trimEnd()}…` : flat;
};

const unique = (items: string[]): string[] => [...new Set(items.filter(Boolean))];

/** Первое предложение многострочного текста: docstring переносят посреди мысли. */
function firstSentence(text: string): string {
  const paragraph = text.split(/\n\s*\n/)[0] ?? '';
  const flat = paragraph.replace(/\s+/g, ' ').trim();
  const end = /[.!?](\s|$)/.exec(flat);
  return clip(end ? flat.slice(0, end.index + 1) : flat);
}

/** `CheckPermission_AdminActionCovers` → «Check permission: admin action covers». */
export function humanizeName(name: string): string {
  return name
    .replace(/^(Test|test_?)/, '')
    .split('_')
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase(),
    )
    .join(': ')
    .replace(/^./, (first) => first.toUpperCase());
}

type Facts = Omit<SuiteFileFacts, 'file'>;

const JS_CALL =
  /\b(describe|it|test)(?:\.(?:only|skip|todo|concurrent|sequential))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*?)\2/g;

function jsFacts(text: string): Facts {
  const checks: SuiteCheck[] = [];
  const groups: string[] = [];
  for (const match of text.matchAll(JS_CALL)) {
    const title = clip((match[3] ?? '').replace(/\\(.)/g, '$1'));
    if (!title) continue;
    if (match[1] === 'describe') groups.push(title);
    else checks.push({ text: title });
  }
  return { checks, groups };
}

const GO_TEST = /^func (Test\w+)\(\s*\w+\s+\*testing\.T\s*\)/gm;
/** Подтесты: `t.Run("…")` и имена строк табличного теста. */
const GO_CASE = /(?:\bt\.Run\(\s*"([^"]{3,})"|\b(?:name|desc|description)\s*:\s*"([^"]{3,})")/g;

function goFacts(text: string): Facts {
  const tests = [...text.matchAll(GO_TEST)];
  const checks: SuiteCheck[] = [];
  tests.forEach((match, index) => {
    const name = match[1] ?? '';
    const from = match.index ?? 0;
    const body = text.slice(from, tests[index + 1]?.index ?? text.length);
    const cases = unique([...body.matchAll(GO_CASE)].map((item) => clip(item[1] ?? item[2] ?? '')));
    // Табличный тест — одна функция и десяток строк: строки — варианты одного поведения.
    if (cases.length === 0) checks.push({ text: humanizeName(name), name });
    for (const variant of cases) checks.push({ text: humanizeName(name), name, variant });
  });
  return { checks, groups: [] };
}

const PY_DEF = /^[ \t]*(?:async\s+)?def (test_\w*)\s*\(/gm;
const PY_DOC = /^\s*[rbuRBU]?("""|''')([\s\S]*?)\1/;

function pyFacts(text: string): Facts {
  const checks: SuiteCheck[] = [];
  for (const match of text.matchAll(PY_DEF)) {
    const name = match[1] ?? '';
    // Docstring теста — сразу за сигнатурой (она бывает в несколько строк).
    const rest = text.slice((match.index ?? 0) + match[0].length);
    const colon = /\)[^\n:]*:[ \t]*\n/.exec(rest);
    const doc = colon ? PY_DOC.exec(rest.slice(colon.index + colon[0].length)) : null;
    const said = doc?.[2] ? firstSentence(doc[2]) : '';
    checks.push({ text: said || humanizeName(name), name });
  }
  const module = PY_DOC.exec(text.replace(/^(#[^\n]*\n|\s*\n)*/, ''));
  const about = module?.[2] ? firstSentence(module[2]) : '';
  return { checks, groups: [], ...(about ? { about } : {}) };
}

const JVM_DISPLAY = /@DisplayName\(\s*"([^"]+)"\s*\)/g;
const JVM_TEST = /@(?:Test|ParameterizedTest)\b[\s\S]{0,200}?\b(?:void|fun)\s+`?([\w ]+?)`?\s*\(/g;

function jvmFacts(text: string): Facts {
  const shown = [...text.matchAll(JVM_DISPLAY)].map((match) => ({ text: clip(match[1] ?? '') }));
  if (shown.length > 0) return { checks: shown, groups: [] };
  const checks = [...text.matchAll(JVM_TEST)].map((match) => {
    const name = (match[1] ?? '').trim();
    return name.includes(' ') ? { text: clip(name) } : { text: humanizeName(name), name };
  });
  return { checks, groups: [] };
}

const READERS: Record<SuiteStack, (text: string) => Facts> = {
  js: jsFacts,
  go: goFacts,
  pytest: pyFacts,
  jvm: jvmFacts,
};

/** Названия тестов файлов набора: что каждый файл проверяет. */
export function readSuiteFacts(root: string, suite: DiscoveredSuite): SuiteFileFacts[] {
  return suite.paths.map((file) => {
    const text = readText(join(root, ...file.split('/')));
    if (!text || text.length > MAX_FILE) return { file, checks: [], groups: [] };
    return { file, ...READERS[suite.stack](text) };
  });
}

const STACK_TITLE: Record<SuiteStack, string> = {
  go: 'Go',
  js: 'JS/TS',
  pytest: 'pytest',
  jvm: 'JVM',
};

const PRECONDITION: Record<SuiteStack, string> = {
  go: 'Модуль Go собирается: зависимости скачаны, go.sum полон (go mod download).',
  js: 'Зависимости пакета установлены, раннер тестов пакета (vitest или jest) запускается.',
  pytest: 'Окружение Python проекта с pytest и зависимостями проекта.',
  jvm: 'Сборка Gradle или Maven проекта проходит до задачи тестов.',
};

const ORACLE: Record<SuiteStack, string> = {
  go:
    'Отчёт go test -json: у каждого теста пакета итог pass, пакет собрался ' +
    '(нет строки «(build)»); упавший тест назван в заметке кейса.',
  js: 'JUnit-отчёт раннера: у каждого testcase каталога нет failure и error; упавший назван в заметке.',
  pytest:
    'JUnit-отчёт pytest: у каждого testcase модуля нет failure и error; упавший назван в заметке.',
  jvm: 'JUnit-отчёт сборки: у каждого testcase пакета нет failure и error; упавший назван в заметке.',
};

function listed(items: string[], cap: number): string {
  const head = items.slice(0, cap).join('; ');
  return items.length > cap ? `${head}; …и ещё ${items.length - cap}` : head;
}

const sentence = (text: string): string => text.replace(/\.$/, '');

/** Поведение, которое доказывает один тест: функция и её строки-варианты. */
interface SuiteUnit {
  file: string;
  text: string;
  name?: string;
  variants: string[];
}

function unitsOf(item: SuiteFileFacts): SuiteUnit[] {
  const units = new Map<string, SuiteUnit>();
  for (const check of item.checks) {
    const key = check.name ?? check.text;
    const unit = units.get(key) ?? { file: item.file, text: check.text, variants: [] };
    if (check.name) unit.name = check.name;
    if (check.variant) unit.variants.push(check.variant);
    units.set(key, unit);
  }
  return [...units.values()];
}

function unitTitle(unit: SuiteUnit): string {
  const text = sentence(unit.text);
  if (unit.variants.length === 1) return clip(`${text} — ${unit.variants[0]}`);
  return unit.variants.length > 1 ? `${text} (${unit.variants.length})` : text;
}

/** Шаг на поведение: оно — действием, доказывающий тест и его варианты — ожиданием. */
function unitSteps(units: SuiteUnit[]): ProjectTestStep[] {
  return units.map((unit) => {
    const proof = `Проходит ${unit.name ?? 'тест'} в ${posix.basename(unit.file)}`;
    return {
      action: `Проверить: ${sentence(unit.text)}`,
      expected:
        unit.variants.length > 0 ? `${proof}: ${listed(unit.variants, STEP_TITLES)}` : proof,
    };
  });
}

/** Шаг на файл — когда поведений больше, чем шагов, которые ещё читаются. */
function fileSteps(facts: SuiteFileFacts[]): ProjectTestStep[] {
  const titles = (item: SuiteFileFacts): string[] => unitsOf(item).map(unitTitle);
  const steps: ProjectTestStep[] = facts.slice(0, STEP_FILES).map((item) => ({
    action: `Прогнать ${posix.basename(item.file)}${item.checks.length > 0 ? ` (${item.checks.length})` : ''}`,
    expected:
      item.checks.length > 0
        ? `Проходят: ${listed(titles(item), STEP_TITLES)}`
        : `В отчёте прогона нет упавших тестов из ${posix.basename(item.file)}`,
  }));
  const rest = facts.slice(STEP_FILES);
  if (rest.length > 0) {
    steps.push({
      action: `Прогнать остальные файлы каталога (${rest.length})`,
      expected: `Проходят: ${listed(unique(rest.flatMap(titles)), STEP_TITLES)}`,
    });
  }
  return steps;
}

/**
 * Заголовок — о чём каталог, коротко: `describe` у JS, docstring модуля у
 * pytest, иначе первое поведение и сколько их ещё. Перечень всех проверок в
 * заголовке не читается — он в шагах.
 */
function headline(facts: SuiteFileFacts[], units: SuiteUnit[]): string {
  const groups = unique(facts.flatMap((item) => item.groups));
  const about = unique(facts.map((item) => item.about ?? ''));
  const said = groups.length > 0 ? groups : about.length > 0 ? about : units.map(unitTitle);
  if (said.length === 0) return '';
  if (said.length <= 2 && said.join('; ').length <= 100) return said.map(sentence).join('; ');
  return `${sentence(said[0] ?? '')} (+${said.length - 1})`;
}

/** Текст кейса-набора по названиям его тестов. */
export function suiteText(suite: DiscoveredSuite, facts: SuiteFileFacts[]): SuiteText {
  const checks = facts.reduce((sum, item) => sum + item.checks.length, 0);
  const units = facts.flatMap(unitsOf);
  const head = headline(facts, units);
  const title = head
    ? clip(`${suite.dir}: ${head}`, 120)
    : `Тесты каталога ${suite.dir} (${STACK_TITLE[suite.stack]})`;
  const about = unique(facts.map((item) => item.about ?? ''));
  const count =
    checks > 0 ? `проверок: ${checks}, файлов: ${facts.length}` : `файлов: ${facts.length}`;
  const purpose = [
    `Что проверяют тесты каталога ${suite.dir} (${STACK_TITLE[suite.stack]}; ${count}).`,
    ...about.slice(0, 2),
  ].join(' ');
  const perUnit =
    units.length > 0 &&
    units.length <= STEP_CHECKS &&
    facts.every((item) => item.checks.length > 0);
  return {
    title,
    purpose,
    precondition: PRECONDITION[suite.stack],
    steps: perUnit ? unitSteps(units) : fileSteps(facts),
    expected:
      checks > 0
        ? `Все проверки каталога (${checks}) проходят; поведение каждого шага подтверждено своим тестом.`
        : `В отчёте прогона нет упавших тестов каталога ${suite.dir}.`,
    oracle: ORACLE[suite.stack],
  };
}

/** Отпечаток текста кейса: по нему узнаётся, что кейс никто не правил после панели. */
export function suiteDigest(text: SuiteText | ProjectTestCase): string {
  const own = {
    title: text.title,
    purpose: text.purpose ?? '',
    precondition: text.precondition ?? '',
    steps: (text.steps ?? []).map((step) => [step.action, step.expected ?? '']),
    expected: text.expected ?? '',
    oracle: text.oracle ?? '',
  };
  return createHash('sha1').update(JSON.stringify(own)).digest('hex').slice(0, 16);
}
