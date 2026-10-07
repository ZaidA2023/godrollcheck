import {callbackPath} from './callback-path.js';
// Public application metadata contains no account token or client secret.
export async function loadConfig() {
  const response = await fetch(new URL('../../account-config.json', import.meta.url));
  if (!response.ok) throw new Error('Bungie connection is not configured for this site.');
  const raw = await response.json();
  // Validate deployment prefixes before producing even a recovery link.
  callbackPath(raw);
  const origin = globalThis.location.origin;
  const config = origin === raw.development?.origin ? {...raw, ...raw.development} : raw;
  const registeredPath=callbackPath(config);
  if (!config.apiKey || !/^\d+$/.test(String(config.clientId))) throw new Error('The Bungie application settings are incomplete.');
  if (origin !== config.origin || !origin.startsWith('https://')) {
    const error = new Error('Open the HTTPS site to connect Bungie.');
    const secure=new URL(raw.basePath??'/',raw.origin);
    if(secure.origin!==raw.origin)throw new Error('The configured website origin is invalid.');
    error.secureUrl = secure.href;
    throw error;
  }
  // The registered destination is fixed; incoming query parameters are separate.
  const redirect = new URL(config.redirectUri);
  if (redirect.origin !== origin || redirect.pathname !== registeredPath || redirect.search || redirect.hash) throw new Error('The Bungie callback configuration is invalid.');
  return {apiKey: config.apiKey, clientId: String(config.clientId), origin, basePath:config.basePath??'/', redirectUri: redirect.href};
}

// Validate the exact recommendation bytes that were independently audited.
export async function loadVerifiedTables(manifest, map, {signal} = {}) {
  if (!map?.identitySubsetApproved || map.schemaVersion !== 1) throw new Error('The Bungie identity mapping has not been approved.');
  const ids = [...new Set([...Object.values(manifest.tabs).filter(t => t.kind === 'weapon' || t.id === 'exotic-weapons').map(t => t.id), 'perks', 'origin-traits'])];
  // Only audited recommendation tables enter comparison; ordinary browsing stays independent.
  const tables = await Promise.all(ids.map(async id => {
    const response = await fetch(new URL(`../../data/${encodeURIComponent(id)}.json`, import.meta.url), {signal});
    if (!response.ok) throw new Error(`Could not read the saved recommendations for ${id}.`);
    const bytes = await response.arrayBuffer();
    // Hash response bytes, not reserialized JSON, to preserve the audit fingerprint.
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
    if (hex !== map.siteDataSha256?.[`${id}.json`]) throw new Error('The spreadsheet snapshot changed. Its Bungie mapping must be audited again before grading gear.');
    return JSON.parse(new TextDecoder().decode(bytes));
  }));
  // Mark usable only after every required file has passed; partial success is insufficient.
  map.integrityVerified = true;
  return tables;
}
