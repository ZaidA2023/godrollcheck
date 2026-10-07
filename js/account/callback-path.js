// Only an explicit deployment prefix changes the fixed OAuth callback filename.
export function callbackPath(config) {
  const basePath=config?.basePath??'/';
  if(typeof basePath!=='string'||!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath))throw new Error('The configured website base path is invalid.');
  return `${basePath}oauth-callback.html`;
}
