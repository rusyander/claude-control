/**
 * Телефон на эмуляторе Android: то, что доказано только на уровне функций,
 * проверяется в собранном APK — Hermes, нативный поток `expo/fetch`, сон JS в
 * фоне, настоящие экраны.
 *
 * Что подменено. Панель — настоящая одноразовая (`throwaway-stand.mjs`: свой
 * дом, свой `~/.claude`, свой порт), `claude` — фальшивый. Между телефоном и
 * панелью стоит прокси (`mobile-device-fixtures.mjs`), который отвечает сам
 * только там, где настоящую панель не заставить без модели: карточка агента с
 * числом, поток хода агента панели, битый разговор, код ошибки автотестов.
 * Рабочий стенд человека и настоящий `~/.claude` не трогаются.
 *
 * Нужны: загруженное устройство в `adb devices` и установленный APK
 * (`--apk <путь>` ставит его сам). Нет устройства — код 2, «не проверено».
 *
 * Запуск: node tools/qa/check-mobile-device.mjs [--apk agentdeck.apk]
 *   [--only f24,f65,...] [--shots <каталог>] [--hold]
 * `--hold` — только подготовка: стенд и прокси живут, телефон сопряжён, дальше
 * руками (выход — Ctrl+C).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';
import { PACKAGE, device, firstDevice } from './android-device.mjs';
import {
  FAKE_CHAT_CLI,
  SESSION_ID,
  seedAutomation,
  seedOrphanRun,
  seedTranscript,
  startProxy,
} from './mobile-device-fixtures.mjs';
import { SCENARIOS } from './mobile-device-scenarios.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const only = option('--only')
  ?.split(',')
  .map((item) => item.trim().toLowerCase());
const shots = option('--shots') ?? join(REPO, '.agent', 'screenshots', 'mobile-device');
const apk = option('--apk');
const hold = args.includes('--hold');

const { check, finish } = reporter();

const serial = firstDevice();
if (!serial) {
  console.log('Не проверено: нет устройства в `adb devices` (эмулятор не запущен).');
  process.exit(2);
}
const phone = device(serial);
if (apk) {
  const result = phone.install(apk);
  if (!String(result.stdout).includes('Success')) {
    console.log(`Не проверено: APK не встал: ${result.stdout}${result.stderr}`);
    process.exit(2);
  }
}
if (!phone.isInstalled()) {
  console.log(`Не проверено: на устройстве нет ${PACKAGE} (передайте --apk).`);
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

/** Сопряжение руками, как человек без камеры: адрес и токен в поля «Или вручную». */
async function pair(url) {
  phone.stopApp();
  phone.clearData();
  // Разрешение на уведомления «отказано навсегда»: системного окна нет, и
  // приложение не регистрирует push-токен на панели.
  phone.shell(
    `pm set-permission-flags ${PACKAGE} android.permission.POST_NOTIFICATIONS user-fixed`,
  );
  phone.launch();
  await phone.tap(/^(Settings|Настройки)$/, 30_000);
  await phone.tap(/^(Pair|Подключить|Сопряжение)$/);
  const fields = (await phone.screen()).filter((node) => node.cls.endsWith('EditText'));
  if (fields.length < 2) throw new Error('на экране сопряжения нет полей адреса и токена');
  phone.tapAt(fields[0].x, fields[0].y);
  await wait(400);
  phone.shell('input keyevent KEYCODE_MOVE_END');
  phone.shell(`input keyevent ${Array(80).fill('67').join(' ')}`);
  phone.type(url);
  phone.tapAt(fields[1].x, fields[1].y);
  await wait(400);
  phone.type('device-check');
  phone.hideKeyboard();
  await wait(400);
  await phone.tap(/^(Connect|Подключить)$/);
  return Boolean(await phone.waitFor(/^(online|на связи)$/i, 20_000));
}

let proxy;
try {
  await (async () => {
    const stand = await startStand({
      web: false,
      label: 'mobdev',
      fakeCli: { claude: FAKE_CHAT_CLI },
      seed: ({ root, cfg }) => {
        const project = join(root, 'proj');
        mkdirSync(project, { recursive: true });
        seedTranscript(cfg, project);
        seedAutomation(project);
        seedOrphanRun(project);
      },
    });
    const project = join(stand.root, 'proj');
    try {
      proxy = await startProxy(stand.apiUrl);
      console.log(
        `Одноразовая панель ${stand.apiUrl}, прокси :${proxy.port}, устройство ${serial}\n`,
      );

      const registered = await stand.api('/projects', { method: 'POST', body: { path: project } });
      check(
        'проект заведён в реестр одноразовой панели',
        registered.status === 200,
        registered.text,
      );

      const ctx = {
        stand,
        project,
        proxy,
        phone,
        check,
        shots,
        sessionId: SESSION_ID,
        notes: [],
        calls: () => readCalls(stand),
        shot: (name) => phone.screenshot(join(shots, `${name}.png`)),
        pair: () => pair(`http://10.0.2.2:${proxy.port}`),
      };
      for (const scenario of SCENARIOS) {
        if (scenario.setup) await scenario.setup(ctx);
      }

      check('телефон сопряжён с одноразовой панелью', await pair(`http://10.0.2.2:${proxy.port}`));
      if (hold) {
        // Выход — файл release в корне стенда: Ctrl+C или kill не дали бы стенду снять себя.
        const release = join(stand.root, 'release');
        console.log(`--hold: стенд и прокси живут; выход — создать файл ${release}`);
        while (!existsSync(release)) await wait(1000);
        return;
      }
      for (const scenario of SCENARIOS) {
        if (only && !only.includes(scenario.id)) continue;
        console.log(`\n${scenario.id}: ${scenario.title}`);
        try {
          await scenario.run(ctx);
        } catch (error) {
          ctx.shot(`${scenario.id}-error`);
          check(`${scenario.id} дошёл до конца`, false, error?.stack ?? String(error));
          console.log(`    хвост журнала панели:\n${stand.log().slice(-3000)}`);
        }
      }
      if (ctx.notes.length > 0) {
        console.log(`\nЗаметки:\n${ctx.notes.map((note) => `  - ${note}`).join('\n')}`);
      }
    } finally {
      phone.stopApp();
      await proxy?.close();
      await stand.stop();
    }
  })();
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exit(2);
  }
  check('сценарий дошёл до конца', false, error?.stack ?? String(error));
}
finish();

function readCalls(stand) {
  const file = join(stand.bin, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
