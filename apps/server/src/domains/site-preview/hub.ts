import { randomBytes, randomUUID } from 'node:crypto';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { PICK_HTML_MAX, PICK_TEXT_MAX, type PickPayload } from '@agentdeck/contracts/site-preview';
import { startSiteProxy } from './proxy.ts';
import type {
  OpenSite,
  SiteOpenResult,
  SitePickResult,
  SiteRunnerSource,
} from './site-preview.types.ts';

/** Имена loopback: реестр пишет `http://localhost:<порт>`, иной хост окно не открывает. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Окна сайтов (D20, P173): по одному прокси на запущенную панелью цель. Открыть можно только
 * то, что реестр запусков знает как работающее и с адресом на loopback; запись запуска ушла —
 * прокси закрыт. Выбор элемента проверяется здесь ещё раз (`nonce`) и маскируется DLP, прежде
 * чем попасть в ввод чата.
 */
export class SitePreviewHub {
  private readonly source: SiteRunnerSource;
  private readonly sites = new Map<string, OpenSite>();
  /** Открытие в полёте по пути цели: два клика подряд не поднимают два прокси. */
  private readonly opening = new Map<string, Promise<SiteOpenResult>>();
  private readonly unsubscribe: () => void;

  constructor(source: SiteRunnerSource) {
    // Node исполняет TS в strip-only режиме — parameter properties не работают.
    this.source = source;
    this.unsubscribe = source.onGone((path) => void this.closePath(path));
  }

  /** Открыть окно сайта цели `path` (ключ реестра запусков). */
  open(path: string): Promise<SiteOpenResult> {
    const pending = this.opening.get(path);
    if (pending) return pending;
    const next = this.openNow(path).finally(() => this.opening.delete(path));
    this.opening.set(path, next);
    return next;
  }

  private async openNow(path: string): Promise<SiteOpenResult> {
    const run = this.source.get({ projectPath: path });
    if (!run || run.status !== 'running' || !run.url || run.port === undefined) {
      return { ok: false, code: 'site-not-running' };
    }
    const dev = new URL(run.url);
    if (!LOOPBACK.has(dev.hostname)) return { ok: false, code: 'site-not-loopback' };
    const existing = [...this.sites.values()].find((site) => site.path === run.path);
    if (existing && existing.targetPort === run.port)
      return { ok: true, preview: viewOf(existing) };
    if (existing) await this.close(existing);

    const nonce = randomBytes(24).toString('base64url');
    const proxy = await startSiteProxy({
      target: { host: dev.hostname.replace(/^\[|\]$/g, ''), port: run.port },
      nonce,
    });
    const site: OpenSite = {
      siteId: randomUUID(),
      path: run.path,
      nonce,
      devOrigin: dev.origin,
      targetPort: run.port,
      proxy,
    };
    this.sites.set(site.siteId, site);
    return { ok: true, preview: viewOf(site) };
  }

  /**
   * Выбор элемента от окна панели: `nonce` своего окна, текст и разметка — через маску секретов
   * DLP (P174), адрес — в origin dev-сервера: агенту нужен его сайт, а не порт прокси.
   */
  pick(siteId: string, payload: PickPayload): SitePickResult {
    const site = this.sites.get(siteId);
    if (!site) return { ok: false, code: 'site-unknown' };
    if (payload.nonce !== site.nonce) return { ok: false, code: 'pick-nonce' };
    return {
      ok: true,
      pick: {
        ...payload,
        // Селектор несёт id страницы, адрес — её запрос (`?token=…`): в чат и модели — тоже через маску.
        selector: maskSecretsInText(payload.selector),
        text: maskSecretsInText(payload.text).slice(0, PICK_TEXT_MAX),
        outerHTML: maskSecretsInText(payload.outerHTML).slice(0, PICK_HTML_MAX),
        url: devUrlOf(payload.url, site),
      },
    };
  }

  /** Сколько окон открыто — для проверок и строки в журнале. */
  size(): number {
    return this.sites.size;
  }

  /** Закрыть всё (выход панели) и отписаться от реестра. */
  async closeAll(): Promise<void> {
    this.unsubscribe();
    await Promise.all([...this.sites.values()].map((site) => this.close(site)));
  }

  private async closePath(path: string): Promise<void> {
    const gone = [...this.sites.values()].filter((site) => site.path === path);
    await Promise.all(gone.map((site) => this.close(site)));
  }

  private async close(site: OpenSite): Promise<void> {
    this.sites.delete(site.siteId);
    await site.proxy.close();
  }
}

function viewOf(site: OpenSite): { siteId: string; url: string; nonce: string } {
  return { siteId: site.siteId, url: `${site.proxy.origin}/`, nonce: site.nonce };
}

/** Адрес выбора с прокси — на dev-сервер; чужой адрес оставляем как есть. Маска — у обоих. */
function devUrlOf(url: string, site: OpenSite): string {
  for (const own of [site.proxy.origin, `http://localhost:${site.proxy.port}`]) {
    if (url === own || url.startsWith(`${own}/`))
      return maskSecretsInText(`${site.devOrigin}${url.slice(own.length)}`);
  }
  return maskSecretsInText(url);
}
