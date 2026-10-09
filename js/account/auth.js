import {BACKEND_SESSION,BACKEND_EPOCH,backendOrigin,backendEpoch,readBackendSession,backendLock,assertEpoch,writeBackendSession,setEpoch,removeBackendSession,brokerRequest} from './backend-auth.js';
import {callbackPath} from './callback-path.js';
// Session credentials stay in this tab; operations share account-change cancellation.
import {createClient} from './bungie.js';
const SESSION = 'loadout.session.v1', PENDING = 'loadout.oauth.v1';
const operations = new Set();
const snapshotEpochs = new WeakMap();
export function tagSnapshotEpoch(snapshot, epoch) { snapshotEpochs.set(snapshot, epoch); return snapshot; }
export function savedSnapshotEpoch(snapshot) { return snapshotEpochs.has(snapshot)?snapshotEpochs.get(snapshot):readBackendSession()?.epoch; }
export function withConnectionLock(epoch, task, signal) { return epoch?backendLock(()=>{assertEpoch(epoch);return task();},signal):task(); }
// Other tabs invalidate active reads immediately; final locked generation checks are authoritative.
if(globalThis.addEventListener)globalThis.addEventListener('storage',event=>{if([BACKEND_SESSION,BACKEND_EPOCH].includes(event.key)||event.key===null)cancelOperations();});
export function operationSignal(signal) {
  const controller = new AbortController(), epoch = readBackendSession()?.epoch;
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
  operations.add(controller);
  return {signal:controller.signal, epoch, assertCurrent() {controller.signal.throwIfAborted();assertEpoch(epoch);}, dispose() { operations.delete(controller); signal?.removeEventListener('abort', abort); }};
}
// Account changes cancel both network reads and any registered save.
function cancelOperations() { for (const controller of operations) controller.abort(new DOMException('Account connection changed.', 'AbortError')); operations.clear(); }
function read(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } }
// Reading session state is synchronous and never makes a network request.
export function getSession() {
  const backend = readBackendSession(); if(backend)return backend;
  const session = read(SESSION);
  if (typeof session?.accessToken !== 'string' || !session.accessToken || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) { sessionStorage.removeItem(SESSION); return null; }
  return session;
}
export function disconnect({waitForServer=true}={}) {
  const backend=readBackendSession(),epoch=backendEpoch();
  cancelOperations();sessionStorage.removeItem(SESSION);sessionStorage.removeItem(PENDING);
  if(!epoch)return;
  return backendLock(()=>{assertEpoch(epoch);setEpoch(crypto.randomUUID());removeBackendSession();}).then(async()=>{
    if(backend){
      const deletion=brokerRequest(backend.backendUrl,'/disconnect',{sessionKey:backend.sessionKey,keepalive:true});
      if(waitForServer)await deletion;else deletion.catch(()=>{});
    }
  });
}
// Configuration cannot redirect OAuth to another origin or arbitrary callback path.
export function validateConfig(config) {
  if (!config?.apiKey || !/^\d+$/.test(String(config.clientId))) throw new Error('Configure the Bungie application first.');
  const redirect = new URL(config.redirectUri), origin = new URL(config.origin);
  if (origin.origin !== config.origin || origin.protocol !== 'https:' || redirect.origin !== origin.origin || redirect.pathname !== callbackPath(config) || redirect.search || redirect.hash || redirect.username || redirect.password || origin.username || origin.password || location.origin !== origin.origin) throw new Error('Bungie callback must use the configured HTTPS origin and exact callback path.');
  if(config.authBackend)backendOrigin(config.authBackend);
  return redirect;
}
export function connect(config) {
  validateConfig(config);
  if(config.authBackend)return connectBackend(config);
  const cleanup=disconnect({waitForServer:false});
  if(cleanup)return cleanup.catch(()=>{}).then(()=>launchPublic(config));
  return launchPublic(config);
}
function launchPublic(config) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  // State expires after ten minutes and is consumed once by the callback.
  sessionStorage.setItem(PENDING, JSON.stringify({state, expiresAt:Date.now()+600000, redirectUri:config.redirectUri, clientId:String(config.clientId)}));
  const url = new URL('https://www.bungie.net/en/OAuth/Authorize');
  url.search = new URLSearchParams({client_id:String(config.clientId),response_type:'code',state,redirect_uri:config.redirectUri});
  location.assign(url.href);
}
// An explicit local selection can be remembered without fetching account data.
export function selectAccount(account) {
  const accountKey = typeof account === 'string' ? account : `${account?.membershipType}:${account?.membershipId}`;
  const session = getSession();
  if (!session || !session.memberships?.some(m => `${m.membershipType}:${m.membershipId}` === accountKey)) throw new Error('Choose an account belonging to this connection.');
  if(session.kind==='backend'){
    if(session.selectedAccount===accountKey)return;
    cancelOperations();
    // A queued selection is cancellable, so a later Disconnect always invalidates it.
    const operation=operationSignal();
    return backendLock(()=>{
      operation.assertCurrent();assertEpoch(session.epoch);const current=readBackendSession();
      if(!current)throw new Error('Connect Bungie again.');
      const epoch=crypto.randomUUID();setEpoch(epoch);writeBackendSession({...current,selectedAccount:accountKey,epoch});
    },operation.signal).finally(()=>operation.dispose());
  }
  if (session.selectedAccount !== accountKey) cancelOperations();
  sessionStorage.setItem(SESSION,JSON.stringify({...session,selectedAccount:accountKey}));
}
// Cross-save chooses one matching primary type; ambiguity requires a UI choice.
export function selectMembership(memberships) {
  const overrides = new Set(memberships.map(m => m.crossSaveOverride).filter(n => n > 0));
  if (overrides.size === 1) { const matches = memberships.filter(m => m.membershipType === [...overrides][0]); return matches.length === 1 ? matches[0] : null; }
  return overrides.size === 0 && memberships.length === 1 ? memberships[0] : null;
}
// This exported read is called only by an explicit action or authorized callback.
export async function getMemberships(config, {signal} = {}) {
  validateConfig(config);
  const operation = operationSignal(signal);
  try {
    const session = await ensureAccess(config,{signal:operation.signal});
    if(!session)throw new Error('Reconnect to Bungie before reading memberships.');
    const response = await createClient(config, {signal:operation.signal, token:session.accessToken}).request('/Platform/User/GetMembershipsForCurrentUser/');
    if (!Array.isArray(response.destinyMemberships)) throw new Error('Bungie did not return Destiny memberships.');
    // Destiny IDs are distinct from the Bungie user ID and remain decimal strings.
    const memberships = response.destinyMemberships.filter(m => [1,2,3,4,5,6].includes(m.membershipType)).map(m => ({...m,membershipId:String(m.membershipId)}));
    if (memberships.some(m => !/^\d+$/.test(m.membershipId))) throw new Error('Bungie returned invalid Destiny membership IDs.');
    const selected = selectMembership(memberships);
    operation.assertCurrent();
    if(session.kind==='backend'){
      await backendLock(()=>{
        operation.assertCurrent();assertEpoch(session.epoch);const current=readBackendSession();
        if(!current)throw new Error('Connect Bungie again.');
        writeBackendSession({...current,bungieMembershipId:String(response.bungieNetUser?.membershipId||current.bungieMembershipId||''),memberships,selectedAccount:current.selectedAccount??(selected?`${selected.membershipType}:${selected.membershipId}`:null)});
      },operation.signal);
    }else sessionStorage.setItem(SESSION, JSON.stringify({...session, bungieMembershipId:String(response.bungieNetUser?.membershipId || session.bungieMembershipId || ''), memberships, selectedAccount:selected ? `${selected.membershipType}:${selected.membershipId}` : null}));
    return memberships;
  } finally { operation.dispose(); }
}
export async function handleCallback(config) {
  const params = new URLSearchParams(location.search);
  // Scrub secrets even if configuration, origin, state or provider denial is invalid.
  history.replaceState(null, '', location.pathname);
  const pending = read(PENDING); sessionStorage.removeItem(PENDING);
  validateConfig(config);
  const registeredPath = new URL(config.redirectUri).pathname;
  // Static hosting canonicalizes this HTML page to its exact extensionless alias.
  // The registered redirect URI remains unchanged for state and token exchange.
  if (![registeredPath, registeredPath.slice(0, -5)].includes(location.pathname)) throw new Error('Unexpected Bungie callback destination.');
  if (!pending || pending.expiresAt <= Date.now() || pending.redirectUri !== config.redirectUri || pending.clientId !== String(config.clientId) || !pending.state || params.getAll('state').length !== 1 || params.get('state') !== pending.state) throw new Error('Bungie sign-in state is missing, expired or mismatched. Connect again.');
  if (params.has('error')) throw new Error('Bungie sign-in was denied. Connect again when ready.');
  if (params.getAll('code').length !== 1 || !params.get('code')) throw new Error('Bungie did not return a sign-in code. Connect again.');
  if((pending.authBackend||null)!==(config.authBackend||null))throw new Error('The sign-in backend changed. Connect again.');
  if(config.authBackend){
    assertEpoch(pending.epoch);const operation=operationSignal();
    try{
      const result=await brokerRequest(config.authBackend,'/exchange',{body:{code:params.get('code')},signal:operation.signal});
      operation.signal.throwIfAborted();
      await backendLock(()=>{assertEpoch(pending.epoch);writeBackendSession({...result,kind:'backend',epoch:pending.epoch,backendUrl:config.authBackend,clientId:String(config.clientId),redirectUri:config.redirectUri,memberships:[],selectedAccount:null});},operation.signal);
      return await getMemberships(config,{signal:operation.signal});
    }finally{operation.dispose();}
  }
  // Consume state before exchange: retries require a new deliberate connection.
  const operation = operationSignal();
  try {
    const result = await createClient(config, {signal:operation.signal}).request('/Platform/App/OAuth/token/', {method:'POST',form:true,body:new URLSearchParams({client_id:String(config.clientId),grant_type:'authorization_code',code:params.get('code'),redirect_uri:config.redirectUri})});
    if (!result.access_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 60) throw new Error('Bungie sign-in code expired or exchange failed. Connect again.');
    operation.signal.throwIfAborted();
    sessionStorage.setItem(SESSION, JSON.stringify({accessToken:result.access_token,expiresAt:Date.now()+(Number(result.expires_in)-60)*1000,bungieMembershipId:String(result.membership_id || ''),memberships:[],selectedAccount:null}));
    return await getMemberships(config, {signal:operation.signal});
  } finally { operation.dispose(); }
}

