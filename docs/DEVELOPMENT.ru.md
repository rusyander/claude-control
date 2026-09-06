# Разработка

Как устроен репозиторий, чем проверяется изменение и что должно быть зелёным до слов «готово».

🇬🇧 [English version](DEVELOPMENT.md) · 📖 [Описание проекта](../README.ru.md) · 🏗 [Как устроено](ARCHITECTURE.ru.md) · 🛠 [Починка](TROUBLESHOOTING.ru.md)

---

## Разработка

```
apps/server     API на Fastify · TypeScript исполняется Node напрямую, без сборки
apps/web        React 19 + Vite · структура FSD, SCSS-модули
apps/mobile     Expo + React Native · своя цепочка сборки (npm, не workspace pnpm)
packages/contracts   Общие схемы zod и типы
tools/qa        Скрипты Playwright — скриншоты, аудит вёрстки, проверки сценариев
```

`pnpm dev` — сервер и фронтенд вместе; `pnpm check` — полный гейт (формат, типы, линт, границы модулей, сборка); `pnpm qa:setup` — один раз поставить Chromium для QA-скриптов. `pnpm keepalive:install` ставит сторожа: он раз в 20 секунд проверяет оба порта и поднимает ту половину стенда, которая замолчала (`pnpm keepalive:status`, `pnpm keepalive:off`) — полезно, если стенд живёт часами и его подчищает системный уборщик процессов.

Тот же гейт запускается сам в двух местах. Pre-commit (husky + lint-staged, ставится при `pnpm install`) гоняет ESLint и проверку Prettier по подготовленным к коммиту файлам и отклоняет коммит с CRLF (`tools/check-lf.mjs`). GitHub Actions (`.github/workflows/ci.yml`) на каждый push и pull request повторяет проверку формата, типы, линт, тесты и границы модулей, плюс типы и тесты телефона; `pnpm test` считает покрытие в каждом прогоне и краснеет ниже порога из `vitest.config.ts`. Браузерные QA-прогоны и сборка APK остаются локальными — им нужны живая панель и CLI.

Телефон живёт отдельной цепочкой: `pnpm mobile` — сборка и установка на устройство, `pnpm mobile:type-check` — типы, `pnpm mobile:test` — тесты стора прогонов (vitest на npm телефона), `pnpm mobile:apk` — релизный APK в корень репозитория. Промежуточные файлы нативной сборки Gradle складывает внутрь `node_modules/<пакет>/android/{build,.cxx}` — около 10 ГБ за сборку, которых нет ни в APK, ни в репозитории, — поэтому `pnpm mobile:apk` стирает их сам (`--keep-build` оставит ради быстрой пересборки, `pnpm mobile:clean` уберёт вручную).

QA-скрипты работают по живой панели (`node tools/qa/audit-layout.mjs` и другие), адрес — в `APP_URL`. Доступность и клавиатура: `node tools/qa/check-a11y.mjs` (axe по всем разделам в обеих темах, с модалками создания) и `node tools/qa/check-keyboard.mjs` (порядок Tab, кольцо фокуса, Escape и возврат фокуса); список разделов у них общий — `tools/qa/panel-pages.mjs`, новый раздел добавляется туда, иначе аудит его не увидит. Условный GET списка разговоров доказывает `node tools/qa/check-etag.mjs` (статус берёт с провода через CDP: Playwright показывает ревалидацию 304 как закэшированный 200). Внутренние ссылки документации проверяет `node tools/check-doc-links.mjs`. Границы слоёв FSD проверяет машинно dependency-cruiser: импорты только вниз, cross-feature запрещены. У сервера нет шага сборки — Node исполняет TypeScript через `--experimental-strip-types`, отсюда нижняя граница 22.6 и отказ от конструкций, которым нужна компиляция (parameter properties, `enum`).
