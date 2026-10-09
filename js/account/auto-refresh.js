// One timer and one reservation serialize automatic refresh with the parent's busy gate.
export function createAutoRefresh({refresh,eligible=()=>false,signal,onStatus,interval=120000,
  document=globalThis.document,navigator=globalThis.navigator,now=Date.now,
  setTimeout=globalThis.setTimeout,clearTimeout=globalThis.clearTimeout} = {}) {
  if (!(Number.isFinite(interval) && interval > 0)) throw new TypeError('Invalid refresh interval');
  let enabled = true, stopped = false, running = false, failures = 0;
  let nextAt = now()+interval, timer = null, generation = 0, controller;
  const events = document?.defaultView ?? globalThis;
  const status = () => onStatus?.({enabled,nextAt,failures,running});
  function disarm() { if (timer !== null) clearTimeout(timer); timer = null; }
  function allowed() {
    return document?.visibilityState === 'visible' && navigator?.onLine !== false && eligible();
  }
  function arm() {
    disarm();
    if (stopped || !enabled || !document) return;
    // Overdue but ineligible work is checked at most once per interval.
    timer = setTimeout(tick,Math.max(1,nextAt > now() ? nextAt-now() : interval));
  }
  function completed(outcome) {
    if (stopped) return;
    if (outcome === 'saved') failures = 0;
    else if (outcome === 'failed') failures++;
    const delay = outcome === 'failed' ? Math.min(600000,interval * 2 ** Math.min(failures-1,20)) : interval;
    nextAt = now()+delay; status(); arm();
  }
  async function tick() {
    // Consume the current timer; every continuation must explicitly schedule again.
    disarm();
    if (stopped || !enabled || !document) return;
    if (running || now() < nextAt || !allowed()) { arm(); return; }
    // Reserve synchronously before refresh can yield or visibility events can repeat.
    running = true; const owner = generation;
    controller = new AbortController(); status();
    let outcome;
    try { outcome = await refresh({signal:controller.signal}); }
    // Cancellation preserves the failure count; unexpected rejections back off.
    catch { outcome = controller.signal.aborted ? 'cancelled' : 'failed'; }
    finally {
      running = false; controller = undefined;
      // A reset owns the new deadline, so stale outcomes cannot overwrite it.
      if (!stopped && generation === owner) {
        completed(['saved','failed','skipped','cancelled'].includes(outcome) ? outcome : 'failed');
      } else if (!stopped) { status(); arm(); }
    }
  }
  function wake() {
    if (stopped || !enabled || !document) return;
    if (!running && now() >= nextAt && allowed()) void tick(); else arm();
  }
  function reset() {
    if (stopped) return;
    // Invalidate an outstanding result while retaining its no-overlap reservation.
    generation++; failures = 0; nextAt = now()+interval; status(); arm();
  }
  function setEnabled(value) {
    if (stopped || enabled === Boolean(value)) return;
    enabled = Boolean(value); reset();
  }
  function stop() {
    if (stopped) return;
    // Invalidate before aborting, then remove every source of future wakeups.
    stopped = true; enabled = false; generation++; disarm(); controller?.abort();
    document?.removeEventListener?.('visibilitychange',wake);
    events.removeEventListener?.('online',wake);
    events.removeEventListener?.('offline',wake);
    signal?.removeEventListener('abort',stop); status();
  }
  document?.addEventListener?.('visibilitychange',wake);
  events.addEventListener?.('online',wake); events.addEventListener?.('offline',wake);
  signal?.addEventListener('abort',stop,{once:true});
  if (signal?.aborted) stop(); else { status(); arm(); }
  return {setEnabled,reset,completed,stop};
}
