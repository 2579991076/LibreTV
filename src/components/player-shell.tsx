'use client';

import { useEffect, useRef, useState } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { installVhsAdFilter, setVhsAdFilterEnabled } from '@/lib/vhs-ad-filter';
import { installIOSFullscreenOverride } from '@/lib/videojs-ios-fullscreen';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { attachVolumeBoost, type VolumeBoostHandle } from '@/lib/volume-boost';
import { formatTime } from '@/lib/utils';
import {
  findActiveSegment,
  findCrossedEnding,
  resolveSegments,
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  type ResolvedSegment,
  type SkipMark,
  type SkipSegment,
} from '@/lib/skip-marks';

/** 片段时间统一保留 1 位小数：与面板展示保持一致，避免浮点尾巴 */
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 播放器外壳：Video.js 8（VHS 内置）替代 ArtPlayer 5.2.3 + hls.js。
 * 保留：广告分片过滤（VHS xhr 包装器）、自动连播回调、进度回调、快捷键、
 * 移动端长按倍速、错误恢复、断点续播、跳过片段、上下集、画质上报。
 * 关键修复（相对 ArtPlayer）：
 * - iOS Safari 走 VHS 的原生 HLS（不经过 MSE），不再黑屏/转圈；
 * - 原生全屏（不再用 fullscreenWeb + CSS 旋转 90° 的 hack）；
 * - 控制栏隐藏走 Video.js inactivityTimeout，不再改全局 Artplayer.CONTROL_HIDE_TIME；
 * - 画质菜单读 VHS qualityLevels（桌面）；iOS 原生 HLS 下只有「自动」。
 *
 * 关键设计：Video.js 实例只在挂载时创建一次，换集（url 变化）只调
 * player.src() 切换源而不销毁重建，保留全屏/播放器状态。
 */

type VideoJsPlayer = ReturnType<typeof videojs>;

/** 地址 → Video.js src：.m3u8 或无明确后缀默认 HLS；mp4/webm/mov 走原生容器 */
function sourceTypeOf(url: string): { src: string; type: string } {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.mp4')) return { src: url, type: 'video/mp4' };
  if (lower.endsWith('.webm')) return { src: url, type: 'video/webm' };
  if (lower.endsWith('.mov')) return { src: url, type: 'video/quicktime' };
  if (lower.endsWith('.m4v')) return { src: url, type: 'video/mp4' };
  // 其它（含无后缀、带 token 的地址）默认按 HLS 处理，与旧版一致
  return { src: url, type: 'application/x-mpegURL' };
}

/**
 * 是否走系统原生 HLS（iOS/macOS Safari）：原生播放时清单由浏览器直接拉，
 * 不经过 VHS xhr，播放器侧的去广告（vhs-ad-filter）拦不住；这类浏览器去
 * 广告开着时改走代理拿清单，让服务端先把广告段删干净（分片仍直连）。
 * canPlayType 在 iOS/macOS Safari 上对 mpegurl 返回 probably/maybe，
 * 在 Chrome/Firefox 上返回空串。
 */
let nativeHlsCache: boolean | null = null;
function supportsNativeHls(): boolean {
  if (nativeHlsCache !== null) return nativeHlsCache;
  try {
    const v = document.createElement('video');
    nativeHlsCache = v.canPlayType('application/vnd.apple.mpegurl') !== '';
  } catch {
    nativeHlsCache = false;
  }
  return nativeHlsCache;
}

/** 从代理地址里反解出原始直连地址（stripAds 代理失败时的兜底用）；非代理地址原样返回 */
function originalDirectUrl(url: string): string {
  if (!url.startsWith('/api/proxy')) return url;
  try {
    const inner = new URL(url, window.location.origin).searchParams.get('url');
    return inner || url;
  } catch {
    return url;
  }
}

