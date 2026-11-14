import { NextResponse } from 'next/server';
import { handleProxyRequest } from '@/lib/proxy-handlers';

export const runtime = 'nodejs';

/**
 * 查询串形式的通用代理：/api/proxy?url=<encodeURIComponent(target)>。
 * 查询串不参与网关路径归一化（EdgeOne 等会把路径里的 %2F 解码成 /），
 * 全平台行为一致；旧路径形式 /api/proxy/<encoded> 仍由 [url] 路由兼容。
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const targetUrl = params.get('url');
  if (!targetUrl) return new NextResponse('缺少 url 参数', { status: 400 });
  // stripAds=1：iOS 原生 HLS 专用，代理在服务端先删广告段（分片仍直连）
  const stripAds = params.get('stripAds') === '1';
  return handleProxyRequest(req, targetUrl, { stripAds });
}
