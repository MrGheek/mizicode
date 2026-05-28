---
name: Bolt.diy iframe embedding
description: Why boltDiyUrl can't be shown in an iframe and how the dashboard handles it
---

Bolt.diy runs behind nginx on the VastAI GPU instance (port 5180). Nginx sets `X-Frame-Options: SAMEORIGIN` which causes browsers to silently block the iframe content (black screen). The iframe's `onLoad` event still fires (HTTP response received), so the 8-second fallback timer never triggers — resulting in a permanently black preview tab.

**Fix (preview-tab.tsx):**
- `resolveDefaultUrl` no longer falls back to `boltDiyUrl` — so no URL is loaded in the iframe when only boltDiyUrl is present
- When `noUrl && boltDiyUrl`, show an "Open Bolt.diy" card with an external link instead of a blank iframe
- The `:5180` port chip already has `newTab: true` (correct; opens in new tab)
- Port 3000 (`previewUrl`) is the user's own app and can still be embedded in the iframe

**Why:**
Bolt.diy is an IDE (not the user's app), and IDEs routinely block framing for security. Embedding it was never the right UX — opening it in a new full tab is.

**How to apply:**
If Bolt.diy ever needs to be embedded, the fix is in nginx config on the VM: add `add_header Content-Security-Policy "frame-ancestors https://mizicode.fly.dev"` to the nginx site config in `onstart.sh`.
