import type videojs from 'video.js';

type VideoJsPlayer = ReturnType<typeof videojs>;

/**
 * iOS 全屏默认横屏（点播 player-shell 与直播 live-player 共用，逻辑必须一致）。
 *
 * 背景：iPhone 上标准 Fullscreen API 只会按当前朝向（竖屏）铺满，不会跟随
 * 手机转横屏；网页也无法像原生 App 那样强制转屏。按朝向分流：
 * - 竖屏：走 Video.js 的 enterFullWindow（网页全屏铺满视口）+ CSS 旋转 90°
 *   （globals.css 里 body.vjs-full-window 的 portrait 规则），点全屏就横屏，
 *   不用关竖屏锁定；退出时走 exitFullWindow。
 * - 横屏：走 tech 的原生 enter/exitFullScreen（webkitEnterFullscreen，
 *   内部已处理“暂停且无元数据时先 priming”），全屏状态由
 *   webkitbeginfullscreen/webkitendfullscreen 代理回 fullscreenchange 同步。
 * - 非 iOS：走 Video.js 默认全屏。
 *
 * 注意：Video.js 优先走标准 API，这里在 iOS 上按朝向改走上述两条路。
 * requestFullscreen / exitFullscreen 被整体替换，调用方（全屏按钮等）不用改。
 */
export function installIOSFullscreenOverride(
  player: VideoJsPlayer,
  videoEl: HTMLVideoElement
): void {
  type NativeFSVideo = HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitExitFullScreen?: () => void;
    webkitDisplayingFullscreen?: boolean;
  };
  type NativeFSTech = { enterFullScreen?: () => void; exitFullScreen?: () => void };
  const nativeVideo = videoEl as NativeFSVideo;
  const nativeTech = () => player.tech() as unknown as NativeFSTech | null;
  const hasNativeFullscreen = () => typeof nativeVideo.webkitEnterFullscreen === 'function';
  const isIOSPortrait = () =>
    hasNativeFullscreen() && window.matchMedia('(orientation: portrait)').matches;
  const origRequestFullscreen = player.requestFullscreen.bind(player);
  const origExitFullscreen = player.exitFullscreen.bind(player);
  player.requestFullscreen = ((options) => {
    if (isIOSPortrait()) {
      // 竖屏：网页全屏 + CSS 旋转 90°，默认横屏，不用关竖屏锁定
      player.enterFullWindow();
      return Promise.resolve();
    }
    if (hasNativeFullscreen()) {
      try {
        nativeTech()?.enterFullScreen?.();
        return Promise.resolve();
      } catch {
        /* 失败则走标准路径 */
      }
    }
    return origRequestFullscreen(options);
  }) as typeof player.requestFullscreen;
  player.exitFullscreen = (() => {
    if (player.isFullWindow) {
      player.exitFullWindow();
      return Promise.resolve();
    }
    if (hasNativeFullscreen() && nativeVideo.webkitDisplayingFullscreen) {
      try {
        nativeTech()?.exitFullScreen?.();
        return Promise.resolve();
      } catch {
        /* 失败则走标准路径 */
      }
    }
    return origExitFullscreen();
  }) as typeof player.exitFullscreen;
}
