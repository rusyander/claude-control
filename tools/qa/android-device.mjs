/**
 * Управление телефоном на эмуляторе Android через adb — для проверок, которые
 * обязаны пройти на настоящем устройстве: Hermes, нативный fetch с потоком,
 * сон JS в фоне, SecureStore. Веб-сборка Expo и юнит-тесты в Node этого не
 * видят (в Node есть `Intl.PluralRules`, в Hermes телефона — нет).
 *
 * Что умеет: найти adb и устройство, поставить APK, снять данные приложения,
 * прочитать экран (`uiautomator dump`), нажать по тексту, набрать ASCII-текст,
 * снять снимок экрана, увести приложение в фон и вернуть.
 *
 * Чего НЕ делает: не запускает и не гасит эмулятор (это решает вызывающий —
 * он же обязан погасить то, что поднял), не трогает другие приложения.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noIdleDumper } from './android-no-idle-dump.mjs';

export const PACKAGE = 'ai.agentdeck.panel';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Путь к adb: ANDROID_HOME / ANDROID_SDK_ROOT, затем SDK по умолчанию, затем PATH. */
export function adbPath() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && join(process.env.HOME, 'Android', 'Sdk'),
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, 'platform-tools', exe);
    if (existsSync(candidate)) return candidate;
  }
  return exe;
}

/** Первое подключённое устройство в состоянии `device`, иначе undefined. */
export function firstDevice(adb = adbPath()) {
  const result = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const line = result.stdout
    .split(/\r?\n/)
    .slice(1)
    .find((row) => /\tdevice$/.test(row.trim()) || /\sdevice$/.test(row));
  return line?.split(/\s+/)[0];
}

/**
 * Разобрать дамп uiautomator в плоский список узлов: текст, подпись для
 * доступности, признаки и центр прямоугольника — по нему и нажимаем.
 */
export function parseNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const attrs = {};
    // Текст с двойной кавычкой сериализатор пишет в ОДИНАРНЫХ кавычках
    // (text='Agent "Scan the repo" completed'): читать только "…" значило
    // видеть на месте такой строки пустоту (1b, 28.09).
    for (const pair of match[1].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g))
      attrs[pair[1]] = unescapeXml(pair[2] ?? pair[3] ?? '');
    const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    if (!box) continue;
    const [x1, y1, x2, y2] = box.slice(1).map(Number);
    nodes.push({
      text: attrs.text ?? '',
      desc: attrs['content-desc'] ?? '',
      cls: attrs.class ?? '',
      clickable: attrs.clickable === 'true',
      checked: attrs.checked === 'true',
      selected: attrs.selected === 'true',
      enabled: attrs.enabled !== 'false',
      bounds: { x1, y1, x2, y2 },
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
    });
  }
  return nodes;
}

function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

const matches = (node, pattern) =>
  typeof pattern === 'string'
    ? node.text === pattern || node.desc === pattern
    : pattern.test(node.text) || pattern.test(node.desc);

