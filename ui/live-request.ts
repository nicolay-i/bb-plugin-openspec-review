export function liveRequest<T>(load: (signal: AbortSignal) => Promise<T>, onData: (data: T) => void, onError: (error: unknown) => void, onSettled: () => void) {
  const controller = new AbortController();
  let busy = false;
  let dirty = false;
  async function run(): Promise<void> {
    if (controller.signal.aborted) return;
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      const data = await load(controller.signal);
      if (!controller.signal.aborted) onData(data);
    } catch (error) { if (!controller.signal.aborted) onError(error); }
    finally {
      busy = false;
      if (!controller.signal.aborted) {
        onSettled();
        if (dirty) { dirty = false; void run(); }
      }
    }
  }
  return { run, dispose: () => controller.abort() };
}
