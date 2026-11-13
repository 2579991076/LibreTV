import { NextResponse } from 'next/server';

const URLS = [
  'https://bfzyapi.com/api.php/provide/vod?ac=list',
  'https://api.github.com',
  'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u',
];

export const dynamic = 'force-dynamic';

export async function GET() {
  const out: Record<string, unknown> = {};
  for (const u of URLS) {
    const t = Date.now();
    try {
      const r = await fetch(u);
      out[u] = { ok: true, status: r.status, ms: Date.now() - t };
    } catch (e: unknown) {
      const err = e as Error & { cause?: unknown };
      out[u] = { ok: false, error: err.message, cause: err.cause ? String(err.cause) : '', ms: Date.now() - t };
    }
  }
  return NextResponse.json(out);
}
