'use client';

import { useEffect, useRef, useState } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import type Mpegts from 'mpegts.js';
import { Spinner } from './states';
import { attachVolumeBoost, type VolumeBoostHandle } from '@/lib/volume-boost';
import { installIOSFullscreenOverride } from '@/lib/videojs-ios-fullscreen';

/**
 * 直播播放器：与点播 player-shell 完全独立，基于 Video.js 8。
 * - 引擎分发：.m3u8 → Video.js 内置 VHS（iOS Safari 自动走原生 HLS，不经过 MSE）；
 *   .flv → mpegts.js（动态加载，按需 ~150KB），挂在 Video.js tech 的 video 元素上；
 *   mp4/webm 等原生容器 → Video.js 直出，容器由浏览器嗅探；
 * - 无扩展名的地址（如 /channel/xxx?token=...）默认按 HLS 处理，
 *   HLS 直连与代理均失败后**回退原生播放**一次（覆盖"内容是 MP4 却无 .m3u8 后缀"的源）；
 * - 每级直连失败自动切换到 /api/live/stream 代理通道重试一次；
 * - FLV 依赖 MSE，iOS 永远播不了：iOS 上遇到 FLV 直接给明确提示，不承诺能播；
 * - 直播态 UI：无进度条、无倍速、无截图、无连播；控制条 3s 无操作自动隐藏。
 */

type VideoJsPlayer = ReturnType<typeof videojs>;
type MpegtsPlayer = Mpegts.Player;

/** 代理地址前缀（新旧形式 /api/live/stream/… 与 /api/live/stream?url=… 的共同前缀，用于防二次代理） */
const STREAM_PROXY_PREFIX = '/api/live/stream';
/** 代理地址（查询串形式：路径里的 %2F 会被 EdgeOne 等网关归一化，查询串不受影响） */
const STREAM_PROXY_BASE = '/api/live/stream?url=';

export function isFlvUrl(url: string): boolean {
  return /\.flv(\?|$)/i.test(url);
}

/** 浏览器原生可播的直链容器（非 HLS/FLV） */
const NATIVE_MEDIA_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|$)/i;

/** 原生容器扩展名 → Video.js src 用的 MIME */
const NATIVE_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
};

type Engine = 'hls' | 'flv' | 'native';

function engineOf(url: string): Engine {
  if (isFlvUrl(url)) return 'flv';
  if (NATIVE_MEDIA_RE.test(url)) return 'native';
  return 'hls';
}

function proxyUrl(url: string): string {
  return STREAM_PROXY_BASE + encodeURIComponent(url);
}

/** iOS：iPhone/iPad/iPod，或 iPadOS（UA 伪装成 Mac + 多点触控） */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

interface LivePlayerProps {
  /** 上游直播流地址（直连优先，失败自动走代理） */
  url: string;
  title: string;
  /** 上一台/下一台：传入时注册为播放器控制条按钮（全屏内也可操作） */
  onPrevChannel?: () => void;
  onNextChannel?: () => void;
  /** 音量放大（Web Audio 增益链）：默认关闭，关闭时完全不接入音频链路 */
  volumeBoost: boolean;
}

