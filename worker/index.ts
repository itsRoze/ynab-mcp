import { DurableObject } from 'cloudflare:workers';
import { OAuthProvider, type OAuthHelpers, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { YnabApi } from '../src/api.js';
import { createServer } from '../src/server.js';
import { constantTimeEqual, escapeHtml, htmlResponse } from './security.js';

interface Env extends CloudflareBindings {
  OAUTH_PROVIDER: OAuthHelpers;
  YNAB_ACCESS_TOKEN: string;
  CONNECTOR_PASSWORD: string;
}
const scope = 'ynab:manage';
const cookieName = '__Host-ynab-consent';

/** A single private instance serializes reads/writes across all remote clients. */
export class BudgetCoordinator extends DurableObject<Env> {
  private api?: YnabApi;
  private queue: Promise<unknown> = Promise.resolve();
  fetch(request: Request): Promise<Response> {
    const task = this.queue.then(() => this.dispatch(request));
    this.queue = task.catch(() => {});
    return task;
  }
  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/internal/consent') {
      const id = crypto.randomUUID();
      // Strongly consistent, single-use consent challenges bound to the full OAuth URL.
      await this.ctx.storage.put(`consent:${id}`, { url: await request.text(), expires: Date.now() + 600_000 });
      await this.ctx.storage.setAlarm(Date.now() + 600_000);
      return Response.json({ id });
    }
    if (url.pathname === '/internal/login') {
      const { id, password, oauthUrl } = await request.json() as { id: string; password: string; oauthUrl: string };
      const record = await this.ctx.storage.get<{ url: string; expires: number }>(`consent:${id}`);
      await this.ctx.storage.delete(`consent:${id}`);
      if (!record || record.expires < Date.now() || record.url !== oauthUrl) return new Response('Invalid or expired consent', { status: 403 });
      const attemptKey = 'login-attempts';
      const attempts = await this.ctx.storage.get<{ count: number; reset: number }>(attemptKey);
      const now = Date.now();
      const state = attempts && attempts.reset > now ? attempts : { count: 0, reset: now + 300_000 };
      if (state.count >= 10) return new Response('Too many attempts. Wait five minutes.', { status: 429 });
      state.count++;
      await this.ctx.storage.put(attemptKey, state);
      if (!await constantTimeEqual(password, this.env.CONNECTOR_PASSWORD)) return new Response('Incorrect connector password', { status: 403 });
      await this.ctx.storage.delete(attemptKey);
      return new Response('ok');
    }
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    this.api ??= new YnabApi({ token: this.env.YNAB_ACCESS_TOKEN });
    const server = createServer(this.api);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // Buffer before closing so the request/response lifecycle and queue cover the entire tool call.
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } finally { await server.close(); }
  }
  async alarm(): Promise<void> {
    const entries = await this.ctx.storage.list<{ expires: number }>({ prefix: 'consent:' });
    for (const [key, entry] of entries) if (entry.expires <= Date.now()) await this.ctx.storage.delete(key);
    if ([...entries.values()].some(e => e.expires > Date.now())) await this.ctx.storage.setAlarm(Date.now() + 600_000);
  }
}
function coordinator(env: Env) { return env.BUDGET.getByName('owner'); }
async function authorization(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/') return htmlResponse('<h1>Your private YNAB connector</h1><p>Add this address in your agent’s connector settings:</p><small>' + escapeHtml(env.PUBLIC_ORIGIN + '/mcp') + '</small><p>Sign in with your connector password when prompted. Your YNAB token stays on the server.</p>');
  if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 });
  if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  let auth: AuthRequest;
  try { auth = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(request.url)); }
  catch { return htmlResponse('<h1>Invalid connection request</h1><p>Return to your agent and start connecting again.</p>', 400); }
  if (auth.codeChallengeMethod !== 'S256' || !auth.codeChallenge) return htmlResponse('<h1>PKCE required</h1><p>This client must use OAuth PKCE with S256.</p>', 400);
  if (auth.scope.some(s => s !== scope)) return htmlResponse('<h1>Unsupported permissions</h1>', 400);
  if (request.method === 'GET') {
    const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
    const response = await coordinator(env).fetch(new Request('https://internal/internal/consent', { method: 'POST', body: request.url }));
    const { id } = await response.json() as { id: string };
    return htmlResponse(`<h1>Connect your YNAB</h1><p><strong>${escapeHtml(client?.clientName ?? 'This agent')}</strong> wants to read and change your budget.</p><small>Client: ${escapeHtml(auth.clientId)}<br>Return to: ${escapeHtml(auth.redirectUri)}</small><form method="post"><input type="hidden" name="consent" value="${id}"><label for="password">Connector password</label><input id="password" name="password" type="password" required autocomplete="current-password"><small>Use your private connector password—not your YNAB password or API token.</small><button type="submit">Connect and allow budget changes</button></form>`, 200, {
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(auth.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      'Set-Cookie': `${cookieName}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    });
  }
  if (request.headers.get('origin') !== env.PUBLIC_ORIGIN || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response('Forbidden', { status: 403 });
  const body = await request.text();
  if (body.length > 4096) return new Response('Request too large', { status: 413 });
  const form = new URLSearchParams(body);
  const id = form.get('consent') ?? '';
  const cookie = request.headers.get('cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!id || !cookie || !await constantTimeEqual(id, cookie)) return new Response('Invalid consent session', { status: 403 });
  const result = await coordinator(env).fetch(new Request('https://internal/internal/login', { method: 'POST', body: JSON.stringify({ id, password: form.get('password') ?? '', oauthUrl: request.url }) }));
  if (!result.ok) return htmlResponse('<h1>Connection not authorized</h1><p>The password was incorrect, the request expired, or there were too many attempts. Return to your agent and try connecting again.</p>', result.status);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: auth, userId: 'owner', metadata: { clientName: (await env.OAUTH_PROVIDER.lookupClient(auth.clientId))?.clientName },
    scope: [scope], props: { owner: true },
  });
  return new Response(null, { status: 302, headers: { Location: redirectTo, 'Cache-Control': 'no-store',
    'Set-Cookie': `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` } });
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.PUBLIC_ORIGIN || !env.YNAB_ACCESS_TOKEN || !env.CONNECTOR_PASSWORD || env.CONNECTOR_PASSWORD.length < 32) return new Response('Connector setup is incomplete.', { status: 503 });
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) return new Response('Invalid origin', { status: 403 });
    const origin = request.headers.get('origin');
    if (origin && origin !== env.PUBLIC_ORIGIN) return new Response('Forbidden origin', { status: 403 });
    const provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: { async fetch(req, bindings, context) {
        if (!(context.props as { owner?: boolean } | undefined)?.owner) return new Response('Forbidden', { status: 403 });
        if (new URL(req.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
        return coordinator(bindings).fetch(req);
      } },
      defaultHandler: { fetch: authorization }, authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register', clientIdMetadataDocumentEnabled: true, scopesSupported: [scope],
      accessTokenTTL: 3600, refreshTokenTTL: 2_592_000, allowPlainPKCE: false,
      resourceMetadata: { resource: env.PUBLIC_ORIGIN + '/mcp', scopes_supported: [scope], resource_name: 'Private YNAB' },
    });
    try { return await provider.fetch(request, env, ctx); }
    catch { return new Response('Connector request failed. Retry from your agent.', { status: 500 }); }
  },
} satisfies ExportedHandler<Env>;