/** Устройство под adb. `serial` — имя из `adb devices`. */
export function device(serial, adb = adbPath()) {
  const run = (args, options = {}) =>
    spawnSync(adb, ['-s', serial, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  const shell = (command) => {
    const result = run(['shell', command], { encoding: 'utf8' });
    return (result.stdout ?? '') + (result.stderr ?? '');
  };

  // Рукописный ввод стилусом, не выключенный явно (значение null), Gboard
  // однажды встречает обучалкой «Try out your stylus» поверх приложения — и
  // она глотает весь ввод: поле адреса не стирается и не печатается, а
  // проверка падает на сопряжении. Свойство эмулятора, не продукта.
  shell('settings put secure stylus_handwriting_enabled 0');

  const noIdle = noIdleDumper(run);
  // Экран, на котором `uiautomator dump` не дождался покоя, тикает и дальше:
  // следующие 30 с снимаем его сразу без ожидания, не тратя по 10 с на отказ.
  let tickingUntil = 0;
  let lastDumpError = '';

  /**
   * Текущий экран. Дамп иногда падает посреди анимации — повторяем; экран,
   * который не бывает в покое (тикающий счётчик прогона), снимается без
   * ожидания покоя (`android-no-idle-dump.mjs`).
   */
  async function screen() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (Date.now() >= tickingUntil) {
        const result = run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { encoding: 'utf8' });
        const xml = result.stdout ?? '';
        if (xml.includes('<hierarchy')) return parseNodes(xml);
        lastDumpError = xml.trim().slice(0, 200);
        // Отказ по покою приходит строкой не на каждой версии adb: второй
        // пустой дамп подряд считаем тем же отказом.
        if (!/idle state/i.test(xml) && attempt === 0) {
          await sleep(400);
          continue;
        }
        tickingUntil = Date.now() + 30_000;
      }
      const xml = noIdle.dump();
      if (xml.includes('<hierarchy')) return parseNodes(xml);
      lastDumpError = `${lastDumpError} · без ожидания: ${noIdle.error()}`;
      await sleep(400);
    }
    return [];
  }

  /** Весь видимый текст экрана одной строкой — для «есть / нет на экране». */
  async function texts() {
    return (await screen())
      .map((node) => [node.text, node.desc].filter(Boolean).join(' | '))
      .filter(Boolean);
  }

  async function find(pattern) {
    return (await screen()).filter((node) => matches(node, pattern));
  }

  /** Ждать узел по тексту/подписи; нет за `ms` — undefined. */
  async function waitFor(pattern, ms = 15_000) {
    const until = Date.now() + ms;
    for (;;) {
      const [node] = await find(pattern);
      if (node) return node;
      if (Date.now() > until) return undefined;
      await sleep(500);
    }
  }

  /** Ждать, пока узла НЕ станет. */
  async function waitGone(pattern, ms = 15_000) {
    const until = Date.now() + ms;
    for (;;) {
      const found = await find(pattern);
      if (found.length === 0) return true;
      if (Date.now() > until) return false;
      await sleep(500);
    }
  }

  const tapAt = (x, y) => shell(`input tap ${x} ${y}`);

  /** Нажать узел по тексту; нет его — ошибка с тем, что на экране было. */
  async function tap(pattern, ms = 15_000, pick = (list) => list[0]) {
    const until = Date.now() + ms;
    for (;;) {
      const found = await find(pattern);
      const node = pick(found);
      if (node) {
        tapAt(node.x, node.y);
        await sleep(600);
        return node;
      }
      if (Date.now() > until) {
        throw new Error(
          `на экране нет «${pattern}»; видно: ${(await texts()).slice(0, 40).join(' ¦ ')}`,
        );
      }
      await sleep(500);
    }
  }

  /** Прокрутить вниз, пока узел не появится (до `swipes` раз). */
  async function scrollTo(pattern, swipes = 8) {
    for (let attempt = 0; attempt <= swipes; attempt += 1) {
      const [node] = await find(pattern);
      if (node && node.y < 2150) return node;
      shell('input swipe 540 1700 540 900 400');
      await sleep(700);
    }
    return undefined;
  }

  /** ASCII-текст в поле под фокусом (у `input text` нет юникода и пробелов). */
  function type(text) {
    const escaped = text.replace(/[\\'"`$&|;<>()*?!#~ ]/g, (ch) => (ch === ' ' ? '%s' : `\\${ch}`));
    shell(`input text ${escaped}`);
  }

  function screenshot(file) {
    const result = run(['exec-out', 'screencap', '-p']);
    if (result.status === 0 && result.stdout?.length) writeFileSync(file, result.stdout);
    return file;
  }

  return {
    serial,
    run,
    shell,
    screen,
    /** Почему последний дамп не удался — в подробности пустого экрана. */
    dumpError: () => lastDumpError,
    texts,
    find,
    waitFor,
    waitGone,
    tap,
    tapAt,
    scrollTo,
    type,
    screenshot,
    back: () => shell('input keyevent KEYCODE_BACK'),
    home: () => shell('input keyevent KEYCODE_HOME'),
    hideKeyboard: () => shell('input keyevent KEYCODE_ESCAPE'),
    install: (apk) => run(['install', '-r', apk], { encoding: 'utf8' }),
    isInstalled: (pkg = PACKAGE) => shell(`pm list packages ${pkg}`).includes(`package:${pkg}`),
    /** Когда на устройство встал установленный APK (мс эпохи, часы устройства); нет — undefined. */
    installedAt: (pkg = PACKAGE) => {
      const path = shell(`pm path ${pkg}`)
        .split(/\r?\n/)
        .find((line) => line.trim().endsWith('base.apk'));
      if (!path) return undefined;
      const seconds = Number(shell(`stat -c %Y ${path.replace(/^package:/, '').trim()}`).trim());
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
    },
    clearData: (pkg = PACKAGE) => shell(`pm clear ${pkg}`),
    stopApp: (pkg = PACKAGE) => shell(`am force-stop ${pkg}`),
    /** Запуск через лаунчер-интент — как палец по иконке. */
    launch: (pkg = PACKAGE) => shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`),
    /** Вернуть из фона: тот же интент поднимает существующую задачу, а не новую. */
    resume: (pkg = PACKAGE) => shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`),
    pidOf: (pkg = PACKAGE) => shell(`pidof ${pkg}`).trim(),
    grant: (permission, pkg = PACKAGE) => shell(`pm grant ${pkg} ${permission}`),
    revoke: (permission, pkg = PACKAGE) => shell(`pm revoke ${pkg} ${permission}`),
    logcat: (args = '-d -t 400') => shell(`logcat ${args}`),
    clearLogcat: () => shell('logcat -c'),
  };
}

export { sleep };
