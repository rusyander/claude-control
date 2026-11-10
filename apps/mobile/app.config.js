/**
 * Конфигурация Expo поверх `app.json`.
 *
 * Здесь добавляется то, что приходит из окружения СБОРКИ, а не из репозитория (он публичный):
 *
 * - адрес панели по умолчанию (`MOBILE_DEFAULT_URL`). Нужен, когда APK отдают другому человеку:
 *   тот ставит файл и видит адрес уже заполненным, ему остаётся вписать токен. Тайлнет-имя
 *   машины — личная вещь; без переменной поле пустое;
 * - идентификатор проекта EAS (`AGENTDECK_EAS_PROJECT_ID`) → `extra.eas.projectId`. Без него
 *   сервис Expo не выдаёт push-токен, и приложение говорит «Пуш не настроен»;
 * - файл Firebase (`AGENTDECK_GOOGLE_SERVICES`, путь к `google-services.json`) →
 *   `android.googleServicesFile`. Без него Android не получает FCM и push не доходит. Файл
 *   попадает в нативный проект при `expo prebuild` — сборка APK запускает его сама, когда файл
 *   задан и в `android/app` его нет или он другой (`tools/build-mobile-apk.mjs`).
 *
 * Оба значения — владельца аккаунтов EAS и Firebase; в репозитории их нет и не будет.
 * Токен панели сюда не кладётся никогда: APK распаковывается в одну команду, а за токеном стоит
 * доступ к учётным данным и запуск команд на машине.
 */
const base = require('./app.json');

const EAS_PROJECT_ID_ENV = 'AGENTDECK_EAS_PROJECT_ID';
const GOOGLE_SERVICES_ENV = 'AGENTDECK_GOOGLE_SERVICES';

module.exports = () => {
  const projectId = (process.env[EAS_PROJECT_ID_ENV] ?? '').trim();
  const googleServicesFile = (process.env[GOOGLE_SERVICES_ENV] ?? '').trim();
  const extra = base.expo.extra ?? {};
  return {
    ...base.expo,
    android: {
      ...base.expo.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    extra: {
      ...extra,
      defaultPanelUrl: process.env.MOBILE_DEFAULT_URL ?? '',
      ...(projectId ? { eas: { ...extra.eas, projectId } } : {}),
    },
  };
};
