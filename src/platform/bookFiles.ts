/** Cancellation discards a late native result; no import is committed until preview is saved. */
export function cancellable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("已取消", "AbortError"));
    if (signal.aborted) { abort(); void work.catch(() => {}); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
