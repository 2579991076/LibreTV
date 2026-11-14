/**
 * m3u8 处理：代理路径重写与广告分片过滤
 *
 * 鉴权说明：重构后代理走同源 httpOnly cookie 鉴权，
 * hls.js 拉取重写后的分片时浏览器自动携带 cookie，无需再往 URL 上拼接 token，
 * 从根本上修复旧版「重写分片丢失鉴权参数导致 401」的问题。
 */

/** 点播代理地址（查询串形式，路径形式会被 EdgeOne 等网关的 URL 归一化破坏，见 proxy-handlers.ts） */
export const PROXY_BASE = '/api/proxy?url=';
/** 直播流代理地址（查询串形式） */
export const LIVE_STREAM_BASE = '/api/live/stream?url=';

/** URI 已是本站代理地址（新旧两种形式：/api/proxy/…、/api/proxy?url=…、/api/live/stream/…、/api/live/stream?url=…）时不再二次改写 */
export function isProxiedUri(uri: string): boolean {
  return uri.startsWith('/api/proxy') || uri.startsWith('/api/live/stream');
}

/**
 * 文档基址：把本站根相对地址锚成绝对地址时使用。
 * 代理形态的地址形如 `/api/proxy?url=…`（见 PROXY_BASE），而
 * `new URL(相对串, 相对基址)` 必然抛错、只能原样返回，于是同一个分片在
 * 预取侧与播放器侧会是两个不同的字符串。SSR 下没有 document，返回
 * undefined，由调用方按「无法锚定」降级处理。
 */
export function documentBaseURI(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.baseURI;
}

export function makeAbsolute(url: string, base: string | undefined): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** 通过 URI 属性引用资源的标签：key/map，以及主播放列表里的备用音轨/字幕（EXT-X-MEDIA）和 I 帧播放列表 */
const URI_ATTR_TAGS = ['#EXT-X-KEY', '#EXT-X-MAP', '#EXT-X-MEDIA:', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-SESSION-KEY'];

/** 将 m3u8 中的地址改写为经过本站代理的地址（分片/key/map 同样改写）。
 *  prefix 可指定代理地址基座（直播流走 /api/live/stream?url=，点播默认 /api/proxy?url=） */
export function rewriteM3u8(
  content: string,
  baseUrl: string,
  depth = 0,
  prefix: string = PROXY_BASE
): string {
  if (depth > 5) return content;
  const lines = content.split('\n');
  const out = lines.map((line) => {
    if (URI_ATTR_TAGS.some((tag) => line.startsWith(tag))) {
      return line.replace(/(URI=")([^"]+)(")/g, (m, p1: string, uri: string, p2: string) => {
        if (isProxiedUri(uri)) return m;
        return p1 + prefix + encodeURIComponent(makeAbsolute(uri, baseUrl)) + p2;
      });
    }
    if (line.startsWith('#') || line.trim() === '') return line;
    if (isProxiedUri(line)) return line;
    return prefix + encodeURIComponent(makeAbsolute(line, baseUrl));
  });
  return out.join('\n');
}
