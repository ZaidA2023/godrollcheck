import {loadConfig} from './account/config.js';
import {handleCallback} from './account/auth.js';
const status = document.getElementById('callback-status');
try {
  const config = await loadConfig();
  await handleCallback(config);
  status.textContent = 'Connected. Returning to My Loadout. Refresh and Save when ready.';
  location.replace('./#/loadout');
} catch (error) {
  // Do not expose provider text, token exchange payloads or the query URL.
  history.replaceState(null, '', location.pathname);
  status.textContent = error.message || 'Bungie sign-in failed. Return to My Loadout and connect again.';
}
