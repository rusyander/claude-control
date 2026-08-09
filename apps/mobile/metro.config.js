const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Приложение живёт в репозитории панели, но вне её pnpm-воркспейса: Metro не
 * дружит с изолированными симлинками pnpm, а менять линковку всему репозиторию
 * ради одного пакета дороже. Свои зависимости у него свои (npm), а типы
 * контрактов берутся ИЗ ИСХОДНИКОВ соседнего пакета — импортом только типов,
 * поэтому в бандл оттуда не попадает ни строчки.
 *
 * Пакет контрактов в watchFolders нужен именно для этого чтения: без него Metro
 * считает всё вне apps/mobile чужой территорией. Больше туда не добавляем — при
 * корне репозитория целиком Metro обходит и node_modules соседних приложений.
 *
 * Путь до репозитория можно передать переменной: релизный APK собирается с
 * укороченного пути (`pnpm mobile:apk` — иначе на Windows не проходит предел в
 * 260 символов), и подъёма на два уровня до репозитория оттуда уже нет.
 */
const projectRoot = __dirname;
const repoRoot = process.env.CLAUDE_CONTROL_REPO_ROOT
  ? path.resolve(process.env.CLAUDE_CONTROL_REPO_ROOT)
  : path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(repoRoot, 'packages/contracts')];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
// Пакеты соседних приложений (у них своя линковка) сюда не тянем намеренно:
// один и тот же react в двух копиях ломает хуки.
config.resolver.disableHierarchicalLookup = true;

/**
 * Единственный модуль контрактов, который нужен как ЗНАЧЕНИЕ, а не как тип:
 * список поддерживаемых вложений. Он самодостаточен (ни одного импорта — это
 * условие записано в самом файле ради сервера), поэтому резолвится напрямую в
 * исходник и не тянет за собой zod. Бочку `@claude-control/contracts` так
 * подключать нельзя: она импортирует zod, которого в node_modules приложения нет.
 */
const UPLOADS = '@claude-control/contracts/uploads';
const uploadsFile = path.resolve(repoRoot, 'packages/contracts/src/uploads.ts');
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === UPLOADS) return { type: 'sourceFile', filePath: uploadsFile };
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
