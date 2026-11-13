import { NextResponse } from 'next/server';
import { fetchUpstream } from '../../../lib/fetch-utils';
import { cmsRequestHeaders } from '../../../lib/cms-parser';

export const dynamic = 'force-dynamic';

export async function GET() {
  const out: Record<string, unknown> = {};
  const acList = 'https://bfzyapi.com/api.php/provide/vod?ac=list';
  const searchUrl = 'https://bfzyapi.com/api.php/provide/vod?ac=videolist&wd=%E7%8B%82%E9%A3%99&pg=1';

  const t0 = Date.now();
  try {
    const r = await fetch(acList);
    out['plain ac=list'] = { ok: true, status: r.status, ms: Date.now() - t0 };
  } catch (e: unknown) {
    const err = e as Error & { cause?: unknown };
    out['plain ac=list'] = { ok: false, error: err.message, cause: err.cause ? String(err.cause) : '', ms: Date.now() - t0 };
  }

  const t1 = Date.now();
  try {
    const r = await fetchUpstream(acList, { timeoutMs: 8000 });
    out['ssrf ac=list'] = { ok: true, status: r.status, ms: Date.now() - t1 };
  } catch (e: unknown) {
    const err = e as Error & { cause?: unknown };
    out['ssrf ac=list'] = { ok: false, error: err.message, cause: err.cause ? String(err.cause) : '', ms: Date.now() - t1 };
  }

  const t2 = Date.now();
  try {
    const r = await fetchUpstream(searchUrl, { timeoutMs: 8000, headers: cmsRequestHeaders() });
    const j = await r.json();
    out['ssrf videolist'] = { ok: true, status: r.status, ms: Date.now() - t2, total: (j as { total?: unknown }).total };
  } catch (e: unknown) {
    const err = e as Error & { cause?: unknown };
    out['ssrf videolist'] = { ok: false, error: err.message, cause: err.cause ? String(err.cause) : '', ms: Date.now() - t2 };
  }

  return NextResponse.json(out);
}
