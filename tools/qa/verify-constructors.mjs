// Функциональная перепроверка всех конструкторов реальным созданием через API.
// Всё с префиксом qa-verify-, в конце удаляется.
const BASE = 'http://127.0.0.1:5178/api';
const results = [];
const cleanup = [];

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { code: r.status, json };
}
function ok(name, cond, detail = '') {
  results.push({ name, pass: cond, detail });
}

// ── 1. ПРАВИЛА: конструктор (составное) ──
{
  const body = `## Что можно\n- Читать бэкенд\n\n## Что нельзя\n- Править без спроса\n\n## С осторожностью\n- Трогать миграции`;
  const r = await req('POST', '/rules', {
    title: 'qa-verify-rule-builder',
    body,
    isEnabled: true,
    groupIds: [],
  });
  ok('Правило-конструктор создано', r.code === 200 && r.json.ok);
  cleanup.push(['rule', 'qa-verify-rule-builder']);
}
// ── 2. ПРАВИЛА: пакетное (несколько) ──
{
  for (const [title, b] of [
    ['qa-verify-r1', 'текст1'],
    ['qa-verify-r2', 'текст2'],
    ['qa-verify-r3', ''],
  ]) {
    await req('POST', '/rules', { title, body: b, isEnabled: true, groupIds: [] });
    cleanup.push(['rule', title]);
  }
  const list = (await req('GET', '/rules')).json;
  const found = list.filter((x) => /^qa-verify-r[123]$/.test(x.title)).length;
  ok('Правила пакетом (3 шт)', found === 3, `найдено ${found}`);
}
// ── 3. MCP: импорт JSON (stdio + sse) ──
{
  await req('POST', '/mcp', {
    name: 'qa-verify-mcp-stdio',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'test'],
    env: {},
    headers: {},
    groupIds: [],
  });
  await req('POST', '/mcp', {
    name: 'qa-verify-mcp-sse',
    transport: 'sse',
    url: 'https://example.com/sse',
    args: [],
    env: {},
    headers: {},
    groupIds: [],
  });
  cleanup.push(['mcp', 'qa-verify-mcp-stdio'], ['mcp', 'qa-verify-mcp-sse']);
  const list = (await req('GET', '/mcp')).json;
  const stdio = list.find((x) => x.name === 'qa-verify-mcp-stdio');
  const sse = list.find((x) => x.name === 'qa-verify-mcp-sse');
  ok('MCP stdio создан', stdio?.transport === 'stdio', stdio?.transport);
  ok('MCP sse создан с url', sse?.transport === 'sse' && sse?.url === 'https://example.com/sse');
}
// ── 4. ХУК: пресет (страж) ──
{
  const r = await req('POST', '/hooks', {
    event: 'PreToolUse',
    matchers: ['Bash', 'PowerShell'],
    isEnabled: true,
    groupIds: [],
    scriptName: 'qa-verify-guard',
    template: 'guard',
    description: 'проверка',
    message: '',
    guardPatterns: ['rm -rf', 'DROP TABLE'],
    command: '',
  });
  ok('Хук-пресет создан', r.code === 200 && r.json.ok);
  cleanup.push(['hook-script', 'qa-verify-guard.mjs']);
  // проверяем что скрипт создан
  const files = (await req('GET', '/resources/script/qa-verify-guard.mjs/files')).json;
  ok('Скрипт хука сгенерирован', Array.isArray(files.files) && files.files.length === 1);
}
// ── 5. СКРИПТ: шаблон ──
{
  const content = '#!/usr/bin/env node\n// qa-verify страж\nprocess.exit(0);\n';
  const r = await req('POST', '/scripts', { name: 'qa-verify-script.mjs', content });
  ok('Скрипт из шаблона создан', r.code === 200 && r.json.ok);
  cleanup.push(['script', 'qa-verify-script.mjs']);
}
// ── 6. СКИЛЛ: конструктор + шаблон ──
{
  await req('POST', '/skills', {
    name: 'qa-verify-skill',
    description: 'Use КОГДА проверка',
    body: '# qa-verify-skill',
    groupIds: [],
  });
  const apply = await req('POST', '/resources/skill/qa-verify-skill/apply-template', {
    templateId: 'skill-full',
  });
  ok('Скилл + шаблон (полный)', apply.json.created >= 3, `создано ${apply.json.created}`);
  const files = (await req('GET', '/resources/skill/qa-verify-skill/files')).json;
  const paths = files.files.map((f) => f.path);
  ok(
    'Структура полного шаблона',
    paths.includes('config/README.md') && paths.includes('templates/README.md'),
    paths.join(','),
  );
  cleanup.push(['skill', 'qa-verify-skill']);
}
// ── 7. ПЕРЕМЕННЫЕ: пакет (settings + secrets) ──
{
  await req('POST', '/env', {
    key: 'QA_VERIFY_PLAIN',
    value: 'x',
    source: 'settings',
    isSecret: false,
  });
  await req('POST', '/env', {
    key: 'QA_VERIFY_TOKEN',
    value: 'secret123',
    source: 'secrets',
    isSecret: true,
  });
  const list = (await req('GET', '/env')).json;
  const plain = list.find((x) => x.key === 'QA_VERIFY_PLAIN');
  const secret = list.find((x) => x.key === 'QA_VERIFY_TOKEN');
  ok('Переменная settings', plain?.source === 'settings');
  ok('Переменная secrets (маска)', secret?.source === 'secrets' && secret?.isSecret === true);
  cleanup.push(['env', 'QA_VERIFY_PLAIN|settings'], ['env', 'QA_VERIFY_TOKEN|secrets']);
}

// ── УБОРКА ──
for (const [kind, id] of cleanup) {
  try {
    if (kind === 'rule') {
      const l = (await req('GET', '/rules')).json;
      const r = l.find((x) => x.title === id);
      if (r) await req('DELETE', `/rules/${r.id}`);
    } else if (kind === 'mcp') {
      const l = (await req('GET', '/mcp')).json;
      const s = l.find((x) => x.name === id);
      if (s) await req('DELETE', `/mcp/${s.id}`);
    } else if (kind === 'hook-script') await req('DELETE', `/resources/script/x/file?file=${id}`);
    else if (kind === 'script') await req('DELETE', `/scripts/${id}`);
    else if (kind === 'skill') await req('DELETE', `/skills/${id}`);
    else if (kind === 'env') {
      const [k, src] = id.split('|');
      await req('DELETE', `/env?key=${k}&source=${src}`);
    }
  } catch {
    // Уборка после проверки: сущности может уже не быть, и это не повод падать.
  }
}

// ── ОТЧЁТ ──
console.log('\n=== ФУНКЦИОНАЛЬНАЯ ПЕРЕПРОВЕРКА ===');
for (const r of results)
  console.log(`  ${r.pass ? 'OK  ' : 'FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const failed = results.filter((r) => !r.pass).length;
console.log(
  `\nИтог: ${results.length - failed}/${results.length} прошло${failed ? ', ПРОВАЛЕНО: ' + failed : ''}`,
);
