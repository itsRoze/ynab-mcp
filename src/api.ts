export class ApiError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}
export interface ApiOptions {
  token: string;
  fetch?: typeof fetch;
  cacheMs?: number;
}
export class YnabApi {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly cacheMs: number;
  private cache = new Map<string, { expires: number; data: unknown }>();
  private blockedUntil = 0;
  private generation = 0;
  constructor(options: ApiOptions) {
    if (!options.token.trim()) throw new Error('Set YNAB_ACCESS_TOKEN in your local environment file.');
    this.token = options.token.trim();
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.cacheMs = options.cacheMs ?? 15_000;
  }
  async request<T = Record<string, unknown>>(path: string, options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT'; body?: unknown; fresh?: boolean;
  } = {}): Promise<T> {
    if (!path.startsWith('/plans') || path.includes('..')) throw new Error('Invalid API path.');
    const method = options.method ?? 'GET';
    const cached = this.cache.get(path);
    if (method === 'GET' && !options.fresh && cached && cached.expires > Date.now()) {
      return structuredClone(cached.data) as T;
    }
    if (Date.now() < this.blockedUntil) throw new ApiError('YNAB rate limit reached. Wait before trying again.', 429);
    // Clear before a write, including uncertain writes that time out after reaching YNAB.
    if (method !== 'GET') { this.generation++; this.cache.clear(); }
    const generation = this.generation;
    let response: Response;
    try {
      response = await this.fetcher(`https://api.ynab.com/v1${path}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new ApiError(method === 'GET' ? 'Could not reach YNAB. Try again shortly.' :
        'Write outcome is unknown due to a network error. Read fresh data before retrying; reuse the same request_id for transaction creation.');
    }
    if (!response.ok) {
      if (response.status === 429) {
        const raw = response.headers.get('retry-after');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 60;
        this.blockedUntil = Date.now() + Math.max(1, seconds) * 1000;
      }
      // Never echo upstream bodies, which can contain financial data or secrets.
      const messages: Record<number, string> = {
        400: 'YNAB rejected the input. Check the IDs, amount, date and category type.',
        401: 'YNAB rejected the access token. Check or replace your locally stored token.',
        403: 'YNAB denied access. Check account status and token permissions.',
        404: 'YNAB could not find that plan or item.',
        409: 'YNAB reported a conflict or duplicate. Read fresh data before retrying.',
        429: 'YNAB rate limit reached (200 requests per rolling hour). Wait before retrying.',
      };
      throw new ApiError(messages[response.status] ?? `YNAB returned HTTP ${response.status}. Read fresh data before retrying writes.`, response.status);
    }
    let payload: { data: T };
    try { payload = await response.json() as { data: T }; }
    catch { throw new ApiError('YNAB returned an unreadable response. Read fresh data before retrying writes.'); }
    if (!payload || typeof payload !== 'object' || !('data' in payload)) throw new ApiError('Unexpected YNAB response. Read fresh data before retrying writes.');
    if (method === 'GET' && generation === this.generation) {
      if (this.cache.size >= 100) this.cache.clear();
      this.cache.set(path, { expires: Date.now() + this.cacheMs, data: structuredClone(payload.data) });
    } else if (method !== 'GET') { this.generation++; this.cache.clear(); }
    return payload.data;
  }
}
