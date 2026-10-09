# GodRollCheck

Public website: https://zaida2023.github.io/godrollcheck/

Destiny 2 weapon recommendations and local inventory roll checking. Available owned perks count whether selected or not. Legendary weapons rank by matched recommendation columns; exotics remain ungraded.

## Bungie application settings

- Website: https://zaida2023.github.io/godrollcheck/
- Redirect URL: https://zaida2023.github.io/godrollcheck/oauth-callback.html
- Origin Header: https://zaida2023.github.io
- OAuth client type: Confidential with the configured Cloudflare token broker; read Destiny inventory permission only.

Changing the existing application's single callback moves sign-in here; the previous host's sign-in will stop working. This origin has separate saved browser inventory from the previous host. Connect Bungie and Refresh and Save here. Player snapshots and tokens are never committed to this repository. Browser storage shares the origin with other trusted sites belonging to this GitHub account.

## Publishing updates

GitHub Pages publishes main at the repository root. Update the static files and push main. In the original local EndgameSite project, run scripts/prepare_github_pages.py to regenerate its ignored .github-pages checkout, then commit and push that checkout. It contains only published runtime assets, not the original project history. The public Bungie API key/client ID are intentional browser application configuration.
