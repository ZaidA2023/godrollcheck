// This broker stores provider refresh tokens privately; the browser keeps an opaque handle.
export const BACKEND_SESSION = 'godrollcheck.bungie.55490.backend.v1';
export const BACKEND_EPOCH = `${BACKEND_SESSION}.epoch`;
const LOCK = `${BACKEND_SESSION}.lock`;
export function backendOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The sign-in backend URL is invalid.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.workers\.dev$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the configured HTTPS Cloudflare Worker origin for sign-in.');
  return url.origin;
}
export function backendEpoch() { try { return localStorage.getItem(BACKEND_EPOCH); } catch { return null; } }
export function readBackendSession() {
  try {
    const session = JSON.parse(localStorage.getItem(BACKEND_SESSION));
    if (session?.kind !== 'backend' || session.epoch !== backendEpoch() || !session.epoch || !/^[a-f0-9]{64}$/.test(session.sessionKey) || !Number.isFinite(session.refreshExpiresAt) || session.refreshExpiresAt <= Date.now() || typeof session.accessToken !== 'string' || !session.accessToken || !Number.isFinite(session.expiresAt) || backendOrigin(session.backendUrl) !== session.backendUrl) return null;
    return session;
  } catch { return null; }
}
// Every generation/session mutation and saved-inventory commit shares this lock across tabs.
export function backendLock(task, signal) {
  if (!globalThis.navigator?.locks?.request) throw new Error('This browser needs Web Locks to keep Bungie connected safely. Use a current Chrome, Firefox or Safari.');
  return navigator.locks.request(LOCK, {mode:'exclusive', ...(signal ? {signal} : {})}, task);
}
export function assertEpoch(epoch) {
  if (epoch && backendEpoch() !== epoch) throw new DOMException('Account connection changed.', 'AbortError');
}
export function writeBackendSession(session) {
  assertEpoch(session.epoch);
  try { localStorage.setItem(BACKEND_SESSION, JSON.stringify(session)); }
  catch { throw new Error('This browser could not save the Bungie connection. Allow local storage and connect again.'); }
}
export function setEpoch(epoch) { localStorage.setItem(BACKEND_EPOCH, epoch); }
export function removeBackendSession() { localStorage.removeItem(BACKEND_SESSION); }
// Validate an explicit response allowlist; neither secrets nor provider refresh tokens are retained.
export function tokenResult(raw, {exchange=false}={}) {
  const now=Date.now();
  if (typeof raw?.accessToken !== 'string' || !raw.accessToken || raw.accessToken.length>8192 || !Number.isFinite(raw.expiresAt) || raw.expiresAt<=now || raw.expiresAt>now+86400000 || !Number.isFinite(raw.refreshExpiresAt) || raw.refreshExpiresAt<=now || raw.refreshExpiresAt>now+91*86400000 || !/^\d+$/.test(raw.bungieMembershipId) || (exchange&&!/^[a-f0-9]{64}$/.test(raw.sessionKey))) throw new Error('The sign-in backend returned an invalid session. Connect again.');
  return {accessToken:raw.accessToken,expiresAt:raw.expiresAt,refreshExpiresAt:raw.refreshExpiresAt,bungieMembershipId:raw.bungieMembershipId,...(exchange?{sessionKey:raw.sessionKey}:{})};
}
export async function brokerRequest(origin, path, {body={},sessionKey,signal,keepalive=false}={}) {
  origin=backendOrigin(origin);
  if (!['/exchange','/refresh','/disconnect'].includes(path)) throw new Error('Unsupported sign-in backend endpoint.');
  if (path!=='/exchange'&&!/^[a-f0-9]{64}$/.test(sessionKey)) throw new Error('Reconnect to Bungie before renewing this session.');
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('Sign-in backend timed out.')),15000);
  // No response body or provider diagnostic is included in a user-facing failure.
  try {
    controller.signal.throwIfAborted();
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(sessionKey?{Authorization:`Bearer ${sessionKey}`}:{})},body:JSON.stringify(body),credentials:'omit',mode:'cors',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal,keepalive});
    if(!response.ok)throw Object.assign(new Error(response.status===401?'Bungie connection expired. Connect again.':'The sign-in backend could not complete this request. Retry later.'),{reconnect:response.status===401});
    const raw=await response.json();return path==='/disconnect'?{}:tokenResult(raw,{exchange:path==='/exchange'});
  // Caller cancellation takes precedence over transport diagnostics.
  } catch(error) {
    if(signal?.aborted)throw signal.reason;
    if(error.reconnect)throw error;
    throw new Error('The sign-in backend could not complete this request. Retry later.');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
