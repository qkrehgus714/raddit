/**
 * 인메모리 TTL 캐시 — 파이썬 버전의 dict 캐시를 다음 3가지로 보강:
 *
 * 1. 요청 합치기(coalescing): 같은 키의 계산이 진행 중이면 새로 시작하지 않고
 *    그 Promise를 공유한다. 캐시 만료 순간 요청이 몰려도 업스트림 호출은 1번.
 * 2. stale-while-revalidate: TTL이 지나도 stale 허용 구간 안이면 옛 값을 즉시
 *    반환하고 갱신은 백그라운드로 돌린다 — 사용자는 느린 응답을 기다리지 않는다.
 * 3. stale-if-error: 갱신이 실패하면(업스트림 장애) 갖고 있던 옛 값으로 버틴다.
 *
 * 서버리스(Vercel)에서는 웜 인스턴스 안에서만 유효하다. 인스턴스를 넘나드는
 * 캐시는 라우트의 CDN 캐시 헤더(s-maxage)와 Next 데이터 캐시(fetch revalidate)가 맡는다.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;   // 이 시각까지는 신선한 값
  staleUntil: number;  // 이 시각까지는 stale로라도 서빙 가능
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(
    private defaultTtlMs: number,
    private staleMs = 0,
    private maxEntries = 300,
  ) {}

  async getOrCompute(
    key: string,
    compute: () => Promise<T>,
    opts?: {
      ttlMs?: number;                 // 이 호출에서만 쓸 TTL
      ttlFor?: (value: T) => number;  // 결과를 보고 TTL 결정 (예: 일부 실패한 응답은 짧게)
    },
  ): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && now < hit.expiresAt) return hit.value;

    const refresh = this.inflight.get(key) ?? this.beginRefresh(key, compute, opts);

    if (hit && now < hit.staleUntil) {
      refresh.catch(() => {}); // 백그라운드 갱신 — 실패해도 stale 값으로 버틴다
      return hit.value;
    }
    try {
      return await refresh;
    } catch (err) {
      if (hit) return hit.value; // stale-if-error: 만료된 값이라도 장애 응답보다는 낫다
      throw err;
    }
  }

  private beginRefresh(
    key: string,
    compute: () => Promise<T>,
    opts?: { ttlMs?: number; ttlFor?: (value: T) => number },
  ): Promise<T> {
    const p = (async () => {
      const value = await compute();
      const ttl = opts?.ttlFor ? opts.ttlFor(value) : opts?.ttlMs ?? this.defaultTtlMs;
      const now = Date.now();
      this.store.delete(key); // 재삽입으로 Map 순서를 갱신 — 오래된 키부터 밀려나게
      this.store.set(key, { value, expiresAt: now + ttl, staleUntil: now + ttl + this.staleMs });
      this.evict();
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private evict(): void {
    if (this.store.size <= this.maxEntries) return;
    const now = Date.now();
    for (const [k, e] of this.store) if (e.staleUntil <= now) this.store.delete(k);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}
