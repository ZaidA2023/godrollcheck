// Read-only transport: every request shares the import's budget and start gate.
export const API_ORIGIN = 'https://www.bungie.net';
export const PROFILE_COMPONENTS = [100,102,103,200,201,205,300,305,310];
// Abort listeners are removed on both completion and cancellation.
export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, {once:true});
  });
}
export function createClient(config, {signal, token, fetchImpl = globalThis.fetch, spacing = 250, timeout = 30000, budget = 2500} = {}) {
  if (!config?.apiKey) throw new Error('Configure the Bungie application first.');
  // Budget, spacing and throttle deadlines are shared by every request in this client.
  let attempts = 0, gate = Promise.resolve(), nextStart = 0, cooldownUntil = 0, terminalError = null;
  async function start() {
    // Serial reservation controls starts, while callers limit concurrent work to four.
    const reservation = gate.then(async () => {
      // A throttle from any active request delays all queued starts, including retries.
      while (true) {
        signal?.throwIfAborted();
        if (terminalError) throw terminalError;
        const delay = Math.max(nextStart,cooldownUntil) - Date.now();
        if (delay <= 0) break;
        await wait(delay,signal);
      }
      if (++attempts > budget) throw new Error('Definition request limit reached. Retry later with a smaller inventory.');
      nextStart = Date.now() + spacing;
    });
    // Keep the reservation chain usable after failure; each caller still receives its rejection.
    gate = reservation.catch(() => {});
    await reservation;
  }
  // Long server delays end this refresh instead of holding queued requests indefinitely.
  function cooldown(seconds) {
    if (seconds > 60) {
      terminalError = Object.assign(new Error('Bungie is throttling requests. Retry later.'),{noRetry:true});
      throw terminalError;
    }
    cooldownUntil = Math.max(cooldownUntil,Date.now()+seconds*1000);
  }
  async function perform(path, {method = 'GET', body, form = false} = {}) {
    const allowed = /^\/Platform\/(Destiny2\/(Manifest\/|[1-6]\/Profile\/\d+\/|Manifest\/Destiny(?:InventoryItem|InventoryBucket|SocketType|Stat)Definition\/\d+\/)|User\/GetMembershipsForCurrentUser\/)$/.test(path.split('?')[0]);
    if (!(allowed && method === 'GET') && !(path === '/Platform/App/OAuth/token/' && method === 'POST' && form)) throw new Error('Unsupported Bungie endpoint.');
    // At most two attempts are permitted; authorization exchange is never retried.
    for (let retry = 0; retry < 2; retry++) {
      await start();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, {once:true});
      const timer = setTimeout(() => controller.abort(new Error('Bungie request timed out.')), timeout);
      let response, envelope;
      try {
        signal?.throwIfAborted();
        const headers = {'X-API-Key':config.apiKey,'Accept-Language':'en'};
        if (token && !form) headers.Authorization = `Bearer ${token}`;
        if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        response = await fetchImpl(API_ORIGIN + path, {method, headers, body, signal:controller.signal, credentials:'omit', mode:'cors', cache:'no-store', redirect:'error', referrerPolicy:'strict-origin'});
        // Authorization errors may be HTML: inspect HTTP status before JSON parsing.
        // Provider bodies cannot turn an HTTP failure into a successful read.
      if (response.status === 401 || response.status === 403) throw new Error('authorization');
        const headerDelay = retryDelay(response.headers.get('Retry-After'));
        if (response.status === 429 || headerDelay > 0) cooldown(Math.max(response.status === 429 ? 1 : 0,headerDelay));
        try { envelope = await response.json(); }
        catch (error) { if (response.ok) throw error; envelope = {}; }
        if (!envelope || typeof envelope !== 'object') throw new Error('Invalid response envelope');
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error.noRetry) throw error;
        if (response?.status === 401 || response?.status === 403) throw new Error('Bungie authorization failed. Reconnect and check the read inventory permission.');
        // Only a read may retry a network failure, with at least one second of backoff.
        if (retry === 0 && !form) { await wait(1000, signal); continue; }
        throw new Error(controller.signal.aborted ? 'Bungie request timed out. Retry Refresh and Save.' : 'Bungie could not be reached. Retry Refresh and Save.');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      // Provider bodies cannot turn an HTTP failure into a successful read.
      if (response.status === 401 || response.status === 403) throw new Error('Bungie authorization failed. Reconnect and check the read inventory permission.');
      const throttle = Math.max(Number(envelope.ThrottleSeconds) || 0, retryDelay(response.headers.get('Retry-After')));
      if (throttle > 0) cooldown(throttle);
      if ((response.status === 429 || (throttle > 0 && envelope.ErrorCode !== 1) || response.status >= 500) && retry === 0 && !form) {
        await wait(Math.max(1000, throttle * 1000), signal); continue;
      }
      if (!response.ok) throw requestFailure(response.status,envelope,form,path,config.origin);
      if (form) return envelope;
      if (envelope.ErrorCode !== 1 || envelope.Response == null) throw requestFailure(response.status,envelope,false,path,config.origin);
      return envelope.Response;
    // All successful exits above have checked HTTP status and the Bungie envelope.
    }
  }
  let active = 0;
  const queue = [];
  async function request(path, options) {
    // Retain a slot through retry/backoff, preventing retries exceeding concurrency.
    if (active >= 4) await new Promise((resolve, reject) => {
      const entry = {resolve, reject};
      const abort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i,1); reject(signal.reason); };
      entry.finish = () => { signal?.removeEventListener('abort',abort); resolve(); };
      queue.push(entry); signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
    });
    // A dequeued waiter inherits the released slot, so it must not increment active.
    else active++;
    try { signal?.throwIfAborted(); return await perform(path,options); }
    finally { const next = queue.shift(); if (next) next.finish(); else active--; }
  }
  return {request, get attempts() { return attempts; }};
}
// Retry-After supports delta seconds and the standard absolute HTTP date.
function retryDelay(value) {
  if (!value) return 0;
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) : Math.max(0, (Date.parse(value) - Date.now()) / 1000) || 0;
}
export async function mapLimit(values, mapper, limit = 4) {
  const results = Array(values.length); let cursor = 0;
  await Promise.all(Array.from({length:Math.min(limit, values.length)}, async () => {
    while (cursor < values.length) { const index = cursor++; results[index] = await mapper(values[index], index); }
  }));
  return results;
// No API request exists outside this bounded client.
}

