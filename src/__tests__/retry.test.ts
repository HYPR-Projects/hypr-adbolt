import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '@/services/activation/retry';

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns 2xx response without retrying', async () => {
    const okResponse = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(okResponse);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 4xx (except 429)', async () => {
    const badRequest = new Response('bad', { status: 400 });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(badRequest);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 502, 503, 504 with exponential backoff', async () => {
    const fail = new Response('', { status: 502 });
    const ok = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(ok);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 (new behavior)', async () => {
    const rateLimited = new Response('', { status: 429 });
    const ok = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(ok);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('respects Retry-After header in seconds on 429', async () => {
    const rateLimited = new Response('', {
      status: 429,
      headers: { 'Retry-After': '5' },
    });
    const ok = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(ok);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' });
    // Deveria esperar 5s antes de tentar de novo
    await vi.advanceTimersByTimeAsync(4000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // ainda não retentou
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('caps Retry-After at 30s to avoid UI hang', async () => {
    const rateLimited = new Response('', {
      status: 429,
      headers: { 'Retry-After': '600' }, // 10 min — muito alto
    });
    const ok = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(ok);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' });
    // Cap = 30s. Avançar 31s deve ser suficiente.
    await vi.advanceTimersByTimeAsync(31_000);
    await promise;
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns the final 429 response if all retries exhaust', async () => {
    const rateLimited = new Response('', { status: 429 });
    vi.mocked(globalThis.fetch).mockResolvedValue(rateLimited);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' }, 2);
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(429);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries on network errors (fetch throws)', async () => {
    const ok = new Response('ok', { status: 200 });
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(ok);

    const promise = fetchWithRetry('https://example.com', { method: 'POST' });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on persistent network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('still down'));

    const promise = fetchWithRetry('https://example.com', { method: 'POST' }, 2);
    // Attach catch handler imediatamente pra evitar unhandled rejection do fake timer
    const captured = promise.catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const result = await captured;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/still down/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
