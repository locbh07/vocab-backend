# Free learning and content protection

Learning access no longer depends on a paid plan, expiry date, trial or exam code.
Existing login requirements, administrative permissions, upload moderation, XP progression
and abuse limits remain. YouTube imports and transcript writes require a valid user.
Historical payment records and webhook handling remain available for reconciliation;
new Stripe checkout, trial activation and manual payment requests return HTTP 410.
Existing external Stripe subscriptions are not automatically cancelled by this code change.

Deploy the backend and frontend together (backend first is supported). No migration or
environment change is required. No production data is modified by this release.

The frontend requests `X-Content-Codec: daisuki-content-v1`. Successful JSON responses
from learning routes use `{ codec, iv, payload }`: AES-256-GCM, a fresh 12-byte IV,
AAD `daisuki-content-v1`, and base64 ciphertext followed by its 16-byte authentication tag.
The codec key is SHA-256 of `daisuki-content-envelope-v1`. It is intentionally public;
this layer deters casual copying from Network previews, not a determined scraper.
Errors and non-learning routes keep their original format. Legacy clients can still
request plain JSON. HTTPS, authentication, rate limits and pagination are the actual
protection boundaries. Both response formats receive the same rate limits.
Learning responses use `private, no-store` and vary on the codec header.

Production frontend builds deter F12, inspection shortcuts and View Source while the
page has focus. The detector adapted from mirai-menkyo pauses API calls and hides the
app when it detects docked tools or emulation. Geometry is only a heuristic: browser
sidebars may trigger it, and detached tools may evade it. Closing the panel resumes
access. Development builds stay inspectable. Browser menus, shortcuts outside the
page, extensions and direct HTTP clients cannot be controlled by website JavaScript.
PDF/media URLs are not JSON and are not encrypted by this codec.

Validation: `npm run build`, then
`node --test tests/premium-security.test.cjs tests/free-content.test.cjs`.
The codec interoperability test expects the sibling `vocab-frontend` checkout.
