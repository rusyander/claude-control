/**
 * Дамп экрана без ожидания «покоя» — для экранов, которые тикают.
 *
 * `uiautomator dump` сначала ждёт секунду без событий доступности и через 10 с
 * сдаётся («could not get idle state»), так и не сняв экран. Чат с идущим
 * прогоном тикает счётчиком «running 2m 47s» раз в секунду — такой секунды на
 * нём не бывает никогда, и проверка видела пустой экран там, где на снимке всё
 * было (1b, 28.09). Старый раннер `uiautomator runtest` умеет то же самое без
 * ожидания: `Configurator.setWaitForIdleTimeout(0)` превращает таймаут в
 * предупреждение в журнале, а `dumpWindowHierarchy` пишет тот же XML тем же
 * дампером, что и команда. Класс собирается из SDK один раз (javac + d8) и
 * кэшируется во временном каталоге по содержимому исходника.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE = `package agentdeck.qa;

import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

public class Dump extends UiAutomatorTestCase {
  public void testDump() throws Exception {
    Configurator.getInstance().setWaitForIdleTimeout(0);
    getUiDevice().dumpWindowHierarchy("agentdeck-dump.xml");
  }
}
`;

const REMOTE_JAR = '/data/local/tmp/agentdeck-dump.jar';
// Старый раннер пишет в $ANDROID_DATA/local/tmp, а скрипт `uiautomator` под
// пользователем shell ставит ANDROID_DATA=/data/local/tmp.
const REMOTE_XML = '/data/local/tmp/local/tmp/agentdeck-dump.xml';

function sdkRoot() {
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && join(process.env.HOME, 'Android', 'Sdk'),
  ].find((root) => root && existsSync(join(root, 'platforms')));
}

/** Самая новая папка из `dir`, в которой есть `file`. */
function newest(dir, file) {
  const names = readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, file)))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return names[0] ? join(dir, names[0]) : undefined;
}

/** Собрать jar с классом дампа; путь к нему или ошибка словами. */
export function buildDumpJar() {
  const out = join(
    tmpdir(),
    'agentdeck-qa-dump',
    createHash('sha256').update(SOURCE).digest('hex').slice(0, 12),
  );
  const jar = join(out, 'dump.jar');
  if (existsSync(jar)) return { jar };
  const sdk = sdkRoot();
  if (!sdk) return { error: 'нет Android SDK (ANDROID_HOME)' };
  const platform = newest(join(sdk, 'platforms'), 'uiautomator.jar');
  const d8Name = process.platform === 'win32' ? 'd8.bat' : 'd8';
  const tools = newest(join(sdk, 'build-tools'), d8Name);
  if (!platform || !tools) return { error: 'в SDK нет uiautomator.jar или d8' };
  const src = join(out, 'src', 'agentdeck', 'qa');
  const classes = join(out, 'classes');
  mkdirSync(src, { recursive: true });
  mkdirSync(classes, { recursive: true });
  writeFileSync(join(src, 'Dump.java'), SOURCE);
  const sep = process.platform === 'win32' ? ';' : ':';
  const libs = [
    join(platform, 'android.jar'),
    join(platform, 'uiautomator.jar'),
    join(platform, 'optional', 'android.test.base.jar'),
  ];
  const javac = spawnSync(
    'javac',
    [
      '-nowarn',
      '-source',
      '8',
      '-target',
      '8',
      '-cp',
      libs.join(sep),
      '-d',
      classes,
      join(src, 'Dump.java'),
    ],
    { encoding: 'utf8' },
  );
  if (javac.status !== 0)
    return { error: `javac: ${(javac.stderr || javac.error?.message) ?? ''}` };
  const quote = (value) => `"${value}"`;
  // .bat запускается только через оболочку (Node 22 отказывает в прямом spawn).
  const d8 = spawnSync(
    [
      quote(join(tools, d8Name)),
      '--min-api 26',
      `--lib ${quote(libs[0])}`,
      `--classpath ${quote(libs[1])}`,
      `--classpath ${quote(libs[2])}`,
      `--output ${quote(jar)}`,
      quote(join(classes, 'agentdeck', 'qa', 'Dump.class')),
    ].join(' '),
    { encoding: 'utf8', shell: true },
  );
  if (d8.status !== 0 || !existsSync(jar)) return { error: `d8: ${d8.stderr ?? ''}`.slice(0, 400) };
  return { jar };
}

/**
 * Дампер для устройства: `dump()` — XML экрана без ожидания покоя или '' и
 * `error` с причиной. Jar ставится на устройство при первом вызове.
 */
export function noIdleDumper(run) {
  let pushed = false;
  let error = '';
  function dump() {
    if (!pushed) {
      const built = buildDumpJar();
      if (built.error) {
        error = built.error;
        return '';
      }
      const push = run(['push', built.jar, REMOTE_JAR], { encoding: 'utf8' });
      if (push.status !== 0) {
        error = `adb push: ${push.stderr ?? ''}`;
        return '';
      }
      pushed = true;
    }
    const result = run(
      [
        'exec-out',
        `mkdir -p /data/local/tmp/local/tmp; rm -f ${REMOTE_XML}; ` +
          'uiautomator runtest /system/framework/android.test.base.jar agentdeck-dump.jar ' +
          `-c agentdeck.qa.Dump >/dev/null 2>&1; cat ${REMOTE_XML}`,
      ],
      { encoding: 'utf8' },
    );
    const xml = result.stdout ?? '';
    error = xml.includes('<hierarchy') ? '' : 'раннер uiautomator не записал дамп';
    return xml;
  }
  return { dump, error: () => error };
}
