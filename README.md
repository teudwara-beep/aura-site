# AURA — Admin-Managed Video & Photo Site

AURA is a Node.js web app with a public viewer site and an administrator control room. In production, set `ADMIN_HOST` so the public site stays on your main domain and the admin panel is served only from a separate subdomain such as `admin.example.com`. Viewers can browse published videos, video collections and photo collections, search and filter categories, and keep browser-local likes/watch history/watch-later lists. Only the administrator can sign in, upload files, publish/unpublish content, manage collections and categories, and edit homepage settings.

## Project structure

```text
aura-site-project/
├── assets/favicon.svg      # AURA tab icon
├── css/styles.css          # Site styles
├── js/app.js               # Viewer UI and admin panel interactions
├── data/                   # SQLite catalog and admin sessions (created at runtime)
│   ├── category-images/    # Uploaded category images (created at runtime)
│   └── gallery-images/     # Uploaded photo collection images (created at runtime)
├── storage/videos/         # Uploaded MP4/WebM files (created at runtime)
├── scripts/check-html.js   # Static markup checks
├── scripts/bunny-check.js  # Bunny API mock integration check
├── scripts/smoke.js        # Optional end-to-end API/media check
├── scripts/player-check.js # Player event/state regression checks (Node DOM doubles)
├── scripts/removal-check.js # Removal form and admin UI checks
├── scripts/backup.js       # Full backup, checksum verification and safe restore
├── index.html
├── server.js               # API, admin authentication, video storage and static server
├── Dockerfile              # Production container for CapRover
├── captain-definition      # CapRover build instructions
├── .env.example
└── package.json
```

## Run locally

Use Node.js 22.13 or newer. Copy `.env.example` to `.env`, then set a private administrator email, a password with at least 12 characters, and a random session secret with at least 32 characters. Do not commit `.env` or uploaded videos.

```bash
cp .env.example .env
# Edit .env and replace the example secrets.
npm start
```

Open the public site at `http://127.0.0.1:4180` and the admin panel at `http://admin.localhost:4180`. Keep `HOST=127.0.0.1` and `ADMIN_HOST=admin.localhost` in your private `.env`. The admin address uses the same local server and port; you do not need to buy or configure a domain for local testing. The server also uses `admin.localhost` when `ADMIN_HOST` is blank in development. Restart `npm start` after editing `.env`. Uploads accept MP4 and WebM. Set `MAX_UPLOAD_MB` to change the server limit and `REQUEST_TIMEOUT_MINUTES` for slow connections; your reverse proxy must allow the same upload size/time. SQLite data and category images are stored under `data/`; video files are stored under `storage/videos/`.

On Windows PowerShell, use `npm.cmd run check` and `npm.cmd start` if `npm.ps1` is blocked by the local execution policy.

## Optional Bunny Stream setup (works before buying a VPS)

1. In your Bunny dashboard, create a **Stream Video Library** (a plain Storage Zone does not provide the video player). Find the numeric **Library ID** and its private **Library API Key** in Stream → your library → API.
2. In Stream → your library → Security, turn on **Embed view token authentication** and copy its separate **Token Security Key**. For local testing, keep Allowed Domains empty; when your public and admin domains are ready, allow both exact hostnames. Do not turn on Pull Zone CDN token authentication unless you also sign thumbnail/preview URLs separately.
3. Copy `.env.example` to your private `.env`; set `BUNNY_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_TOKEN_KEY`, and, optionally, `BUNNY_PULL_ZONE` using the full `name.b-cdn.net` pull zone hostname. Never put these private values in JavaScript, this project ZIP, GitHub, or chat. Restart Node after changing `.env`.
4. Run `npm run test:bunny` (or `npm.cmd run test:bunny` in PowerShell). This tests a fake Stream API, not your live account. Start the site on your own computer, open `http://admin.localhost:4180`, and upload one short MP4 in **Admin → Videos**. The browser sends resumable chunks to Bunny directly, so the video file does not use your VPS disk. Test preview and publish once encoding reaches ready. Verify public playback at `http://127.0.0.1:4180`.

