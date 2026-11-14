import type videojs from 'video.js';

type VideoJsPlayer = ReturnType<typeof videojs>;

/**
 * iOS 全屏（点播 player-shell 与直播 live-player 共用，逻辑必须一致）。
 *
 * 走 tech 的原生 enter/exitFullScreen（webkitEnterFullscreen，内部已处理
 * “暂停且无元数据时先 priming”），全屏状态由 webkitbeginfullscreen /
 * webkitendfullscreen 代理回 fullscreenchange 同步。原生全屏跟随手机旋转，
 * 需要关掉竖屏锁定才能转横屏（2026-11-14 老大决定：不要 CSS 强制横屏，
 * 恢复原生全屏，由她自己关竖屏锁定）。
 *
 * 注意：Video.js 优先走标准 API（iPhone 上只按当前朝向铺满、不跟随旋转），
 * 这里在 iOS 上改走原生。requestFullscreen / exitFullscreen 被整体替换，
 * 调用方（全屏按钮等）不用改。
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
  const origRequestFullscreen = player.requestFullscreen.bind(player);
  const origExitFullscreen = player.exitFullscreen.bind(player);
  player.requestFullscreen = ((options) => {
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
