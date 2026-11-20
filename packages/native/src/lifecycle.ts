/** Host-independent bounds for asynchronous lifecycle work; no I/O or credentials. */
export interface DeadlineOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  code: string;
  message: string;
}

export class DeadlineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeadlineError";
    this.code = code;
  }
}

/** Bound even dependencies that ignore cancellation, while observing their late settlement. */
export function withDeadline<T>(run: (boundedSignal: AbortSignal) => Promise<T>, options: DeadlineOptions): Promise<T> {
  const { signal, timeoutMs } = options;
  // A caller's cancellation is authoritative, including over invalid options.
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError("timeoutMs must be positive and finite"));
  return new Promise<T>((resolve, reject) => {
    const bounded = new AbortController();
    const started = performance.now();
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const cancel = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      bounded.abort(reason);
      reject(reason);
    };
    const onAbort = () => cancel(signal!.reason);
    const fail = (error: unknown) => {
      if (signal?.aborted) { onAbort(); return; }
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: T) => {
      if (signal?.aborted) { onAbort(); return; }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const expire = () => {
      if (signal?.aborted) { onAbort(); return; }
      if (settled) return;
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining > 0) { schedule(remaining); return; }
      cancel(new DeadlineError(options.code, options.message));
    };
    const schedule = (remaining: number) => {
      // Keep awaited headless work alive. Chunk long waits rather than letting
      // Node overflow a positive finite timeout into an immediate 1ms timer.
      timer = setTimeout(expire, Math.min(remaining, 2147483647));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    schedule(timeoutMs);
    try { Promise.resolve(run(bounded.signal)).then(succeed, fail); }
    catch (error) { fail(error); }
  });
}