Existing videos stored on disk keep playing from disk. New admin uploads use Bunny when the three required `BUNNY_*` values are configured; removing the config later breaks playback for Bunny videos. Replacing a published video creates a draft during encoding; publish it again when Bunny has finished. Removing a video from Admin deletes its associated Bunny object. Admin-only previews use Bunny's embedded player, and published Bunny videos use the same responsive player with its quality options; local videos keep AURA's original player. Bunny thumbnails and short previews need `BUNNY_PULL_ZONE` and compatible Pull Zone/Allowed Domains security settings. The Bunny player handles mobile playback; AURA stores watch position through its player events when its control script is available. Bunny does not use AURA's separate mini-player control.

**Backups:** `npm run backup` stores the SQLite catalog, site images, custom video thumbnails, and locally stored video files. It stores Bunny video IDs in SQLite, but **does not copy Bunny video bytes**. Keep a separate export/recovery plan for your Stream Library; restore the same Library ID and API/token keys with the catalog. Video storage fees and encoding finish time depend on your Bunny account. Test one upload on the actual account before relying on it.

In **Admin → Categories**, use **Add category** or the pencil icon to add/replace an optional JPG, PNG or WebP image. Files up to 20 MB can be selected; the browser resizes files over 3 MB or wider/taller than 1600 pixels before uploading, and the server accepts a final image up to 3 MB. Wait for the preview to say **Ready to upload**, then press **Save**. If the category name saves but the image upload fails, the dialog explains this and **Save** retries the image. Use **Remove image** in the edit dialog to return to the default gradient. These images are stored in `data/category-images/`, survive restarts, and are included in full backups; keep `data/` when updating the project.

In **Admin → Photo collections**, create a collection with a title and optional description. Select up to 20 JPG, PNG or WebP photos at once, then click **Upload selected photos**. A source file can be up to 20 MB; the browser resizes those over 8 MB, and the server enforces 8 MB per uploaded image. Add up to 100 images per collection. Collections start as private drafts; **Publish** makes them visible in the public **Photos** page. Click an admin image for a preview; remove individual images, edit collection details, unpublish or delete the whole collection from the same panel. Removing the last image makes a published collection private again. Public visitors can open albums in pages of 24 and view photos in a lightbox, with next/previous buttons, arrow keys or a swipe on phones. If a public contact email is configured, the collection page links to it for photo concerns. Keep `data/gallery-images/` when updating the project and use the full backup command; catalog export does not include photo files. New JPG, PNG and WebP uploads are checked and stripped of embedded camera/location/text metadata on the server. Existing uploads need the one-time cleanup described below.

In **Admin → Video collections**, create a titled collection, pick from your uploaded videos, and move them up or down to choose the viewing order. You can add up to 100 existing videos to each collection. Draft and private videos remain visible only in the admin panel; at least one published video must be present before the collection can be published. The public **Video collections** page shows only published, uploaded videos, with 24 collections per page. If all videos become unavailable, the collection disappears from the public page until a published video is added or restored. Removing a video from a collection or deleting the whole collection does not remove the uploaded video. Deleting a video does remove its collection references automatically.

**Views:** A collection view counts when a visitor opens its detail page; a photo view counts when an image loads in the full-size viewer. The existing video counter still counts playback separately. A host-only viewer cookie limits each video, collection or photo to one counted view per browser in a 30-minute window while the server runs. Admin previews and repeat taps in that window do not add views. Public pages display collection counts and photo counts; the admin dashboard and collection panels show the individual and total counts. These are approximate view counts, not unique people or third-party analytics. New collection counters start at zero when upgrading an existing database, and all counts are included in database backups.

In **Admin → Videos**, assign up to eight short comma-separated tags while uploading a new video or editing its details. Tags are optional. They make videos searchable and clickable from the description on the watch page. The **You Might Also Like** sidebar ranks all published videos by shared tags, then category, with small recency/popularity tie-breakers. Videos without tags still receive category-based recommendations. No draft, private, deleted or unuploaded video is recommended. Tags are saved in SQLite and included in full backups; existing databases get an empty tags column automatically on startup. Viewer likes and history stay on the viewer's device; they are not uploaded to the server to make these suggestions.