/** 画质菜单：VHS qualityLevels 的封装。iOS 原生 HLS 下 qualityLevels 为空，只显示「自动」。 */
let qualityComponentsRegistered = false;
function registerQualityComponents(): void {
  if (qualityComponentsRegistered) return;
  qualityComponentsRegistered = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MenuButtonBase = videojs.getComponent('MenuButton') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MenuItemBase = videojs.getComponent('MenuItem') as any;
    if (!MenuButtonBase || !MenuItemBase) return;

    class QualityMenuItem extends MenuItemBase {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(player: any, options: any) {
        super(player, options);
        this.qualityLabel_ = options.label;
        this.qualityLevel_ = options.level ?? null; // null = 自动（全部档位启用）
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleClick(_event: any): void {
        const player = this.player();
        const levels = player.qualityLevels?.();
        if (levels) {
          if (this.qualityLevel_ === null) {
            for (let i = 0; i < levels.length; i++) levels[i].enabled = true;
          } else {
            for (let i = 0; i < levels.length; i++) {
              levels[i].enabled = levels[i] === this.qualityLevel_;
            }
          }
        }
        // 刷新整组选中态
        const button = this.player()
          .controlBar?.getChild('QualityMenuButton') as { update?: () => void } | undefined;
        button?.update?.();
        super.handleClick(_event);
      }
    }

    class QualityMenuButton extends MenuButtonBase {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(player: any, options: any) {
        super(player, options);
        this.controlText('画质');
        const levels = player.qualityLevels?.();
        if (levels) {
          // 档位就绪/切换时重建菜单项
          levels.on('addqualitylevel', () => this.update());
          levels.on('change', () => this.update());
        }
        this.update();
      }
      buildCSSClass(): string {
        return `vjs-quality-menu-button ${super.buildCSSClass()}`;
      }
      createEl(): Element {
        const el = super.createEl();
        // 用文字按钮而非图标：画质档位（1080p/720p/自动）直接可读
        const btn = el.querySelector('.vjs-icon-placeholder');
        if (btn) {
          btn.textContent = '自动';
          (btn as HTMLElement).style.cssText =
            'display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#fff;';
        }
        return el;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createItems(): any[] {
        const player = this.player();
        const levels = player.qualityLevels?.();
        const items: unknown[] = [];
        // 「自动」永远在最前
        items.push(
          new QualityMenuItem(player, {
            label: '自动',
            level: null,
            selectable: true,
            selected: !levels || levels.selectedIndex === -1,
          })
        );
        if (levels) {
          // 高档位在前
          const sorted = Array.from({ length: levels.length }, (_, i) => levels[i]).sort(
            (a, b) => (b.height || 0) - (a.height || 0)
          );
          for (const level of sorted) {
            const h = level.height;
            if (typeof h !== 'number' || h <= 0) continue;
            items.push(
              new QualityMenuItem(player, {
                label: `${h}p`,
                level,
                selectable: true,
                selected: level.enabled && levels.selectedIndex !== -1,
              })
            );
          }
        }
        return items as never[];
      }
      update(): void {
        // 刷新按钮上的当前档位文字（自动 / 1080p / …）
        super.update();
        const player = this.player();
        const levels = player.qualityLevels?.();
        let label = '自动';
        if (levels && levels.selectedIndex >= 0) {
          const sel = levels[levels.selectedIndex];
          if (sel && typeof sel.height === 'number' && sel.height > 0) label = `${sel.height}p`;
        }
        const btn = this.el()?.querySelector('.vjs-icon-placeholder');
        if (btn) btn.textContent = label;
      }
    }

    // 注册时用 any：子类化 MenuButton 后静态方法签名与 Component 不完全一致
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (videojs as any).registerComponent('QualityMenuButton', QualityMenuButton);
  } catch {
    // 注册失败不影响播放：只是没有画质菜单
  }
}

/** 暴露给播放页的读取接口：「记录当前」需要比 5s 节流进度回调更精确的位置 */
export interface PlayerSkipApi {
  getCurrentTime(): number;
  getDuration(): number;
  /** 跳转到指定位置（「试跳」/标记片段起点用） */
  seek(seconds: number): void;
  /** 暂停播放：记录标记前先定格，避免点击到读取之间视频继续走 */
  pause(): void;
  /** 当前是否处于暂停状态 */
  isPaused(): boolean;
}

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 当前剧的跳过片段标记（父级按归一化剧名查好后传入，换集/换源不变） */
  skipMark?: SkipMark;
  /**
   * 自动跳过标记的片段：片头/中段跳到片段末尾，片尾（连续播放越过起点）结束本集。
   * 是否连播下一集仍由 autoplayNext 决定。
   */
  autoSkipSegments: boolean;
  /**
   * 音量放大（Web Audio 增益链）：默认 false。
   * 关闭时完全不接入音频链路；播放中改开关由 setBoost 走「直通/增益」切换。
   * iOS Safari 一律不挂（会破坏 AirPlay 与锁屏「正在播放」）。
   */
  volumeBoost: boolean;
  /**
   * 底部细进度条（默认 true）：控制栏收起后是否在画面底边常驻一条 3px 进度线。
   * 关闭后收起即完全隐藏。
   */
  miniProgressBar?: boolean;
  /** 中段两步态的起点：由页面层持有，面板与快捷键共用同一份状态 */
  pendingStart: number | null;
  /** 更新中段起点；null 表示取消或已消费 */
  onPendingStart: (start: number | null) => void;
  /** 播放器创建/销毁时回调，供播放页读取精确播放位置 */
  onPlayerApi?: (api: PlayerSkipApi | null) => void;
  /** 快捷键（Shift+I/O/S/E）记录片段时回调，由父级做校验与写入 */
  onRecordSegment?: (segment: SkipSegment) => void;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 实测画质（视频高度，像素）。
   * 单码率 m3u8 / 直链的分辨率只能等解码后才知道，播放一次后回写缓存，
   * 下次搜索同一部剧就能直接显示画质，不必再探测。
   */
  onQuality?: (height: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /** 控制条上的上一集 / 下一集：不在播放器里也能切集，省得回到页面按钮 */
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  hasPrevEpisode?: boolean;
  hasNextEpisode?: boolean;
}

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  skipMark,
  autoSkipSegments,
  volumeBoost,
  miniProgressBar = true,
  pendingStart,
  onPendingStart,
  onPlayerApi,
  onRecordSegment,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  onRequestSwitchSource,
  onPrevEpisode,
  onNextEpisode,
  hasPrevEpisode,
  hasNextEpisode,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<VideoJsPlayer | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const volumeBoostRef = useRef<VolumeBoostHandle | null>(null);
  const miniBarRef = useRef<HTMLDivElement | null>(null);
  const miniBarFillRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, skipMark, autoSkipSegments, volumeBoost, miniProgressBar,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的高度传出去 */
  const reportQuality = (height: number) => {
    if (height > 0) propsRef.current.onQuality?.(height);
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当视频真正开始渲染/有分片进入 buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建播放链路）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次
  const restoredRef = useRef(false);
  // 某些 HLS 源在清单解析时 duration 仍未就绪，延迟到媒体元数据可用后恢复
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // loadEpisode 可能改走代理形式，error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 跳过片段：每集已处理的片段（按 type:start 去重），换集时重置（见 loadEpisode）
  const handledSegmentsRef = useRef<Set<string>>(new Set());
  // 被「撤销」过的片段：本集不再自动跳（否则撤回到片段内会被立刻再跳走），但仍保留提示按钮
  const suppressedAutoRef = useRef<Set<string>>(new Set());
  // 上一次 timeupdate 的位置：用于区分「连续播放越过片尾」与「拖动进度条」
  const lastSampleRef = useRef(0);
  // 跳过按钮提示；用 ref 比较，避免 timeupdate 每 250ms 触发重渲染
  const [skipPrompt, setSkipPrompt] = useState<ResolvedSegment | null>(null);
  const skipPromptRef = useRef<ResolvedSegment | null>(null);
  // 刚跳过的片段：给一个撤销窗口，误标导致跳掉正片时不必手动拖回去
  const [undoSkip, setUndoSkip] = useState<{ from: number; segment: ResolvedSegment } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 恢复后待 seek 的位置（源重载会把 currentTime 清零，重载后按此seek回去）
  const pendingSeekRef = useRef<number | null>(null);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    // 原生 HLS（iOS/macOS Safari）：播放器不读预取缓存（VHS 不走、原生播放器
    // 自己拉分片），预取等于重复下载，跳过。
    if (supportsNativeHls()) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done' && p.nextUrl && p.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: p.nextUrl,
            currentTime: 0,
            episodeKey: p.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  };

  /** 切换提示状态；值相同直接返回，避免 timeupdate 高频 setState */
  const updateSkipPrompt = (next: ResolvedSegment | null) => {
    const prev = skipPromptRef.current;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.type === next.type &&
        prev.start === next.start &&
        prev.end === next.end);
    if (same) return;
    skipPromptRef.current = next;
    setSkipPrompt(next);
  };

  /** 片段去重键：按类型 + 起点，同一集内每段只处理一次 */
  const segmentKey = (s: ResolvedSegment) => `${s.type}:${s.start}`;

  /** 进度条区间可视化：在 Video.js 进度条轨道叠加半透明色带（颜色与面板图例共用 SEGMENT_COLORS） */
  const renderSkipMarks = () => {
    const player = playerRef.current;
    if (!player) return;
    const holder = player.el()?.querySelector('.vjs-progress-holder') as HTMLElement | null;
    if (!holder) return;
    holder.querySelectorAll('[data-skip-segment]').forEach((el: Element) => el.remove());
    const duration = (player.duration() ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const segments = resolveSegments(propsRef.current.skipMark, duration);
    for (const seg of segments) {
      const el = document.createElement('div');
      el.dataset.skipSegment = '1';
      el.title = `跳过${SEGMENT_LABELS[seg.type]}`;
      const left = (seg.start / duration) * 100;
      const width = Math.max(0.4, ((seg.end - seg.start) / duration) * 100);
      el.style.cssText = `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${SEGMENT_COLORS[seg.type]};pointer-events:none;z-index:1;`;
      holder.appendChild(el);
    }
  };

  /** 底部细进度条：控制栏收起且设置开启时显示。宽度走 ref 直接改样式，避免 timeupdate 重渲染。 */
  const updateMiniBar = () => {
    const player = playerRef.current;
    const bar = miniBarRef.current;
    const fill = miniBarFillRef.current;
    if (!player || !bar || !fill) return;
    const duration = (player.duration() ?? 0);
    const current = (player.currentTime() ?? 0);
    const pct =
      Number.isFinite(duration) && duration > 0
        ? Math.min(100, Math.max(0, (current / duration) * 100))
        : 0;
    fill.style.width = `${pct}%`;
    const visible = propsRef.current.miniProgressBar && !player.userActive();
    bar.style.opacity = visible ? '1' : '0';
  };

  /**
   * 跳到片段末尾并续跑预取；同步 lastSampleRef，避免下一拍被误判为「连续越过片尾」。
   * 返回是否成功：媒体未就绪导致赋值失败时返回 false，调用方不置已处理标记，
   * 下一次 timeupdate 会重新判定（保证「可重试」）。
   */
  const skipTo = (seconds: number): boolean => {
    const player = playerRef.current;
    if (!player || !Number.isFinite(seconds) || seconds < 0) return false;
    try {
      player.currentTime(seconds);
    } catch {
      return false;
    }
    lastSampleRef.current = seconds;
    ensurePrefetch(currentMediaUrlRef.current, seconds);
    return true;
  };

  /** 记录一次跳过（跳转前的位置）：给 12s 撤销窗口，误标导致跳掉正片时不用手动拖回去 */
  const rememberSkip = (from: number, segment: ResolvedSegment) => {
    setUndoSkip({ from, segment });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoSkip(null), 12_000);
  };

  const undoLastSkip = () => {
    const last = undoSkip;
    if (!last) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    // 撤销后把片段从「已处理」移除（按钮会重新出现），同时本集不再自动跳它：
    // 否则回到片段内会被下一次 timeupdate 立刻再跳走，形成"撤销→又被跳过"的死循环
    handledSegmentsRef.current.delete(segmentKey(last.segment));
    suppressedAutoRef.current.add(segmentKey(last.segment));
    skipTo(last.from);
    setUndoSkip(null);
    showHint('已撤回跳过');
  };

  /**
   * 跳过片尾：与自然播完共用 onEnded 链路（清进度 + 依 autoplayNext 连播下一集）。
   * endedRef 置 true 同时阻止 ended 重复回调，也避免卸载时把片尾进度回写。
   */
  const finishBySkip = (ending?: ResolvedSegment) => {
    const player = playerRef.current;
    if (ending) handledSegmentsRef.current.add(segmentKey(ending));
    endedRef.current = true;
    updateSkipPrompt(null);
    setUndoSkip(null);
    try {
      player?.pause();
    } catch {
      /* 忽略 */
    }
    showHint('已跳过片尾');
    propsRef.current.onEnded?.();
  };

  /**
   * Video.js 错误 → 恢复策略的类型/详情映射。
   * Video.js 的 MediaError 只有 code（1 取消 / 2 网络 / 3 解码 / 4 源不支持）；
   * VHS（MSE）内部失败时也会走到这里。映射目标是 playback-recovery 的
   * 'networkError' | 'mediaError' + 细节字符串（复用 hls.js 的语义，
   * 这样代理回退/换源的既有判定逻辑不用改）。
   */
  const mapVideoJsError = (player: VideoJsPlayer): { type: string; details: string } => {
    const err = player.error();
    const code = (err as { code?: number } | null)?.code ?? 0;
    const message = (err as { message?: string } | null)?.message ?? '';
    // 源不支持：常是地址本身有问题（404/HTML 错误页/错误容器），按清单级网络错误走代理重试
    if (code === 4) return { type: 'networkError', details: 'manifestLoadError' };
    if (code === 3) return { type: 'mediaError', details: 'mediaError' };
    if (code === 2) {
      // 起播前失败多为清单拉不到，播放中失败多为分片拉不到；都属于网络错误
      return {
        type: 'networkError',
        details: playbackStartedRef.current ? 'fragLoadError' : 'manifestLoadError',
      };
    }
    // 其它（含 VHS 内部错误）：看 message 里的关键字，默认按网络错误处理
    if (/codec|decode|media/i.test(message)) return { type: 'mediaError', details: 'mediaError' };
    return { type: 'networkError', details: 'fragLoadError' };
  };

  /** 重载当前源（恢复用）：保留当前位置，loadedmetadata 后 seek 回去再播放。 */
  const reloadSource = (mediaUrl: string) => {
    const player = playerRef.current;
    if (!player) return;
    const pos = (player.currentTime() ?? 0);
    if (Number.isFinite(pos) && pos > 0) pendingSeekRef.current = pos;
    player.src(sourceTypeOf(mediaUrl));
    // 恢复后继续播放（之前在播才继续；暂停中不主动起播）
    player.play()?.catch(() => {});
  };

  /**
   * 初始化/切换播放源。
   * 注意：不销毁 Video.js，只换 src，从而保留全屏等播放器状态。
   * 代理兜底（直连致命网络错误时改走 /api/proxy）不在这里，由 error 事件的
   * 恢复策略决定后显式传入代理地址再调 setupSource。
   */
  const setupSource = (mediaUrl: string, opts?: { forceDirect?: boolean }) => {
    const player = playerRef.current;
    if (!player) return;
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    // 原生 HLS + 去广告开着：清单走代理删广告（分片仍直连）；已是代理地址不重复包。
    // 只包 HLS 清单：mp4/webm 等直连容器不走代理（否则整段视频数据都过 Netlify，
    // 又慢又烧额度），去广告对它们也没有意义。
    let effectiveUrl = mediaUrl;
    if (
      !opts?.forceDirect &&
      propsRef.current.adFilter &&
      !mediaUrl.startsWith('/api/proxy') &&
      sourceTypeOf(mediaUrl).type === 'application/x-mpegURL' &&
      supportsNativeHls()
    ) {
      effectiveUrl = `/api/proxy?url=${encodeURIComponent(mediaUrl)}&stripAds=1`;
    }
    currentMediaUrlRef.current = effectiveUrl;
    // 换源时重置恢复策略（直连/代理两级共享计数由 loadEpisode 在集间重置）
    if (!recoveryRef.current) recoveryRef.current = new PlaybackRecovery();

    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (restoredRef.current || restoreInFlight) return;
      const duration = (player.duration() ?? 0) || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;
      restoreInFlight = true;
      try {
        const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
        const currentDuration = (player.duration() ?? 0) || duration;
        let prefetchAnchor = (player.currentTime() ?? 0);
        if (saved > 10 && Number.isFinite(currentDuration) && saved < currentDuration - 2) {
          player.currentTime(saved);
          prefetchAnchor = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
        restoredRef.current = true;
        restoreCleanupRef.current?.();
        restoreCleanupRef.current = null;
        ensurePrefetch(effectiveUrl, prefetchAnchor);
        // 快速起播：源就绪后立即播放，边播边缓冲，不等预取
        player.play()?.catch(() => {});
      } catch {
        // IndexedDB 读取失败时不阻塞播放，后续事件仍可再次尝试恢复。
      } finally {
        restoreInFlight = false;
      }
    };

    const restoreEvents = ['loadedmetadata', 'durationchange', 'canplay'] as const;
    const onRestoreEvent = () => { void restoreAndStart(); };
    restoreEvents.forEach((event) => player.on(event, onRestoreEvent));
    restoreCleanupRef.current = () => {
      restoreEvents.forEach((event) => player.off(event, onRestoreEvent));
    };

    // 恢复后待 seek：源重载会清零 currentTime，loadedmetadata 到达后 seek 回去
    player.one('loadedmetadata', () => {
      const pending = pendingSeekRef.current;
      pendingSeekRef.current = null;
      const duration = (player.duration() ?? 0);
      if (
        pending !== null &&
        Number.isFinite(pending) &&
        pending > 0 &&
        Number.isFinite(duration) &&
        pending < duration - 2
      ) {
        try {
          player.currentTime(pending);
        } catch {
          /* 忽略 */
        }
      }
    });

    player.src(sourceTypeOf(effectiveUrl));
    // 快速起播：不等清单解析完，先把播放请求发出（autoplay 由 Video.js 处理）
    player.play()?.catch(() => {});
  };

  /** 换集：重置每集状态并切换到新源（不重建播放器）。 */
  const loadEpisode = (targetUrl: string) => {
    if (!targetUrl) return;
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    lastPrefetchEnsureRef.current = 0;
    pendingSeekRef.current = null;
    // 跳过片段按集重置：上一集已处理过不意味新一集也处理过
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;
    endedRef.current = false;
    updateSkipPrompt(null);
    setUndoSkip(null);
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
    const player = playerRef.current;
    if (!player) return;
    // 亮度是每集独立的手感：换集时复位到正常，避免上一集调暗留在新集上
    const video = videoElRef.current;
    if (video) video.style.filter = '';
    brightnessRef.current = 1;
    setupSource(targetUrl);
  };

  // —— 手势状态（双击/滑动/长按互斥的状态机） ——
  // 亮度：通过 CSS filter 调整 video 元素；换集时复位（见 loadEpisode）
  const brightnessRef = useRef(1);
  const gestureRef = useRef<{
    mode: 'none' | 'tap' | 'swipe-h' | 'swipe-v' | 'longpress';
    startX: number;
    startY: number;
    startTime: number;
    startCurrentTime: number;
    startVolume: number;
    volumeSide: boolean; // 垂直滑动：右半屏=音量，左半屏=亮度
    rotated: boolean; // iOS 竖屏全屏时播放器被 CSS 旋转 90°，手势坐标需换算
    longPressTimer: ReturnType<typeof setTimeout> | null;
    longPressActive: boolean;
    longPressOriginalRate: number;
    lastTapAt: number;
    lastTapX: number;
    lastTapY: number;
    singleTapTimer: ReturnType<typeof setTimeout> | null;
  }>({
    mode: 'none',
    startX: 0,
    startY: 0,
    startTime: 0,
    startCurrentTime: 0,
    startVolume: 0,
    volumeSide: false,
    rotated: false,
    longPressTimer: null,
    longPressActive: false,
    longPressOriginalRate: 1,
    lastTapAt: 0,
    lastTapX: 0,
    lastTapY: 0,
    singleTapTimer: null,
  });

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;

    // 广告过滤装到 VHS 全局 xhr（幂等，必须在建播放器之前）
    installVhsAdFilter();
    setVhsAdFilterEnabled(propsRef.current.adFilter);
    // 画质菜单组件注册一次
    registerQualityComponents();

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;

    let lastSave = 0;
    let disposed = false;

    // <video> 元素由本 effect 创建并挂进容器，销毁时随播放器一起移除，
    // React 不直接持有它，避免 dispose 时 DOM 归属冲突。
    const videoEl = document.createElement('video');
    videoEl.className = 'video-js vjs-default-skin';
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('preload', 'auto');
    // 注意：不设 crossOrigin='anonymous'——iOS 原生 HLS 下，源站若无 CORS 头，
    // 设 crossOrigin 会直接导致播放失败；截图功能改为失败时提示。
    containerRef.current.appendChild(videoEl);
    videoElRef.current = videoEl;

    const player = videojs(videoEl, {
      autoplay: true,
      controls: true,
      preload: 'auto',
      fluid: false,
      fill: true,
      volume: 0.8,
      playsinline: true,
      // 快速起播：VHS 默认即开即播、边播边缓冲；不设大的初始缓冲。
      // 原生全屏（iOS 上是系统全屏），不再用 fullscreenWeb + CSS 旋转。
      // 控制栏隐藏走 inactivityTimeout；触屏点按会把 userActive 置 true 重新显示。
      inactivityTimeout: 3000,
      language: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
      bigPlayButton: false,
      errorDisplay: false,
      loadingSpinner: false,
      playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2, 3],
      // 点按/双击行为由本组件的手势层接管：Video.js 默认的点按切换播放、
      // 双击切换全屏会和双击快进/滑动手势冲突。
      userActions: { click: false, doubleClick: false },
      controlBar: {
        remainingTimeDisplay: false,
        // 画质菜单放在倍速旁边；其余用默认顺序
      },
      html5: {
        vhs: {
          // iOS Safari 默认走原生 HLS（overrideNative=false）；桌面走 MSE。
          // 缓冲保持默认桌面向尺寸，不再沿用 hls.js 时期 120s 的大缓冲，
          // 避免 iOS ManagedMediaSource 下的卡顿/错误源。
          withCredentials: false,
        },
      },
    });
    playerRef.current = player;

    // iOS 全屏默认横屏（竖屏走网页全屏 + CSS 旋转 90°，横屏走原生全屏），
    // 与直播 live-player 共用同一份逻辑（见 lib/videojs-ios-fullscreen）。
    installIOSFullscreenOverride(player, videoEl);

    // —— 控制条自定义按钮 ——
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controlBar = player.getChild('controlBar') as any;
    // 插入位置：画质/附加按钮放在全屏按钮之前（控制栏默认最后一项是全屏）
    const beforeFullscreenIndex = (): number => {
      try {
        const kids = controlBar?.children?.() as { name?: () => string }[] | undefined;
        if (!kids) return 0;
        const idx = kids.findIndex((c) => c?.name?.() === 'fullscreenToggle');
        return idx >= 0 ? idx : kids.length;
      } catch {
        return 0;
      }
    };
    const channelBtnSvg = (path: string) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="display:block;margin:auto"><path d="${path}"/></svg>`;
    player.ready(() => {
      if (disposed) return;
      // 上/下集放在播放键右侧（换集是看剧最高频的动作）
      let btnIndex = 1;
      const addEpisodeButton = (controlText: string, svgPath: string, onClick: () => void) => {
        const btn = controlBar.addChild(
          'button',
          { controlText, clickHandler: () => onClick() },
          btnIndex++
        );
        const icon = btn.el().querySelector('.vjs-icon-placeholder');
        if (icon) (icon as HTMLElement).innerHTML = channelBtnSvg(svgPath);
        return btn;
      };
      if (propsRef.current.onPrevEpisode) {
        const prevBtn = addEpisodeButton('上一集 (Alt+←)', 'M11 19l-7-7 7-7m8 14l-7-7 7-7', () => {
          if (propsRef.current.hasPrevEpisode) propsRef.current.onPrevEpisode?.();
        });
        (prevBtn as { el: () => HTMLElement }).el().dataset.episodeBtn = 'prev';
      }
      if (propsRef.current.onNextEpisode) {
        const nextBtn = addEpisodeButton('下一集 (Alt+→)', 'M13 5l7 7-7 7M5 5l7 7-7 7', () => {
          if (propsRef.current.hasNextEpisode) propsRef.current.onNextEpisode?.();
        });
        (nextBtn as { el: () => HTMLElement }).el().dataset.episodeBtn = 'next';
      }
      // 画质菜单（倍速按钮之后）
      try {
        controlBar.addChild('QualityMenuButton', {}, beforeFullscreenIndex());
      } catch {
        /* 画质菜单失败不影响播放 */
      }
      // AirPlay：仅 iOS/Safari 有 webkitShowPlaybackTargetPicker 时显示
      try {
        const v = player.tech().el() as HTMLVideoElement | null;
        if (v && 'webkitShowPlaybackTargetPicker' in v) {
          const airBtn = controlBar.addChild(
            'button',
            {
              controlText: 'AirPlay',
              clickHandler: () => {
                try {
                  (v as unknown as { webkitShowPlaybackTargetPicker: () => void }).webkitShowPlaybackTargetPicker();
                } catch {
                  /* 忽略 */
                }
              },
            },
            beforeFullscreenIndex()
          );
          const icon = airBtn.el().querySelector('.vjs-icon-placeholder');
          if (icon) {
            (icon as HTMLElement).innerHTML =
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="display:block;margin:auto"><rect x="2" y="5" width="20" height="12" rx="2"/><path d="M12 21l-3-3h6l-3 3z"/></svg>';
          }
        }
      } catch {
        /* 忽略 */
      }
      // 截图：canvas 抓帧（跨域源会因画布污染失败，届时提示，不阻塞播放）
      try {
        const shotBtn = controlBar.addChild(
          'button',
          {
            controlText: '截图',
            clickHandler: () => {
              const v = player.tech().el() as HTMLVideoElement | null;
              if (!v || v.readyState < 2 || !v.videoWidth) {
                showHint('当前画面无法截图');
                return;
              }
              try {
                const canvas = document.createElement('canvas');
                canvas.width = v.videoWidth;
                canvas.height = v.videoHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('no ctx');
                ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                  if (!blob) {
                    showHint('截图失败（该源跨域不支持截图）');
                    return;
                  }
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `${(propsRef.current.title || '截图').replace(/[\\/:*?"<>|]/g, '_')}_${formatTime((player.currentTime() ?? 0) || 0).replace(/:/g, '')}.png`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                  showHint('已保存截图');
                }, 'image/png');
              } catch {
                showHint('截图失败（该源跨域不支持截图）');
              }
            },
          },
          beforeFullscreenIndex()
        );
        const icon = shotBtn.el().querySelector('.vjs-icon-placeholder');
        if (icon) {
          (icon as HTMLElement).innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="display:block;margin:auto"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
        }
      } catch {
        /* 忽略 */
      }
      updateMiniBar();
      renderSkipMarks();
      syncEpisodeButtons();
    });

    const syncEpisodeButtons = () => {
      const bar = player.el()?.querySelector('.vjs-control-bar') as HTMLElement | null;
      if (!bar) return;
      const prev = bar.querySelector<HTMLElement>('[data-episode-btn="prev"]');
      const next = bar.querySelector<HTMLElement>('[data-episode-btn="next"]');
      if (prev) {
        prev.style.opacity = propsRef.current.hasPrevEpisode ? '1' : '0.4';
        prev.style.pointerEvents = propsRef.current.hasPrevEpisode ? 'auto' : 'none';
      }
      if (next) {
        next.style.opacity = propsRef.current.hasNextEpisode ? '1' : '0.4';
        next.style.pointerEvents = propsRef.current.hasNextEpisode ? 'auto' : 'none';
      }
    };
    // 上下集禁用态变化时同步（该 effect 外的 useEffect 也会调这里）
    (player as unknown as { __syncEpisodeButtons?: () => void }).__syncEpisodeButtons =
      syncEpisodeButtons;

    // 音量放大：起播后（src 已就绪）才挂 Web Audio 增益图，避免空 src / CORS 误判。
    // 默认关闭（设置项 volumeBoost）：不接入时完全不碰音频链路。
    // iOS 上 attachVolumeBoost 直接返回 null（AirPlay/锁屏原因，见 volume-boost.ts）。
    player.on('playing', () => {
      if (!propsRef.current.volumeBoost) return;
      if (!volumeBoostRef.current) {
        volumeBoostRef.current = attachVolumeBoost(videoEl);
      }
    });

    // 底部细进度条：控制栏显隐变化时同步
    player.on('useractive', updateMiniBar);
    player.on('userinactive', updateMiniBar);

    // 进度条区间可视化：初始渲染一次，换集 duration 变化时重绘
    player.on('loadedmetadata', renderSkipMarks);
    player.on('durationchange', renderSkipMarks);

    /**
     * 倍速跨集保持（issue #955 的 Video.js 版）。
     * 换源会让媒体元素重新走一遍 load 算法，而该算法只动一个播放属性：
     * `playbackRate = defaultPlaybackRate`。所以只要让 defaultPlaybackRate 始终
     * 等于用户选的倍速，这次「归位」就变成空操作。归位时新值必然等于
     * defaultPlaybackRate，跳过即可（否则无差别同步会把默认值自己写成 1）。
     */
    player.on('ratechange', () => {
      const video = videoEl;
      if (video && video.playbackRate !== video.defaultPlaybackRate) {
        video.defaultPlaybackRate = video.playbackRate;
      }
    });

    // 播放页「记录当前」需要精确时间：不能依赖 5s 节流的 onTimeUpdate
    propsRef.current.onPlayerApi?.({
      getCurrentTime: () => {
        const current = playerRef.current?.currentTime();
        return typeof current === 'number' && Number.isFinite(current) ? current : 0;
      },
      getDuration: () => {
        const duration = playerRef.current?.duration();
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
      },
      seek: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        try {
          playerRef.current?.currentTime(seconds);
        } catch {
          /* 忽略 */
        }
      },
      pause: () => {
        try {
          playerRef.current?.pause();
        } catch {
          /* 忽略 */
        }
      },
      isPaused: () => playerRef.current?.paused() ?? true,
    });

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 resize / canplay / playing
     * 各补一次机会，不能只赌单一事件时机。
     * 另外：多码率源的档位上限走 VHS qualityLevels 上报（addqualitylevel 时）。
     */
    const reportVideoHeight = () => {
      const height = videoEl.videoHeight;
      if (typeof height === 'number' && height > 0) reportQuality(height);
    };
    player.on('loadedmetadata', reportVideoHeight);
    player.on('canplay', reportVideoHeight);
    videoEl.addEventListener('resize', reportVideoHeight);

    // VHS 档位就绪时上报最大档位高度（桌面 MSE；原生 HLS 的 qualityLevels 为空，跳过）
    const reportVhsLevels = () => {
      try {
        const levels = (player as unknown as { qualityLevels?: () => { length: number; [i: number]: { height?: number } } }).qualityLevels?.();
        if (!levels || levels.length === 0) return;
        const heights: number[] = [];
        for (let i = 0; i < levels.length; i++) {
          const h = levels[i]?.height;
          if (typeof h === 'number' && h > 0) heights.push(h);
        }
        if (heights.length > 0) reportQuality(Math.max(...heights));
      } catch {
        /* 忽略 */
      }
    };
    // 档位是动态出现的：每次换源后重新监听
    const wireQualityLevels = () => {
      try {
        const levels = (player as unknown as { qualityLevels?: () => { on?: (e: string, cb: () => void) => void } }).qualityLevels?.();
        levels?.on?.('addqualitylevel', reportVhsLevels);
      } catch {
        /* 忽略 */
      }
    };
    player.on('loadedmetadata', wireQualityLevels);

    player.on('playing', () => {
      playbackStartedRef.current = true;
      setShowPoster(false);
      // 仅在媒体真正恢复后清错误遮罩：否则「视频轨挂了、音频轨先播出来」时
      // 会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
      reportVideoHeight();
    });
    player.on('error', () => {
      if (disposed) return;
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误：重载一次自愈，而不是直接钉死错误遮罩
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        reloadSource(currentMediaUrlRef.current);
        return;
      }
      // 致命错误 → 恢复策略决策
      const recovery = recoveryRef.current;
      if (!recovery) {
        setError('视频播放失败，请尝试其他视频源');
        return;
      }
      const { type, details } = mapVideoJsError(player);
      const decision = recovery.onFatal(type, details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // stripAds 代理清单失败 → 兜底回直连（有广告但能播），不再重复包代理
          if (
            details === 'manifestLoadError' &&
            currentMediaUrlRef.current.startsWith('/api/proxy') &&
            currentMediaUrlRef.current.includes('stripAds=1')
          ) {
            const direct = originalDirectUrl(currentMediaUrlRef.current);
            if (direct !== currentMediaUrlRef.current) {
              showHint('代理去广告失败，改用直连播放...');
              setupSource(direct, { forceDirect: true });
              return;
            }
          }
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            details === 'manifestLoadError' &&
            !currentMediaUrlRef.current.startsWith('/api/proxy')
          ) {
            showHint('直连失败，改用代理重试...');
            setupSource(`/api/proxy?url=${encodeURIComponent(currentMediaUrlRef.current)}`);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => {
            if (disposed) return;
            reloadSource(currentMediaUrlRef.current);
          });
          break;
        }
        case 'recover-media': {
          // VHS 没有 hls.js 的 recoverMediaError / swapAudioCodec：
          // 等价操作是重载当前源（重建 MSE/媒体管线），恢复后回到出错前位置。
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          reloadSource(currentMediaUrlRef.current);
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(type, details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
    player.on('timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.((player.currentTime() ?? 0), (player.duration() ?? 0));
      }
      updateMiniBar();
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        ensurePrefetch(currentMediaUrlRef.current, (player.currentTime() ?? 0));
      }

      // —— 跳过片段判定 ——
      const p = propsRef.current;
      const current = (player.currentTime() ?? 0);
      const duration = (player.duration() ?? 0);
      const previous = lastSampleRef.current;
      lastSampleRef.current = current;
      const segments = resolveSegments(p.skipMark, duration);

      // 结尾片段：只认连续播放越过起点；拖动进度条、刚写入标记、进度恢复造成的大跳变
      // 都不自动结束，只显示按钮由用户决定。
      if (
        p.autoSkipSegments &&
        restoredRef.current &&
        playbackStartedRef.current &&
        findCrossedEnding(segments, previous, current)
      ) {
        const ending = segments.find(
          (s) => s.type === 'ending' && previous < s.start && current >= s.start
        );
        finishBySkip(ending);
        return;
      }

      // 片头/中段片段：命中则自动跳到末尾（同一类操作，共用 autoSkipSegments 开关）；
      // 已处理过的片段本集不再反复拉扯。
      const active = findActiveSegment(segments, current);
      if (
        active &&
        active.type !== 'ending' &&
        p.autoSkipSegments &&
        !handledSegmentsRef.current.has(segmentKey(active)) &&
        !suppressedAutoRef.current.has(segmentKey(active)) &&
        restoredRef.current &&
        playbackStartedRef.current
      ) {
        if (skipTo(active.end)) {
          handledSegmentsRef.current.add(segmentKey(active));
          rememberSkip(current, active);
          showHint(active.type === 'opening' ? '已跳过片头' : '已跳过中段');
        }
      }

      // 按钮提示：当前落在某个未处理片段内（结尾片段显示「跳过片尾」）
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    player.on('seeked', () => {
      ensurePrefetch(currentMediaUrlRef.current, (player.currentTime() ?? 0));
      // seek 是用户主动行为：拉平采样基准，避免下一拍被误判为「连续越过片尾」。
      const current = (player.currentTime() ?? 0);
      lastSampleRef.current = current;
      const segments = resolveSegments(propsRef.current.skipMark, (player.duration() ?? 0));
      const active = findActiveSegment(segments, current);
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    player.on('pause', () => {
      // 跳过片尾会主动 pause：此时已按「看完」处理，不能再把片尾位置写回进度
      if (!endedRef.current) propsRef.current.onPause?.((player.currentTime() ?? 0), (player.duration() ?? 0));
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, (player.currentTime() ?? 0), 0);
    });
    player.on('waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
    });
    player.on('playing', () => {
      getVideoPrefetcher().setThrottled(false);
    });
    player.on('ended', () => {
      // finishBySkip 已经手动走过结束链路：这里不能重复触发 onEnded
      if (endedRef.current) return;
      endedRef.current = true;
      updateSkipPrompt(null);
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键 ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
      const current = playerRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if ((current.currentTime() ?? 0) > 5) { current.currentTime((current.currentTime() ?? 0) - 5); showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if ((current.duration() ?? 0) - (current.currentTime() ?? 0) > 5) { current.currentTime((current.currentTime() ?? 0) + 5); showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if ((current.volume() ?? 0) < 1) { current.volume(Math.min(1, (current.volume() ?? 0) + 0.1)); showHint(`音量 ${Math.round((current.volume() ?? 0) * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if ((current.volume() ?? 0) > 0) { current.volume(Math.max(0, (current.volume() ?? 0) - 0.1)); showHint(`音量 ${Math.round((current.volume() ?? 0) * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          if (current.paused()) { void current.play(); } else { current.pause(); }
          showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          if (current.isFullscreen()) { current.exitFullscreen(); } else { void current.requestFullscreen(); }
          e.preventDefault();
          break;
        // 标记类快捷键一律要求 Shift：这几键会直接写盘并影响整部剧，
        // 单键太容易误触（误记片头 = 之后每集都被跳过一大段）
        case 'i': case 'I':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'opening',
            start: 0,
            end: round1((current.currentTime() ?? 0)),
          });
          e.preventDefault();
          break;
        case 'o': case 'O':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'ending',
            start: round1((current.currentTime() ?? 0)),
            end: -1,
          });
          e.preventDefault();
          break;
        case 's': case 'S':
          if (!e.shiftKey) break;
          propsRef.current.onPendingStart(round1((current.currentTime() ?? 0)));
          showHint('片段起点已记录，播放到终点后按 Shift+E');
          e.preventDefault();
          break;
        case 'e': case 'E': {
          if (!e.shiftKey) break;
          const start = propsRef.current.pendingStart;
          if (start === null) {
            showHint('请先按 Shift+S 记录片段起点');
          } else {
            const end = round1((current.currentTime() ?? 0));
            propsRef.current.onPendingStart(null);
            propsRef.current.onRecordSegment?.({ type: 'middle', start, end });
          }
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 手势（item 1）：双击快进/快退 10s、滑动调音量/亮度/进度、长按 3 倍速 ——
    // 与 Video.js 的 userActions.click/doubleClick=false 配合：点按行为完全由这里接管。
    // 控制栏/设置面板上的触摸不触发手势；手势只在视频区域上生效。
    const el = containerRef.current;
    const isOnControl = (target: EventTarget | null) =>
      (target as HTMLElement | null)?.closest?.(
        '.vjs-control-bar, .vjs-modal-dialog, .vjs-menu, .vjs-big-play-button, button'
      ) != null;
    const clearGestureTimers = () => {
      const g = gestureRef.current;
      if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
      if (g.singleTapTimer) { clearTimeout(g.singleTapTimer); g.singleTapTimer = null; }
    };
    const onTouchStart = (e: TouchEvent) => {
      if (isOnControl(e.target)) return;
      const g = gestureRef.current;
      const t = e.changedTouches[0];
      if (!t) return;
      // 多指触摸不参与手势（第二指不重置第一指的状态）
      if (g.mode !== 'none' && g.mode !== 'tap') return;
      g.mode = 'tap';
      g.startX = t.clientX;
      g.startY = t.clientY;
      g.startTime = Date.now();
      g.startCurrentTime = (player.currentTime() ?? 0);
      g.startVolume = (player.volume() ?? 0);
      const rect = el?.getBoundingClientRect();
      // 旋转全屏（iOS 竖屏全屏被 CSS 旋转 90°）：用户看到的“左右”是视口上下，
      // “上下”是视口左右；滑动与双击位置都要按旋转后的方向换算。
      g.rotated =
        player.isFullWindow && window.matchMedia('(orientation: portrait)').matches;
      g.volumeSide = rect
        ? g.rotated
          ? t.clientY > rect.top + rect.height / 2
          : t.clientX > rect.left + rect.width / 2
        : true;
      g.longPressActive = false;
      // 长按 3 倍速：仅播放中生效；500ms 后触发
      if (!player.paused()) {
        g.longPressOriginalRate = videoEl.playbackRate;
        g.longPressTimer = setTimeout(() => {
          if (player.paused() || disposed) return;
          videoEl.playbackRate = 3.0;
          g.longPressActive = true;
          g.mode = 'longpress';
          showHint('3 倍速');
        }, 500);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      const g = gestureRef.current;
      if (g.mode === 'none') return;
      if (isOnControl(e.target)) return;
      const t = e.changedTouches[0];
      if (!t) return;
      // 旋转全屏时换算坐标：用户感知的横向 = 视口纵向，纵向 = 视口横向取反
      const rawDx = t.clientX - g.startX;
      const rawDy = t.clientY - g.startY;
      const dx = g.rotated ? rawDy : rawDx;
      const dy = g.rotated ? -rawDx : rawDy;
      if (g.longPressActive) {
        // 长按中移动只阻止页面滚动，不触发滑动
        e.preventDefault();
        return;
      }
      // 未分类前：位移超过阈值才认定为滑动（避免轻微抖动打断点按/长按）
      if (g.mode === 'tap' && Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      if (g.mode === 'tap') {
        // 划动即取消长按与待落定的单击
        if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
        if (g.singleTapTimer) { clearTimeout(g.singleTapTimer); g.singleTapTimer = null; }
        g.mode = Math.abs(dx) > Math.abs(dy) ? 'swipe-h' : 'swipe-v';
      }
      if (g.mode === 'swipe-h') {
        // 横向滑动：全幅 ≈ 60s，实时跟手 seek（旋转时以包围盒高为视频宽）
        const rect = el?.getBoundingClientRect();
        const width = (g.rotated ? rect?.height : rect?.width) || 400;
        const delta = (dx / width) * 60;
        const duration = (player.duration() ?? 0);
        const target = Math.min(
          Math.max(0, g.startCurrentTime + delta),
          Number.isFinite(duration) ? duration : g.startCurrentTime + delta
        );
        player.currentTime(target);
        showHint(`${formatTime(target)} / ${formatTime(duration || 0)}`);
        e.preventDefault();
      } else if (g.mode === 'swipe-v') {
        // 纵向滑动：右半屏=音量，左半屏=亮度；全幅 ≈ 全量程（旋转时以包围盒宽为视频高）
        const rect = el?.getBoundingClientRect();
        const height = (g.rotated ? rect?.width : rect?.height) || 300;
        const ratio = -dy / height; // 上滑为正
        if (g.volumeSide) {
          const vol = Math.min(1, Math.max(0, g.startVolume + ratio));
          player.volume(vol);
          showHint(`音量 ${Math.round(vol * 100)}%`);
        } else {
          const b = Math.min(1.5, Math.max(0.4, 1 + ratio));
          brightnessRef.current = b;
          videoEl.style.filter = b === 1 ? '' : `brightness(${b.toFixed(2)})`;
          showHint(`亮度 ${Math.round(b * 100)}%`);
        }
        e.preventDefault();
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      const g = gestureRef.current;
      if (g.mode === 'none') return;
      if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
      if (g.longPressActive) {
        // 长按结束：恢复原倍速
        videoEl.playbackRate = g.longPressOriginalRate;
        g.longPressActive = false;
        showHint(`${g.longPressOriginalRate} 倍速`);
        g.mode = 'none';
        return;
      }
      if (g.mode === 'swipe-h' || g.mode === 'swipe-v') {
        g.mode = 'none';
        return;
      }
      // 点按：区分单击与双击。单击延时 280ms 再执行（等第二击）。
      // 单击只切换控制栏显隐（Video.js 内置 tap 已处理），不切换播放/暂停；
      // 双击：左 1/3 快退 10s，右 1/3 快进 10s，中间 1/3 播放/暂停。
      if (isOnControl(e.target)) { g.mode = 'none'; return; }
      const now = Date.now();
      const rect = el?.getBoundingClientRect();
      const x = e.changedTouches[0]?.clientX ?? g.startX;
      const y = e.changedTouches[0]?.clientY ?? g.startY;
      // 旋转时沿视频宽度的位置改用视口 Y（包围盒高 = 视频宽）
      const pos = g.rotated ? y - (rect?.top ?? 0) : x - (rect?.left ?? 0);
      const span = g.rotated ? (rect?.height ?? 0) : (rect?.width ?? 0);
      const lastPos = g.rotated ? g.lastTapY : g.lastTapX;
      if (now - g.lastTapAt < 280 && Math.abs(pos - lastPos) < 80) {
        // 双击
        if (g.singleTapTimer) { clearTimeout(g.singleTapTimer); g.singleTapTimer = null; }
        g.lastTapAt = 0;
        const duration = (player.duration() ?? 0);
        const relX = span > 0 ? pos : span / 2;
        if (span > 0 && relX >= span / 3 && relX <= (2 * span) / 3) {
          // 中间 1/3：播放/暂停
          if (player.paused()) { void player.play()?.catch(() => {}); showHint('播放'); }
          else { player.pause(); showHint('暂停'); }
        } else {
          const isRight = span > 0 ? pos > span / 2 : true;
          const target = isRight
            ? Math.min((player.currentTime() ?? 0) + 10, Number.isFinite(duration) ? duration : Infinity)
            : Math.max(0, (player.currentTime() ?? 0) - 10);
          player.currentTime(target);
          showHint(isRight ? '快进 10s' : '快退 10s');
        }
      } else {
        // 可能是单击：先记下，等 280ms 无第二击再执行。
        // 单击不切换播放/暂停（控制栏显隐由 Video.js 内置 tap 处理）。
        g.lastTapAt = now;
        g.lastTapX = x;
        g.lastTapY = y;
        g.singleTapTimer = setTimeout(() => {
          g.singleTapTimer = null;
          g.lastTapAt = 0;
        }, 280);
      }
      g.mode = 'none';
    };
    const onTouchCancel = () => {
      const g = gestureRef.current;
      if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
      if (g.longPressActive) {
        videoEl.playbackRate = g.longPressOriginalRate;
        g.longPressActive = false;
      }
      if (g.singleTapTimer) { clearTimeout(g.singleTapTimer); g.singleTapTimer = null; }
      g.mode = 'none';
    };
    // 长按会呼出系统原生菜单/气泡：播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    el?.addEventListener('touchstart', onTouchStart, { passive: true });
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchCancel);
    el?.addEventListener('contextmenu', onContextMenu);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && !endedRef.current) {
        propsRef.current.onPause?.((player.currentTime() ?? 0), (player.duration() ?? 0));
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    // 初始源加载（快速起播：源就绪即播）
    setupSource(initialUrl);

    return () => {
      disposed = true;
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.((player.currentTime() ?? 0), (player.duration() ?? 0));
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      volumeBoostRef.current?.dispose();
      volumeBoostRef.current = null;
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      clearGestureTimers();
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchCancel);
      el?.removeEventListener('contextmenu', onContextMenu);
      videoEl.removeEventListener('resize', reportVideoHeight);
      restoreCleanupRef.current?.();
      restoreCleanupRef.current = null;
      setVhsAdFilterEnabled(false);
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      // 播放页可能仍持有读取接口：销毁前显式置空，避免「记录当前」读到已销毁实例
      propsRef.current.onPlayerApi?.(null);
      player.dispose();
      playerRef.current = null;
      videoElRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 音量放大开关：播放中改设置即时生效，不必等重新起播 ——
  // 关闭走「单位增益直通」而不是拆链：createMediaElementSource 之后元素输出只走
  // 音频图，拆链会永久静音且无法恢复直连，所以只旁路增益与限幅。
  // iOS 上 attachVolumeBoost 直接返回 null（不挂链），这里同样不做任何事。
  useEffect(() => {
    const video = videoElRef.current;
    if (!video) return;
    if (volumeBoost) {
      volumeBoostRef.current = attachVolumeBoost(video) ?? volumeBoostRef.current;
      volumeBoostRef.current?.setBoost(true);
    } else {
      volumeBoostRef.current?.setBoost(false);
    }
  }, [volumeBoost]);

  // —— 底部细进度条开关：播放中改设置即时生效，不用重开视频 ——
  useEffect(() => {
    updateMiniBar();
  }, [miniProgressBar]);

  // —— 上/下集禁用态 ——
  useEffect(() => {
    const player = playerRef.current as unknown as {
      __syncEpisodeButtons?: () => void;
    } | null;
    player?.__syncEpisodeButtons?.();
  }, [hasPrevEpisode, hasNextEpisode, url]);

  // —— 标记变化：重置采样基准并立即刷新提示 ——
  // 刚写入片段时当前时间可能恰好等于新边界，若沿用上一拍采样会被判成
  // 「连续越过」而当场触发；把基准拉平后本集只保留手动按钮，下一集才自动。
  // 顺带覆盖暂停中修改标记的场景（没有 timeupdate 也要让按钮即时出现/消失）。
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const current = (player.currentTime() ?? 0);
    lastSampleRef.current = Number.isFinite(current) ? current : 0;
    const segments = resolveSegments(skipMark, (player.duration() ?? 0));
    const active = findActiveSegment(segments, current);
    const prompt =
      active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
    updateSkipPrompt(prompt);
    renderSkipMarks();
  }, [skipMark]);

  // —— 换集：仅切换播放源，不重建播放器（保留全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 setupSource 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建播放链路（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    setVhsAdFilterEnabled(adFilter);
    if (playerRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="libretv-videojs w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      {/* 底部细进度条：控制栏收起且设置开启时显示（Video.js 的 vjs-user-inactive 时由 updateMiniBar 控制显隐） */}
      <div
        ref={miniBarRef}
        className="pointer-events-none absolute bottom-0 left-0 right-0 h-[3px] bg-white/20 opacity-0 transition-opacity duration-200"
        aria-hidden
      >
        <div ref={miniBarFillRef} className="h-full bg-[#2563eb]" style={{ width: '0%' }} />
      </div>
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
      {!error && skipPrompt && (
        <button
          type="button"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/70 px-4 py-2 text-sm text-white transition-colors hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => {
            if (skipPrompt.type === 'ending') {
              finishBySkip(skipPrompt);
              return;
            }
            const from = playerRef.current?.currentTime() ?? 0;
            if (skipTo(skipPrompt.end)) {
              handledSegmentsRef.current.add(segmentKey(skipPrompt));
              rememberSkip(from, skipPrompt);
              updateSkipPrompt(null);
              showHint(skipPrompt.type === 'opening' ? '已跳过片头' : '已跳过中段');
            }
          }}
        >
          {skipPrompt.type === 'ending'
            ? '跳过片尾'
            : skipPrompt.type === 'opening'
              ? '跳过片头'
              : '跳过中段'}
        </button>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
      {(hint || undoSkip) && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm text-white animate-fade-in">
          {/* 撤销窗口比普通提示长：hint 已淡出时仍要让用户知道刚才跳过了什么 */}
          <span className="pointer-events-none">
            {hint || (undoSkip ? `已跳过${SEGMENT_LABELS[undoSkip.segment.type]}` : '')}
          </span>
          {undoSkip && (
            <button
              type="button"
              className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={undoLastSkip}
            >
              撤销
            </button>
          )}
        </div>
      )}
      {autoplayNext && !error && (
        <div className="absolute bottom-16 right-3 text-[10px] text-muted bg-black/50 px-2 py-0.5 rounded pointer-events-none">
          自动连播已开启
        </div>
      )}
    </div>
  );
}
