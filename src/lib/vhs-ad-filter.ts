// VHS (Video.js http-streaming) 请求拦截：广告清单过滤。
//
// 背景：旧版播放器用 hls.js 的自定义 loader 在拉清单/分片时把广告段落
// 从 m3u8 文本里剔掉（stripAdGroups）。Video.js 的 VHS 没有等价的
// "改写清单正文" 钩子——onResponse/onRequest 钩子收到的 response 对象
// 不是 loader 真正读取的那份（loader 直接读原始 XHR 的 responseText）。
//
// 真正的拦截点（已在 video.js 8.24.2 源码里核实）：
//   播放列表/分片加载器调用 this.vhs_.xhr(...)；
//   tech.vhs.xhr 是 xhrFactory()，它内部用
//     xhrMethod = videojs.Vhs.xhr.original === true ? videojs.xhr : videojs.Vhs.xhr
//   发起请求；
//   完成后 callbackWrapper 直接读 request.responseText。
// 因此：把全局 videojs.Vhs.xhr 换成一个包装器（在建播放器之前安装，
// 无竞态），包装器委托给原始 videojs.xhr，在回调里先把 responseText
// 改写成过滤后的文本，再交给 loader 读取。只改写 #EXTM3U 开头、且
// responseType 不是 arraybuffer（分片是二进制，绝不碰）的内容。
//
// 作用域：全局包装器 + 模块级 enabled 开关。同一时间只挂一个播放器；
// 点播页挂载时按 adFilter 设置开关，卸载时复位为关，避免影响直播页
// （直播是实时流，不做广告过滤）。

import videojs from 'video.js';
import { stripAdGroups } from './m3u8';

let installed = false;
let enabled = false;

/** 安装全局 VHS xhr 包装器（幂等）。必须在创建 Video.js 播放器之前调用一次。 */
export function installVhsAdFilter(): void {
  if (installed) return;
  installed = true;
  try {
    const vhs = (videojs as unknown as { Vhs?: { xhr?: unknown } }).Vhs;
    if (!vhs || typeof vhs.xhr !== 'function') return;
    const rawXhr = videojs.xhr;
    if (typeof rawXhr !== 'function') return;

    const wrapped = function (options: unknown, callback: (...args: unknown[]) => unknown) {
      // 委托给原始 videojs.xhr；它同步返回 XHR 对象，异步回调。
      // 闭包里的 request 在回调触发时已经赋值完成。
      let request: XMLHttpRequest | null = null;
      try {
        request = rawXhr(
          options as never,
          function (error: unknown, response: unknown) {
            if (enabled && !error && request) {
              try {
                // 分片（二进制）绝不碰：只有 responseType 为 ''/'text' 才读 responseText
                const rt = (request as XMLHttpRequest).responseType;
                if (rt !== 'arraybuffer') {
                  const text = (request as XMLHttpRequest).responseText;
                  if (typeof text === 'string' && text.startsWith('#EXTM3U')) {
                    const uri = (options as { uri?: string } | null)?.uri;
                    const cleaned = stripAdGroups(text, uri);
                    Object.defineProperty(request, 'responseText', {
                      value: cleaned,
                      configurable: true,
                    });
                  }
                }
              } catch {
                // 改写失败不影响播放：保持原文本继续
              }
            }
            return (callback as (...a: unknown[]) => unknown)(error, response);
          } as never
        ) as unknown as XMLHttpRequest;
      } catch {
        // 委托失败时回退到原始 xhr（不拦截）
        return (vhs.xhr as (...a: unknown[]) => unknown)(options, callback);
      }
      return request;
    };

    // 不设置 .original：xhrFactory 据此判断用包装器还是原始 xhr。
    // 包装器不是 "original"，因此 loader 会走包装器。
    vhs.xhr = wrapped as never;
  } catch {
    // 安装失败不影响播放：无广告过滤而已
  }
}

/** 点播播放器按 adFilter 设置开关；卸载时复位为 false。 */
export function setVhsAdFilterEnabled(v: boolean): void {
  enabled = v;
}
