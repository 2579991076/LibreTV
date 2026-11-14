'use client';

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { SmartImage } from './smart-image';
import { ConfirmDialog } from './confirm-dialog';
import { useToast } from './toast';
import { db, clearAllHistory, upsertHistory, type HistoryEntry } from '@/lib/db';
import { buildWatchUrl, formatTime } from '@/lib/utils';
import { resolveSource, useAppStore } from '@/lib/store';

/**
 * 首页「继续观看」行：取最近 10 条观看历史，按时间倒序横向排列。
 * 放在首页最顶部（搜索区之前），无历史时不渲染。
 * 点击直接回到该集的精确进度：播放页的恢复优先级是 URL position 参数 >
 * IndexedDB 进度表，所以把 history.playbackPosition 拼进链接，复用现有恢复机制。
 */
export function ContinueWatching() {
  // 实时订阅 history 表：看完回来、或在历史面板清空后，首页行自动跟上，
  // 只在表变化时重算，不另起轮询
  const history = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(10).toArray(),
    []
  );
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);

  const items = (history ?? []).filter(hasMeaningfulProgress);
  if (items.length === 0) return null;

  return (
    <section aria-label="继续观看" className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-content">继续观看</h2>
        <button
          type="button"
          className="shrink-0 px-2 py-1 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
          onClick={() => setConfirmClear(true)}
        >
          清空
        </button>
      </div>
      <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        {items.map((item) => (
          <ContinueCard key={item.id} item={item} />
        ))}
      </div>

      <ConfirmDialog
        open={confirmClear}
        danger
        title="清空全部观看历史？"
        message={`将删除 ${items.length} 条观看记录，此操作不可撤销。`}
        confirmLabel="清空"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void clearAllHistory().then(() => toast('观看历史已清空', 'success'));
          setConfirmClear(false);
        }}
      />
    </section>
  );
}

/** 无意义进度直接跳过：刚点开又退出（≤10 秒且无总时长）的记录不占一行 */
function hasMeaningfulProgress(entry: HistoryEntry): boolean {
  return !(entry.playbackPosition <= 10 && entry.duration === 0);
}

function ContinueCard({ item }: { item: HistoryEntry }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const [imgFailed, setImgFailed] = useState(false);
  const source = resolveSource({ customAPIs, envSources }, item.sourceKey);

  const percent =
    item.duration > 0
      ? Math.min(100, Math.round((item.playbackPosition / item.duration) * 100))
      : 0;
  const episodeLabel =
    item.totalEpisodes > 0
      ? `第 ${item.episodeIndex + 1}/${item.totalEpisodes} 集`
      : `第 ${item.episodeIndex + 1} 集`;

  // 播放页按 URL 驱动：source/id/index 定位剧集，position 精确到秒恢复进度。
  // buildWatchUrl 本身不带 position 参数（不可改 utils.ts），在此追加；
  // 播放页 getRestorePosition 会优先采用 URL position，兜底才读进度表。
  const href = buildWatchUrl({
    sourceKey: item.sourceKey,
    vodId: item.vodId,
    index: item.episodeIndex,
    title: item.title,
    sourceUrl: source?.url,
    detail: source?.detail,
  });
  const position = Math.floor(item.playbackPosition);
  const resumeHref = position > 0 ? `${href}&position=${position}` : href;

  return (
    <Link
      href={resumeHref}
      onClick={() => {
        // 点击即同步一次时间戳，置顶最近观看（与历史面板一致）
        upsertHistory({ ...item, timestamp: Date.now() }).catch(() => {});
      }}
      className="block w-[128px] sm:w-[144px] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-lg"
      aria-label={`继续观看${item.title} ${episodeLabel}`}
    >
      <div className="relative aspect-[2/3] bg-chip rounded-lg overflow-hidden">
        {item.pic && !imgFailed ? (
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1-1V6z" />
            </svg>
          </div>
        )}
        {item.duration > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div className="mt-1.5 px-0.5">
        <div className="text-xs font-medium text-content truncate" title={item.title}>
          {item.title}
        </div>
        <div className="text-[11px] text-faint mt-0.5 truncate">
          {episodeLabel}
          {item.playbackPosition > 0 && ` · 已看 ${formatTime(item.playbackPosition)}`}
        </div>
      </div>
    </Link>
  );
}