Use the **Change thumbnail** action in **Admin → Videos** after a video file is uploaded. Choose a JPG, PNG or WebP image (up to 20 MB); the browser resizes and converts it to a small JPEG, then the server strips embedded metadata. The custom image appears on video cards and as the local player poster, is stored in `data/video-thumbnails/`, and is included in full backups. For Bunny-hosted videos, AURA sends the image to Bunny from the server without exposing the private API key to the browser. **Use automatic** removes the custom image and restores Bunny's generated thumbnail or AURA's automatic local video-frame preview. Existing databases receive the nullable thumbnail column automatically on startup.

In **Admin → Ads**, configure two optional ExoClick banner/native placements: one after six cards on the homepage and one below the watch page description. Enter numeric desktop/mobile zone IDs from your ExoClick publisher account, then enable each placement and save. Each device shows only its own configured zone; ads remain off by default. The administrator can turn each placement off without removing its IDs. The third-party ad tag is only loaded on the public site after a viewer passes the age screen and reaches a page with an enabled zone. Site visitors may block ads in their browsers. ExoClick approval, live creative delivery, earnings and policies must be checked in your own publisher dashboard; zone IDs alone do not create an account. Review the site's privacy notice for your audience and the provider's privacy terms before enabling ads.

On a production server behind a loopback reverse proxy, set `REPORT_TRUST_PROXY=1` only when the proxy overwrites `X-Forwarded-For` with the real visitor IP. The admin login and report rate limits then apply per visitor instead of treating everyone behind that proxy as one connection.

Opening saved video lists and video pages checks the current public catalog, so unpublished or removed videos no longer open from an older browser tab's cache. Search suggestions include categories, and the full video search still runs on the server when Enter is pressed.

Run code checks with:

```bash
npm run check
npm run test:player
npm run test:mobile-preview
npm run test:catalog
npm run test:collections
npm run test:removal
npm run test:bunny
```

With `ffmpeg` installed, run `npm run smoke` to exercise admin login and isolation, ad-setting permissions/validation and persistence, video tag validation/search/recommendations and migration, real MP4/WebM uploads, draft previews, published playback and seeking, photo and video collection draft isolation, ordering, view counts and deletion, featured videos, filtering, 24-item pagination, session persistence, concurrent video edits, storage checks, removal requests, and a full backup/restore round-trip. This creates and removes its own temporary database and test media. `test:player` verifies event cleanup, cancelled autoplay after navigation, keyboard seeking, mobile double-tap ±10-second seeking and single-tap playback, accessible play/pause labels, playback-error retry, clipboard fallback and mini-player history using Node DOM doubles; it does not render a browser or decode video. `test:mobile-preview` checks touch preview playback and cleanup on scroll, tab hide, and page navigation using Node DOM doubles. `test:catalog` checks stale video cache and navigation races. `test:collections` checks client routes and collection/photo view calls. `test:removal` checks the public request form, escaped private inbox and admin unpublish action using the same Node DOM doubles.

## Admin and viewer features