// Translate provider diagnostics into fixed text; never display raw bodies or secrets.
function requestFailure(status,envelope,form,path,expectedOrigin) {
  const code=Number.isSafeInteger(envelope?.ErrorCode)?envelope.ErrorCode:null;
  const oauth=['invalid_request','invalid_client','invalid_grant','unauthorized_client','unsupported_grant_type'].includes(envelope?.error)?envelope.error:null;
  const reason=[envelope?.error_description,envelope?.ErrorStatus,envelope?.Message].filter(v=>typeof v==='string').join(' ').toLowerCase();
  let advice;
  if (/redirect[_ ]?uri|redirect url/.test(reason)) advice='The callback URL does not match Bungie’s app settings. Check the registered Redirect URL exactly.';
  else if (/originheader|origin header/.test(reason)) advice='The website origin does not match Bungie’s app settings. Check Origin Header.';
  else if (oauth==='invalid_client'||/client.secret|client secret|clientauthentication|client authentication/.test(reason)) advice='Bungie rejected the app credentials. Check client ID and Public OAuth client type; this site does not use a client secret.';
  else if (oauth==='invalid_grant'||code===2106||/authorization.?code|code.{0,15}(expired|invalid|used)/.test(reason)) advice='Bungie rejected the sign-in code. Return to My Loadout and start Connect Bungie again in the same browser tab; do not reload the callback page.';
  else if (oauth==='unauthorized_client') advice='This Bungie application is not authorized for this sign-in flow. Check its OAuth configuration.';
  else advice=form?'Bungie rejected the sign-in exchange. Check Public OAuth and the registered callback, then start Connect Bungie again.':'The account read was rejected. Check the connected account and read inventory permission before trying again.';
  if (code===2107 || /originheader|origin header/.test(reason)) {
    // Only origins are shown: discard provider URL paths, queries and credentials.
    const observed=envelope?.MessageData?.Origin;
    let safeOrigin='not supplied by Bungie';
    if (observed==='null') safeOrigin='null';
    else if (typeof observed==='string') {try {const value=new URL(observed);if (['https:','http:'].includes(value.protocol)) safeOrigin=value.origin;}catch{}}
    advice+=` Bungie reports origin: ${safeOrigin}. Expected: ${expectedOrigin}.`;
  }
  const stage=form?'sign-in exchange':path.includes('/Profile/')?'inventory read':path.includes('GetMemberships')?'account lookup':path==='/Platform/Destiny2/Manifest/'?'manifest lookup':path.includes('/Manifest/')?'definition lookup':'request';
  return new Error(`Bungie ${stage} failed (HTTP ${status}${code!=null?`, code ${code}`:''}${oauth?`, ${oauth}`:''}). ${advice}`);
}
