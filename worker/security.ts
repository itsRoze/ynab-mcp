import { timingSafeEqual } from 'node:crypto';
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [left, right] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', encode.encode(s))));
  return timingSafeEqual(new Uint8Array(left!), new Uint8Array(right!));
}
export function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your YNAB</title><style>body{font:17px/1.6 system-ui;max-width:440px;margin:12vh auto;padding:24px;color:#16352b;background:#f6f7f3}h1{font-size:30px;line-height:1.2}label{display:block;margin:24px 0 6px}input,button{box-sizing:border-box;width:100%;padding:14px;border:1px solid #a4b4ab;border-radius:8px;font:inherit}button{margin-top:18px;background:#164d3b;color:white;cursor:pointer}small{display:block;color:#52665a;overflow-wrap:anywhere}</style><main>${body}</main></html>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}
