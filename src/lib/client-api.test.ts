import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './client-api';
import type { SourceConfig } from './types';

/**
 * 流式搜索（searchStream）单测：只覆盖 NDJSON 消费层，
 * 上游用 stub 的 fetch 返回写死的 NDJSON 文本，无真实网络。
 */

const SOURCES: SourceConfig[] = [{ key: 'a', name: '源A', url: 'https://cms.example.com/api.php' }];

function ndjsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.search 流式（searchStream）', () => {
  it('流被截断（无 done 事件）时抛错，不返回假空结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse(
          JSON.stringify({
            type: 'source',
            sourceKey: 'a',
            ok: true,
            list: [{ sourceKey: 'a', vodId: '1', name: '测试剧' }],
          }) + '\n'
        )
      )
    );
    const seen: unknown[] = [];
    const promise = api.search('测试剧', SOURCES, true, {
      onSource: (outcome) => {
        seen.push(outcome);
      },
    });
    await expect(promise).rejects.toThrow(ApiError);
    await expect(promise).rejects.toThrow('中途被断开');
    // 截断前已收到的 source 事件仍正常回调过，丢的只是“完整性”保证
    expect(seen).toHaveLength(1);
  });

  it('收到 done 事件时正常返回聚合结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse(
          JSON.stringify({
            type: 'source',
            sourceKey: 'a',
            ok: true,
            list: [{ sourceKey: 'a', vodId: '1', name: '测试剧' }],
          }) +
            '\n' +
            JSON.stringify({
              type: 'done',
              list: [{ sourceKey: 'a', vodId: '1', name: '测试剧' }],
              failures: [],
            }) +
            '\n'
        )
      )
    );
    const data = await api.search('测试剧', SOURCES, true, { onSource: () => {} });
    expect(data).toEqual({
      list: [{ sourceKey: 'a', vodId: '1', name: '测试剧' }],
      failures: [],
    });
  });
});