- The environment-configured email is the only administrator. Admin passwords are salted with scrypt; only hashed random session tokens are stored in SQLite and the session cookie is HttpOnly, Secure in production, and host-only. Sessions survive a restart when credentials stay the same; changing the password or email revokes the previous access.
- When `ADMIN_HOST=admin.example.com` is configured, that hostname serves the admin panel at `/`; admin API routes reject requests sent to the public hostname. The public site hides admin sign-in links. The production server requires `ADMIN_HOST` to be set.
- Upload, edit, publish/unpublish, delete, category, and site-settings endpoints require the admin session on the server.
- New uploads are drafts by default. The administrator can preview a draft, replace its file, retry a failed upload on the same draft, publish after uploading, or choose immediate publication. A playable first frame must load in the upload preview before the upload button becomes available. Metadata edits on existing videos are saved only after the replacement file uploads successfully. Cancelling an in-progress upload stops the request; check the draft before retrying because the server may already have received the file.
- Uploads are limited by `MAX_UPLOAD_MB`, allow MP4/WebM container signatures, and remove rejected temporary files. Use codecs supported by your viewers' browsers; a valid container alone cannot guarantee codec compatibility.
- Public catalog and video file routes expose only published videos. Video playback supports byte ranges for seeking and revalidates cached files after replacement. Views count when playback starts, with a host-only cookie to avoid repeat counts from the same browser within 30 minutes.
- The public video grid uses server-side pages of 24; search, category, trending, and new-release filters run on the server, and viewers can continue with a minimal **Load more** control.
- Continue watching appears only for partially watched videos when the catalog has more than one video. Finished videos stay in History, short clips resume from their saved position, and viewers can hide the row or switch it back on under **Settings → Playback** without deleting History.
- Admin controls include catalog export, content status, private preview and file replacement, categories with optional images, separate photo and video collections, per-photo and per-collection views, uploaded video storage size, site name/tagline, homepage announcement, public contact email, and featured video. The selected featured video must be published and uploaded; without it, the homepage hero remains hidden.
- **Admin → Site settings** saves the name, tagline, announcement, contact email and featured video in SQLite. The name appears on the public site, age screen, cards, legal pages, browser title, metadata and web app manifest; the tagline appears on the homepage and in metadata. Both HTML and the manifest are generated from saved settings on each request. Existing open browser tabs must be refreshed to see a change made elsewhere. Changing the site name does not change domain names, administrator credentials or the image used for the favicon.
- On phones, video cards show their options button without hovering. The player's **More player controls** button gives access to skip, Picture in picture, mini-player and theater controls; unsupported browser controls may still depend on the device. Admin tabs wrap and video/category rows show their actions as cards. On narrow screens the header theme shortcut moves to **Settings → Appearance**.
- Cards play a muted preview on desktop hover where motion and data-saving preferences allow it. Touch screens show a small **Preview** button on each card for a muted, on-demand inline preview; tapping the rest of the card opens the full video. Only one touch preview plays at a time and it stops on scroll, navigation or tab hide. The player streams the single uploaded file, so no quality picker or extra transcoded versions are shown.
- Visible video cards and admin table rows show a frame captured from the uploaded video instead of a color placeholder. Frames load on demand, two videos at a time, and are reused during the current page visit. Private drafts use the admin-only preview route. If a browser cannot decode a video or the file is unavailable, its color placeholder remains.
- Likes, watch history, and watch-later preferences are stored in the viewer's browser.
- The player clears its listeners and timers when leaving a video; automatic next-video playback is cancelled on navigation. The mini player saves progress and finished state into the same History. Playback errors offer a retry button; share links offer manual copying when clipboard access fails.
- Upload metadata and file selection are locked while sending a file. The server rejects simultaneous replacement/edit/delete operations on the same video instead of racing them.
- Admin videos support title/category search, published/draft/private/no-file filters and pages of 24. **Storage** checks for missing video files, category images and collection photos, counts unreferenced media and shows available video disk space. This check does not inspect codecs or delete files. Refresh it after active uploads finish.

## Video removal requests

On a published video's page, viewers can select **Report**; **Legal → Request video removal** and the age screen also accept a video link or ID. The form asks for a reason (copyright, privacy/consent, safety or other), a name, a reply email and a description. It shows a reference after submission. Duplicate pending requests from the same email, video and reason share the original reference. Submissions do **not** remove a video automatically.

Only the signed-in administrator on the admin hostname can view **Removal requests**. The panel shows a pending count, filtered/paged requests and a private review note. The administrator can preview the video, mark a request as reviewing, resolve or decline it, or select **Unpublish video** to remove public access immediately and resolve the request. Unpublished files remain privately previewable until the administrator decides to delete them. Request records remain after a video is deleted for review; the public has no request lookup API. Notes and contact details are never included in the public catalog or catalog export. No email is sent automatically; use the contact email on a request to reply manually and check the admin inbox regularly.