// The backend branch preserves the existing callback and one-time, tab-bound OAuth state.
async function connectBackend(config) {
  try{await disconnect({waitForServer:false});}catch{/* Local cancellation is complete even if a prior server session could not be deleted. */}
  const state=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
  await backendLock(()=>{
    const epoch=crypto.randomUUID();setEpoch(epoch);removeBackendSession();
    sessionStorage.setItem(PENDING,JSON.stringify({state,epoch,expiresAt:Date.now()+600000,redirectUri:config.redirectUri,clientId:String(config.clientId),authBackend:config.authBackend}));
  });
  const url=new URL('https://www.bungie.net/en/OAuth/Authorize');
  url.search=new URLSearchParams({client_id:String(config.clientId),response_type:'code',state,redirect_uri:config.redirectUri});location.assign(url.href);
}
// Renewal is requested only by an explicit account read/import, never by getSession.
export async function ensureAccess(config,{signal}={}) {
  validateConfig(config);const session=getSession();
  if(!session)throw new Error('Reconnect to Bungie before refreshing inventory.');
  if(session.kind!=='backend'){if(config.authBackend)throw new Error('Connect Bungie again to enable the persistent connection.');return session;}
  if(session.backendUrl!==config.authBackend||session.clientId!==String(config.clientId)||session.redirectUri!==config.redirectUri)throw new Error('Bungie connection settings changed. Connect again.');
  if(session.expiresAt>Date.now()+30000)return session;
  const operation=operationSignal(signal);
  // Provider reads occur outside the lock; only generation-checked merging acquires it.
  try{
    const result=await brokerRequest(config.authBackend,'/refresh',{sessionKey:session.sessionKey,signal:operation.signal});
    return await backendLock(()=>{
      operation.assertCurrent();assertEpoch(session.epoch);const current=readBackendSession();
      if(!current||current.sessionKey!==session.sessionKey)throw new DOMException('Account connection changed.','AbortError');
      const next={...current,...result,refreshExpiresAt:Math.min(current.refreshExpiresAt,result.refreshExpiresAt)};writeBackendSession(next);return next;
    },operation.signal);
  }catch(error){
    // Expired provider sessions are removed only if this connection still owns the epoch.
    if(error.reconnect)await backendLock(()=>{assertEpoch(session.epoch);setEpoch(crypto.randomUUID());removeBackendSession();});
    throw error;
  }finally{operation.dispose();}
}
