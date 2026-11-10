import {
  PICK_CANCEL_TYPE,
  PICK_HTML_MAX,
  PICK_MESSAGE_TYPE,
  PICK_MODE_TYPE,
  PICK_TEXT_MAX,
} from '@agentdeck/contracts/site-preview';

/**
 * Скрипт выбора, который прокси отдаёт по `PICK_SCRIPT_PATH` (P174). Живёт в странице сайта:
 * режим выбора включает только родитель (окно панели) своим `nonce`; наведение подсвечивает
 * элемент, щелчок не доходит до сайта и уходит родителю описанием: селектор, уникальный в
 * странице, тег, текст до `PICK_TEXT_MAX`, разметка до `PICK_HTML_MAX`, место и адрес.
 * Ответ идёт только тому origin, который включил режим, — не `*`.
 */
export function pickScript(nonce: string): string {
  const consts = JSON.stringify({
    nonce,
    pick: PICK_MESSAGE_TYPE,
    mode: PICK_MODE_TYPE,
    cancel: PICK_CANCEL_TYPE,
    textMax: PICK_TEXT_MAX,
    htmlMax: PICK_HTML_MAX,
  });
  return `(() => {
  'use strict';
  const C = ${consts};
  if (window.parent === window || window.__agentdeckPick) return;
  window.__agentdeckPick = true;
  let parentOrigin = null;
  let on = false;
  let box = null;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\\w-]/g, (c) => '\\\\' + c));
  const only = (sel, el) => {
    try {
      const all = document.querySelectorAll(sel);
      return all.length === 1 && all[0] === el;
    } catch {
      return false;
    }
  };
  // Селектор от элемента вверх: id, если он один в странице, иначе тег с :nth-of-type среди
  // соседей того же тега — до первого уровня, на котором совпадение одно.
  const selectorOf = (el) => {
    if (el.id && only('#' + esc(el.id), el)) return '#' + esc(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node !== el && node.id && only('#' + esc(node.id), node)) {
        parts.unshift('#' + esc(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (only(parts.join(' > '), el)) return parts.join(' > ');
      node = parent;
    }
    return parts.join(' > ');
  };
  const frame = () => {
    if (box) return box;
    box = document.createElement('div');
    box.setAttribute('data-agentdeck-pick-box', '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;outline:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:2px;display:none';
    document.documentElement.appendChild(box);
    return box;
  };
  const show = (el) => {
    const r = el.getBoundingClientRect();
    const b = frame();
    b.style.display = 'block';
    b.style.left = r.left + 'px';
    b.style.top = r.top + 'px';
    b.style.width = r.width + 'px';
    b.style.height = r.height + 'px';
  };
  const setOn = (next) => {
    on = next;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on && box) box.style.display = 'none';
  };
  const target = (e) => (e.target && e.target.nodeType === 1 && e.target !== box ? e.target : null);
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      type: C.pick,
      nonce: C.nonce,
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, C.textMax),
      outerHTML: el.outerHTML.slice(0, C.htmlMax),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      url: location.href,
    };
  };
  const post = (data) => {
    if (parentOrigin) window.parent.postMessage(data, parentOrigin);
  };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window.parent || !d || d.type !== C.mode || d.nonce !== C.nonce) return;
    parentOrigin = e.origin;
    setOn(Boolean(d.on));
  });
  document.addEventListener('mousemove', (e) => {
    const el = on && target(e);
    if (el) show(el);
  }, true);
  // Пока идёт выбор, нажатие не достаётся сайту: кнопка не отправит форму, ссылка не уведёт.
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick']) {
    document.addEventListener(type, (e) => {
      if (!on) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }
  document.addEventListener('click', (e) => {
    if (!on) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = target(e);
    if (!el) return;
    setOn(false);
    post(describe(el));
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!on || e.key !== 'Escape') return;
    e.preventDefault();
    setOn(false);
    post({ type: C.cancel, nonce: C.nonce });
  }, true);
})();
`;
}