export function LivePlayer({ url, title, onPrevChannel, onNextChannel, volumeBoost }: LivePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<VideoJsPlayer | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(true);
  // 手动重试计数：变化时重建整个播放器实例（比 location.reload() 轻得多）
  const [retryNonce, setRetryNonce] = useState(0);
  // 起播前的品牌占位图（与点播 player-shell 共用 /player-poster.png），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  // 换台 OSD：切台后短暂显示频道名（键盘换台/控制条换台时的视觉反馈，全屏内同样可见）
  const [osdTitle, setOsdTitle] = useState('');
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 音量放大句柄（换台销毁播放器时释放）；用 ref 才能在设置变化时被另一个 effect 操作 */
  const volumeBoostRef = useRef<VolumeBoostHandle | null>(null);
  // 创建实例的 effect 不依赖 volumeBoost（换台才重建），起播回调靠这个 ref 读最新设置
  const volumeBoostSettingRef = useRef(volumeBoost);
  volumeBoostSettingRef.current = volumeBoost;

  // url 变化即换台：显示频道名 2.5s
  useEffect(() => {
    if (!url) return;
    setOsdTitle(title);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsdTitle(''), 2500);
    return () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    };
  }, [url, title]);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  useEffect(() => {
    if (!containerRef.current || !url) return;
    setError('');
    setLoading(true);
    setShowPoster(true);

    let playbackStarted = false;
    let disposed = false;
    let destroyed = false;
    /** 当前所处的加载阶段（决定播放器 error 事件之后怎么接力） */
    let stage: 'hls-direct' | 'hls-proxy' | 'native-direct' | 'native-proxy' | 'native-fallback' | 'flv' =
      'hls-direct';
    /** 原生回退播放注册的 error 监听清理函数（切台/销毁时调用） */
    let nativeCleanup: (() => void) | null = null;

    const cleanupEngines = () => {
      if (mpegtsRef.current) {
        try {
          mpegtsRef.current.pause();
        } catch {
          /* 忽略 */
        }
        try {
          mpegtsRef.current.destroy();
        } catch {
          /* 忽略 */
        }
        mpegtsRef.current = null;
      }
      if (nativeCleanup) {
        try {
          nativeCleanup();
        } catch {
          /* 忽略 */
        }
        nativeCleanup = null;
      }
    };

    /**
     * 原生回退播放：把地址直接挂到 tech 的 <video> 元素上，让浏览器嗅探容器。
     * 作为 HLS 两级都失败后的兜底——覆盖"地址没有 .m3u8 后缀但内容其实是 MP4"的源。
     * 直连失败（CORS/混合内容）时再走一次代理。
     */
    const setupNativeFallback = (
      video: HTMLVideoElement,
      mediaUrl: string,
      allowProxyFallback: boolean,
      failMessage?: string
    ) => {
      cleanupEngines();
      const onError = () => {
        video.removeEventListener('error', onError);
        nativeCleanup = null;
        if (disposed || destroyed) return;
        if (allowProxyFallback && !mediaUrl.startsWith(STREAM_PROXY_PREFIX)) {
          showHint('直连失败，改用代理重试...');
          setupNativeFallback(video, proxyUrl(url), false, failMessage);
          return;
        }
        setError(failMessage || '该地址不是可播放的直播流（内容可能是文件或错误提示）');
      };
      video.addEventListener('error', onError);
      nativeCleanup = () => video.removeEventListener('error', onError);
      video.src = mediaUrl;
      video.load();
      video.play().catch(() => {});
    };

    /** HLS：Video.js src（VHS 接管；失败时 error 事件接力到代理/原生回退） */
    const setupHls = (mediaUrl: string) => {
      cleanupEngines();
      player.src({ src: mediaUrl, type: 'application/x-mpegURL' });
      player.play()?.catch(() => {});
    };

    /** 原生容器：Video.js src + MIME；失败时 error 事件接力到代理 */
    const setupNative = (mediaUrl: string) => {
      cleanupEngines();
      const ext = mediaUrl.match(/\.([a-z0-9]+)(\?|$)/i)?.[1]?.toLowerCase() ?? 'mp4';
      player.src({ src: mediaUrl, type: NATIVE_MIME[ext] ?? 'video/mp4' });
      player.play()?.catch(() => {});
    };

    const setupFlv = async (
      video: HTMLVideoElement,
      mediaUrl: string,
      allowProxyFallback: boolean
    ) => {
      cleanupEngines();
      let Mpegts: typeof import('mpegts.js').default;
      try {
        Mpegts = (await import('mpegts.js')).default;
      } catch {
        setError('FLV 播放模块加载失败，请检查网络后重试');
        return;
      }
      if (disposed || destroyed) return;
      if (!Mpegts.getFeatureList().mseLivePlayback) {
        setError('当前浏览器不支持 FLV 直播播放');
        return;
      }
      const flvPlayer = Mpegts.createPlayer(
        {
          type: 'flv',
          isLive: true,
          url: mediaUrl,
        },
        {
          enableWorker: false,
          enableStashBuffer: false,
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          lazyLoad: false,
        }
      );
      mpegtsRef.current = flvPlayer;
      flvPlayer.attachMediaElement(video);
      flvPlayer.load();
      flvPlayer.on(Mpegts.Events.ERROR, (errType: string) => {
        if (disposed || destroyed) return;
        if (!playbackStarted && allowProxyFallback && !mediaUrl.startsWith(STREAM_PROXY_PREFIX)) {
          showHint('直连失败，改用代理重试...');
          void setupFlv(video, proxyUrl(url), false);
          return;
        }
        setError(`直播流加载失败（${errType}），请尝试其他频道`);
      });
      void Promise.resolve(flvPlayer.play()).catch(() => {});
    };

    // <video> 元素由本 effect 创建并挂进容器，销毁时随播放器一起移除，
    // React 不直接持有它，避免 dispose 时 DOM 归属冲突。
    const videoEl = document.createElement('video');
    videoEl.className = 'video-js';
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('preload', 'auto');
    containerRef.current.appendChild(videoEl);
    videoElRef.current = videoEl;

    const player = videojs(videoEl, {
      autoplay: true,
      controls: true,
      preload: 'auto',
      fill: true,
      volume: 0.9,
      playsinline: true,
      // 直播 UI：进度条换成 LIVE 指示（下面仍显式隐藏 progressControl 兜底）
      liveui: true,
      // 3s 无操作自动隐藏控制条（触屏也适用）
      inactivityTimeout: 3000,
      language: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
      // 不用 Video.js 自带的大播放按钮/错误弹窗/加载圈：本组件自有海报、错误面板与 Spinner
      bigPlayButton: false,
      errorDisplay: false,
      loadingSpinner: false,
      controlBar: {
        remainingTimeDisplay: false,
      },
    });
    playerRef.current = player;

    // iOS 全屏默认横屏（竖屏走网页全屏 + CSS 旋转 90°，横屏走原生全屏），
    // 与点播 player-shell 共用同一份逻辑（见 lib/videojs-ios-fullscreen）。
    installIOSFullscreenOverride(player, videoEl);

    // 上一台/下一台：注册到控制条最左侧（普通态与全屏均可见），未传不显示
    const channelBtnSvg = (path: string) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="display:block;margin:auto"><path d="${path}"/></svg>`;
    player.ready(() => {
      if (disposed || destroyed) return;
      const controlBar = player.getChild('controlBar');
      if (controlBar) {
        // 直播隐藏进度条
        controlBar.getChild('progressControl')?.hide();
        let btnIndex = 0;
        const addChannelButton = (controlText: string, svgPath: string, onClick: () => void) => {
          const btn = controlBar.addChild(
            'button',
            { controlText, clickHandler: () => onClick() },
            btnIndex++
          );
          const icon = btn.el().querySelector('.vjs-icon-placeholder');
          if (icon) (icon as HTMLElement).innerHTML = channelBtnSvg(svgPath);
        };
        if (onPrevChannel) addChannelButton('上一台', 'M11 19l-7-7 7-7m8 14l-7-7 7-7', onPrevChannel);
        if (onNextChannel) addChannelButton('下一台', 'M13 5l7 7-7 7M5 5l7 7-7 7', onNextChannel);
      }
      // FLV：tech 就绪后把 mpegts 挂到 tech 的 video 元素上
      if (engine === 'flv' && !isIOS()) {
        stage = 'flv';
        void setupFlv(player.tech().el() as HTMLVideoElement, url, true);
      }
    });

    player.on('playing', () => {
      playbackStarted = true;
      setLoading(false);
      setShowPoster(false);
      setError('');
      // 音量放大：起播后（src 已就绪）才挂增益图。默认关闭时完全不接入；
      // 跨域直连流会自动跳过，代理/VHS 的 blob: 源可安全放大；失败一律原样播放。
      if (volumeBoostSettingRef.current && !volumeBoostRef.current) {
        volumeBoostRef.current = attachVolumeBoost(videoEl);
      }
    });

    player.on('loadedmetadata', () => {
      if (disposed || destroyed) return;
      // H.265 检测：大量国内 IPTV 源为 HEVC 编码，Chromium 内核通常无法软解。
      // VHS 的 manifest 信息里带 CODECS；原生 HLS（iOS Safari）无 VHS，跳过
      // （Safari 本身能解 HEVC，不提示）。
      const tech = player.tech(true) as unknown as {
        vhs?: { playlists?: { media?: () => { attributes?: { CODECS?: string } } } };
      };
      const codecs = tech.vhs?.playlists?.media?.()?.attributes?.CODECS ?? '';
      if (/hvc1|hev1|hevc/i.test(codecs)) {
        const support = videoEl.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
        if (!support) {
          showHint('该频道为 H.265 编码，当前浏览器可能无法解码，建议用 Edge/Safari');
        }
      }
    });

    player.on('error', () => {
      if (disposed || destroyed) return;
      // 原生回退与 FLV 阶段的错误各自由 video error 监听 / mpegts ERROR 事件接管
      if (stage === 'native-fallback' || stage === 'flv') return;
      if (playbackStarted) {
        setError('直播流中断，该源可能已失效，请尝试其他频道');
        return;
      }
      if (stage === 'hls-direct') {
        showHint('直连失败，改用代理重试...');
        stage = 'hls-proxy';
        setupHls(proxyUrl(url));
        return;
      }
      if (stage === 'hls-proxy') {
        // HLS 直连与代理均失败：可能是"无 .m3u8 后缀但内容是 MP4"的源，回退原生播放
        showHint('HLS 解析失败，尝试原生播放...');
        stage = 'native-fallback';
        setupNativeFallback(videoEl, url, true, '直播流加载失败，可能该频道已失效，请尝试其他频道');
        return;
      }
      if (stage === 'native-direct') {
        showHint('直连失败，改用代理重试...');
        stage = 'native-proxy';
        setupNative(proxyUrl(url));
        return;
      }
      if (stage === 'native-proxy') {
        setError('该地址不是可播放的直播流（内容可能是文件或错误提示）');
      }
    });

    const engine = engineOf(url);
    if (engine === 'flv' && isIOS()) {
      // FLV 依赖 MSE，iOS Safari 没有 MSE 直播能力：明确告知，绝不承诺能播
      setLoading(false);
      setError('该频道为 FLV 直播，iOS 设备无法播放 FLV 格式，请切换其他频道');
    } else if (engine === 'hls') {
      stage = 'hls-direct';
      setupHls(url);
    } else if (engine === 'native') {
      stage = 'native-direct';
      setupNative(url);
    }
    // FLV（非 iOS）：在 player.ready 回调里挂 mpegts（需 tech 就绪）

    // 15s 内未起播则提示
    const startTimer = setTimeout(() => {
      if (!playbackStarted && !disposed && !destroyed) {
        setError('频道加载超时，可能该源已失效，请尝试其他频道');
      }
    }, 15000);

    return () => {
      disposed = true;
      clearTimeout(startTimer);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      cleanupEngines();
      volumeBoostRef.current?.dispose();
      volumeBoostRef.current = null;
      player.dispose();
      playerRef.current = null;
      videoElRef.current = null;
      destroyed = true;
    };
  }, [url, retryNonce, onPrevChannel, onNextChannel]);

  // —— 音量放大开关：播放中改设置即时生效，不必等重新起播 ——
  // 关闭走「单位增益直通」而不是拆链：createMediaElementSource 之后元素输出只走
  // 音频图，拆链会永久静音且无法恢复直连，所以只旁路增益与限幅。
  useEffect(() => {
    const player = playerRef.current;
    const video = videoElRef.current;
    if (!player || !video) return;
    if (volumeBoost) {
      volumeBoostRef.current = attachVolumeBoost(video) ?? volumeBoostRef.current;
      volumeBoostRef.current?.setBoost(true);
    } else {
      volumeBoostRef.current?.setBoost(false);
    }
  }, [volumeBoost]);

  return (
    <div className="relative w-full h-full">
      {/* Video.js 挂载容器（data-vjs-player 让播放器按容器尺寸填充） */}
      <div ref={containerRef} data-vjs-player className="w-full h-full" />
      {/* 起播前的品牌占位图 */}
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {/* LIVE 呼吸标识 */}
      {!error && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/60 px-2 py-1 rounded-full pointer-events-none">
          <span className="live-dot" />
          <span className="text-[10px] font-semibold text-white tracking-wider">LIVE</span>
        </div>
      )}
      {/* 换台 OSD：频道名（全屏内同样可见） */}
      {osdTitle && !error && (
        <div className="absolute top-3 left-3 flex items-center max-w-[70%] bg-black/60 px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          <span className="text-sm font-medium text-white truncate">{osdTitle}</span>
        </div>
      )}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
          <Spinner size="lg" tone="onDark" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm px-4 text-center">{error}</p>
          <button
            className="btn-ghost text-xs !bg-white/10 !text-white !border-white/20"
            onClick={() => {
              // 重建播放器实例即可，无需整页刷新
              setError('');
              setHint('');
              setRetryNonce((n) => n + 1);
            }}
          >
            重新加载
          </button>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
    </div>
  );
}