Public submissions have size/field validation, duplicate detection, same-origin protections and per-email/request-connection rate limits. Behind a loopback reverse proxy, set `REPORT_TRUST_PROXY=1` **only if** your proxy overwrites `X-Forwarded-For` with the real client address; otherwise keep it off and set limits at the proxy edge. The `.env.example` contains the setting. Set a working **Admin → Site settings → Public contact email** before launch so people can contact you about an older/missing video or send a formal notice. The web form is an intake/review tool; formal copyright notice requirements vary by jurisdiction. For U.S. notices see [the U.S. Copyright Office overview](https://www.copyright.gov/512/). Configure your actual notice/contact and privacy processes for the countries where the site operates.

## Full backup and restore

Run these commands from the project folder on the computer/server holding your data. No additional npm packages are needed. Backups include a consistent SQLite snapshot, video collections, views, every referenced uploaded video, category image, collection photo and custom video thumbnail, removal request records with names and email addresses, and SHA-256 checksums. Protect backups as private data. They exclude `.env`, admin passwords and sign-in sessions. Your environment-configured administrator is recreated at startup after restoration.

```bash
# Create a new timestamped folder under backups/:
npm run backup

# Or choose a NEW destination folder on a backup disk:
npm run backup -- /path/to/aura-backup

# Verify the database and every video file:
npm run backup:verify -- /path/to/aura-backup

# Restore to a NEW folder; existing folders are always refused:
npm run restore -- /path/to/aura-backup /path/to/aura-restored
```

Before backing up, allow uploads, replacements and deletions to finish. The SQLite snapshot is consistent even while the site serves viewers. If a referenced video is removed while it is being copied, the backup fails and removes its incomplete output: stop the server and retry. Ensure enough free space for all videos plus the database. Keep the **whole backup folder**, including `manifest.json`, on a separate disk or private backup service. Checksums detect corruption, not malicious changes; restore only your own trusted backups.

Restore never overwrites the live site. On success it prints new `DATA_DIR` and `VIDEO_DIR` values. Stop the server, set those two values in your private `.env`, retain your own admin credentials/session secret, then restart. Sign in, check **Admin → Storage**, and play a restored video before retiring the previous data. Protect your `.env` separately and do not upload backups or restored videos to GitHub. Default `backups/` and `restored/` directories are ignored by Git; use private locations outside the repository for custom paths.

The SQLite snapshot uses [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html), supported by the project's Node.js minimum version.

## Updating an existing installation

Stop the Node server and make a private backup of your existing database and videos before replacing source files. Extract the full project into a separate folder, or apply the supplied update ZIP **inside your existing project root**. The update ZIP contains source files only and does not replace `.env`, the database or uploads. Keep your existing environment values. Run `npm run check`, restart with `npm start`, and refresh both browser tabs. Missing ad settings, video tags and thumbnail columns are added automatically; no new npm dependencies are needed. On Windows PowerShell where `npm` is blocked by execution policy, use `npm.cmd`.

For photos uploaded **before version 1.7.1**, run this after replacing the source and before restarting the server. With the server stopped, create a private full backup, then:

```bash
node scripts/sanitize-existing-images.js --check
node scripts/sanitize-existing-images.js --apply
```

This checks the existing category and photo collection images, removes EXIF/XMP and text metadata, and updates saved photo sizes. If it reports an error, check the referenced missing or damaged image; do not publish it until you replace it. Images already fetched or cached by someone before cleanup cannot be recalled. Uploaded **video** files may contain their own camera/location metadata; remove it before uploading.

## GitHub and hosting

Push the project source to GitHub, but keep `.env`, `data/`, and `storage/videos/` private. GitHub Pages can host static files only and cannot run this backend or securely store admin uploads. A deployed version needs a Node.js host, HTTPS, persistent SQLite/media storage (or object storage), backups, and both the main domain and admin subdomain attached to the same Node.js service so the API stays same-origin for each interface.

Video uploads use local disk unless Bunny Stream is enabled in the private environment. You can configure and test Bunny on localhost before buying a VPS. Before public launch, choose persistent hosting for SQLite, site images and any older local videos. **Export catalog** exports metadata only; use full backups for local files and a separate plan for Bunny files. Do not copy a running SQLite file by itself because recent changes may still be in its WAL file.

### Admin subdomain deployment

After buying your domain, replace `example.com` with your domain and:

1. Add both the main domain (and `www` if used) and `admin.example.com` to the same Node.js app at your hosting provider. Configure DNS records using the host's instructions; the `admin` record must route to that app too.
2. Set `NODE_ENV=production`, `ADMIN_HOST=admin.example.com`, and the required admin credentials/session secret in the host's private environment settings. Do not include `https://` or a path in `ADMIN_HOST`.
3. Enable HTTPS for both hostnames. Visit the main domain for viewers and `https://admin.example.com` for the admin login.

The admin session cookie is scoped to the admin hostname and is not shared with the public site. Do not enable broad cross-origin API access; the admin UI and API use the same admin hostname.

### CapRover deployment

The repository already includes `Dockerfile` and the root `captain-definition`. In CapRover:

1. Set **Container HTTP Port** to `4180` and keep **Instance Count** at `1` because SQLite is a single-node database.
2. Add one persistent directory/volume with container path `/app/persistent`. Without it, the SQLite catalog and uploaded site images disappear on the next deployment. Back up this volume separately.
3. Add private environment variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `ADMIN_HOST=admin.yourdomain.com`, plus the four optional Bunny values. The Docker image already sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=4180`, `DATA_DIR=/app/persistent/data`, and `VIDEO_DIR=/app/persistent/videos`.
4. Attach both `yourdomain.com` and `admin.yourdomain.com` to this same app. Enable HTTPS and **Force HTTPS** for both. Set the Bunny Allowed Domains to these exact hostnames without `https://`.
5. In CapRover Git deployment, use repository `github.com/teudwara-beep/aura-site` and branch `main`. For a public repository, CapRover accepts any nonempty password value; do not paste a GitHub Personal Access Token. Add the CapRover webhook to the GitHub repository only after keeping its URL private.

Changing VPS or domain does not require editing application code. Update CapRover environment variables, domain/DNS and Bunny Allowed Domains, then restart/deploy. Preserve `/app/persistent` during every update.

### Security before public launch

- Keep `.env`, SQLite data, uploads and complete backups private, outside any web server's static directory and outside GitHub. Allow only the Node process and backup operator to read them. Backups contain visitor report names and email addresses; keep them private and delete them according to your retention policy.
- Install a supported Node.js LTS version with current security patches. Set a long random `ADMIN_PASSWORD` and a different random `SESSION_SECRET`; keep `NODE_ENV=production`, `ADMIN_HOST`, and `HOST=127.0.0.1` set in the private environment.
- Route the public domain and admin subdomain through a trusted HTTPS reverse proxy; redirect HTTP to HTTPS, keep the origin server inaccessible from the internet, preserve each incoming `Host`, and set request size and per-IP login/request rate limits at the proxy. `REPORT_TRUST_PROXY=1` is safe only when the proxy overwrites `X-Forwarded-For` and connects to the app over loopback. The app sends a browser HSTS header in production, but the proxy must still enforce HTTPS.
- Admin state changes require a matching `Origin` header and reject requests from sibling subdomains using browser Fetch Metadata. Non-browser API clients must send the admin hostname as their `Origin`. Admin uploads accept only declared JPG/PNG/WebP or MP4/WebM with basic structure checks; these checks do not replace media transcoding or a malware scanner. Consider isolating/transcoding large videos before publication.
- Published videos and photos are downloadable by visitors. Unpublish/deletion hides them on this server but cannot revoke copies saved earlier or cached by outside services. Likes, watch history and saved lists stay in each viewer's browser storage. The public contact email and anything entered in published titles/descriptions are public. Enabling ads loads a third-party script on public pages; check the provider's privacy practices before activation.

The age screen is a self-attestation prompt and does not verify age. Before making an age-restricted site public, configure appropriate age assurance, rights/consent review, operator contact email in **Admin → Site settings**, content moderation, accurate policies, and local legal requirements for the intended audience. Test video codecs and mobile playback on real devices before launch.
