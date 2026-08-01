/**
 * Возврат с сервера авторизации: куда он ведёт и что видит пользователь.
 */

/**
 * Адрес, куда сервер авторизации вернёт пользователя после входа. Порт тот же,
 * что слушает API (index.ts), а хост — 127.0.0.1: петлевой IP-литерал OAuth
 * разрешает для нативных приложений явно (RFC 8252), в отличие от `localhost`.
 */
export function oauthCallbackUrl(): string {
  const port = Number(process.env.PORT ?? 5178);
  return `http://127.0.0.1:${port}/api/mcp/oauth/callback`;
}

/**
 * Страница, которую видит пользователь в окне входа после возврата с сервера
 * авторизации. Ничего не запрашивает — только сообщает исход и закрывается
 * сама, чтобы окно не висело. Всё встроено: у отдельного окна нет доступа к
 * стилям панели, а тянуть их с origin API запрещено origin-guard'ом.
 */
export function oauthCallbackPage(ok: boolean, detail?: string): string {
  const title = ok ? 'Авторизация прошла' : 'Авторизация не удалась';
  const body = ok
    ? 'Токен получен и сохранён. Окно можно закрыть — вернитесь в панель и проверьте связь.'
    : `Не удалось завершить вход: ${escapeHtml(detail ?? 'неизвестная ошибка')}`;
  const accent = ok ? '#34a853' : '#ea4335';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 system-ui, sans-serif; background: #0f1115; color: #e8eaed; }
  .card { max-width: 30rem; padding: 2rem; text-align: center; }
  .mark { width: 3rem; height: 3rem; border-radius: 50%; margin: 0 auto 1rem;
    display: grid; place-items: center; background: ${accent}22; color: ${accent};
    font-size: 1.5rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #9aa0a6; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${ok ? '✓' : '!'}</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
  ${ok ? '<script>setTimeout(function () { window.close(); }, 2000);</script>' : ''}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
