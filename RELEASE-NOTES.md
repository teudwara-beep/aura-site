# AURA 1.8.0 — optional Bunny Stream upload and playback

Admins can configure a Stream Video Library with private environment values before obtaining a VPS. Browser uploads use signed, resumable TUS chunks sent directly to Bunny. Videos remain private drafts until encoding completes; Bunny playback uses the responsive embedded player with short-lived embed tokens. Admin preview, delete, storage counts and backup metadata work with Bunny IDs, while older videos still use local files. Tests cover mocked Bunny API calls, TUS chunking and backups. Actual Stream credentials, a real-account upload, security allowlists and live mobile playback still need testing by the account owner; the project ZIP includes no secrets. Bunny-hosted video bytes are not part of AURA's local backups.

## Previously completed in 1.7.1 — security and photo privacy

Admin state changes now require a matching Origin and reject same-site requests from sibling subdomains in browsers that send Fetch Metadata. Production responses include HSTS, and all responses omit the referrer. New category and collection images have embedded EXIF, XMP, text and unknown ancillary metadata removed on the server before they are stored; malformed image structures are rejected. A one-time offline cleanup command is provided for images uploaded before this version. The smoke suite checks sibling subdomain requests, image formats, prior uploads and private photo access. See README for the upgrade command and HTTPS, storage, proxy and backup precautions. This update does not scan video contents or ensure a deployed server cannot be compromised.

## Previously completed in 1.7.0 — video collections and collection views

Added Video collections with admin creation, editing, existing-video selection, ordering, publishing and deletion. A new public page lists published collections and their playable videos. Public video collections contain only published uploaded videos; unpublished or deleted videos disappear from the list, and empty collections stop appearing. Deleting a collection leaves its videos untouched. Added collection-level views for videos and photos and image-level views for full-size photo opens; a viewer cookie limits repeat counts to once per browser per item every 30 minutes while the server remains running. New counts appear in the admin dashboard and collection panels, with collection counts on public pages. The database migrates automatically and backups include membership and counters. API, privacy, view deduplication and restore checks cover these flows; mobile browser layout should also be checked on a real device before launch.

## Previously completed in 1.6.0

Added a separate public Photos page and admin Photo collections panel. The admin can create a draft collection, upload multiple JPG/PNG/WebP images, preview images, edit collection details, publish or unpublish, remove individual images, and delete a collection. Visitors can browse published collections and open a responsive gallery with keyboard and touch navigation. Drafts and their photos remain private. Collection photos are checked by Storage and included in full backup, verification and restore. Uploaded photos use a different directory from category art and video files. Large images are resized by the browser, with the server limiting each finished upload to 8 MB. Real device gallery browsing and actual hosting still need a manual check before launch.

## Previously completed in 1.5.9

Video cards on touch screens now include a small Preview button. A tap plays that card's video inline, muted, while tapping the rest of the card still opens the full watch page. Another tap stops it. Only one card can preview at a time; it stops when scrolled offscreen, the page is hidden, or the visitor navigates away. Previews load only after the viewer chooses them, and a playback failure returns to the thumbnail. Desktop hover previews continue as before. A focused mobile preview check covers playback and cleanup; actual iOS/Android codec and browser behavior still needs real-device verification.

## Previously completed in 1.5.8

Reviewed the admin, public catalog, video playback, category images, reports, local lists, mobile layouts, and backup flows before a future Bunny Stream integration. An unreadable category image now shows the current image or gradient instead of a broken thumbnail, and disabled modal actions are visibly disabled. Category images larger than 1600 pixels along either side are resized before upload to reduce unnecessary decoding on phones, even if the original is already under 3 MB. All existing syntax, markup, player, catalog, removal, and end-to-end API/media/backup checks pass. Real-device browser testing and live hosting/Stream integration remain separate steps; passing local checks does not guarantee a production site free of defects.

## Previously completed in 1.5.7

The security policy now allows locally selected image previews (`blob:` URLs) in the admin category editor. Previously the browser blocked every selected image, displayed an unreadable image error, and prevented the upload even for valid JPEG/PNG/WebP files. The smoke check now verifies the image policy and a JPEG category image upload.

## Previously completed in 1.5.6

The admin can now assign up to eight tags to a video while uploading or editing it. Tags appear as small search links in the video description, and full catalog search finds tagged videos. Related recommendations now use the complete published catalog, prefer shared tags, then the same category, with a small recency/view tie-breaker. Video playback and the sidebar continue to load immediately while recommendations update. Old databases gain an empty tags column at startup; draft and private videos never appear in public recommendations. No viewer account or server-side watch tracking is required.

## Previously completed in 1.5.5

Admin → Ads now manages optional ExoClick banner/native placements after the first six homepage videos and below the watch page description. Each placement has independent on/off controls and numeric desktop/mobile zone IDs; both start disabled. Only the public site loads the ad provider's asynchronous tag, and only when a configured placement is shown. The server validates zone IDs, persists controls with the existing site settings, and allows the provider script in the public Content Security Policy only when ads are enabled. The smoke check verifies admin isolation, disabled defaults, validation, persistence, and public policy changes. Live ad delivery still requires approved zones in an ExoClick publisher account.

## Previously completed in 1.5.4

Opening a video now checks its current public status, so a removed or unpublished video cannot reopen from an old tab's cache. Saved lists refresh their video records when opened; slower requests cannot replace a newer video navigation. Search suggestions now include matching categories. Switching on Reduce motion immediately stops the featured background video. The version in Settings comes from the installed package version, and the watch page has one document main landmark. When `REPORT_TRUST_PROXY=1` is correctly configured, admin login rate limits use the visitor IP supplied by the trusted local proxy, avoiding a shared lockout for all visitors behind it. A focused catalog regression check covers stale videos and navigation races.

## Previously completed in 1.5.3

### Category image upload

The category editor now shows image preparation and upload status, accepts JPG/PNG/WebP files up to 20 MB and resizes those above the server's 3 MB upload limit in the browser. Images with a missing or nonstandard browser MIME label can still upload if their file format is valid. Invalid or unreadable selections keep Save disabled rather than silently saving a category without its selected image. A failed upload reports whether the category name was saved and supports retrying the image. Removing an image clears any pending replacement; category tiles refresh after changes.

## Previously completed in 1.5.2

### Mobile controls and layout

On touch devices the video-card options and mini-player controls stay visible, playback controls fit narrow screens with a More button for skipping, PiP, mini-player and theater, and cancelled touches no longer leave the seek bar in a dragging state. A native-video fullscreen fallback helps browsers that cannot fullscreen the player wrapper. Admin tabs wrap rather than disappear offscreen; video/category tables become phone-sized cards with visible actions. Search and form fields use mobile-sized text, dialogs respect viewport height, and long site names truncate cleanly in the header.

## Previously completed in 1.5.1

### Site settings and branding

Site name and tagline now update the public homepage, age screen, About and legal text, video cards, browser title, page description and installable app manifest. Settings remain saved in SQLite after a restart. The featured hero hides when no video is selected. The smoke check covers settings changes, escaped markup, public and admin HTML, manifest responses, and persistence after restart.

## Previously completed in 1.5.0

### Category images

Admin → Categories → Add/Edit category now accepts an optional JPG, PNG or WebP image (up to 3 MB). Categories show the uploaded image with the existing dark overlay; without an image they keep the original minimal background. Admins can replace or remove images. Files are stored under data/category-images and included in verified backups and restores. Existing databases gain an image_path column automatically.

## Previously completed in 1.4.0

### Video removal requests

## Included in 1.4.0

- Minimal Report button beside the video, plus a link under Legal for pasting a video ID/link.
- Private request intake for copyright, privacy/consent, safety and other concerns, with a visible reference number.
- Admin-only review queue with a pending count, private notes, status changes and private video preview.
- One action to unpublish the reported video and resolve a request without erasing the original file or report.
- Validation, deduplication, rate limits and integration checks for public submission, admin isolation, unpublishing, deletion and backup/restore.
- The age screen includes a removal link so a person can report without entering the catalog.
- Removal requests are saved in the existing SQLite database. Existing installations gain the table automatically at restart.

The form is for initial review. It sends no email automatically. The administrator must set a working contact email, review requests regularly and handle formal notices according to the relevant legal process. Backups now contain submitter contact data.

## Previously completed in 1.3.0

## Included

- Player events, media resources and autoplay timers are cleaned up on navigation.
- Mini-player progress and completion are saved in watch history.
- Keyboard-accessible seeking, playback retry and reliable link sharing.
- Locked upload fields during transfer; replacement, edit and deletion cannot race on the same video.
- Thumbnail cache invalidation after file replacement.
- Admin title/category search, status filters, pagination and storage diagnostics.
- Complete database/video backup, SHA-256 verification and restoration into a new directory.
- Updated setup/recovery instructions and GitHub checks.

## Verification

Use these commands with Node.js 22.13 or later:

1. `npm run check` — JavaScript syntax, HTML IDs and required assets.
2. `npm run test:player` — player event/state regressions using Node DOM doubles.
3. `npm run test:catalog` — stale video cache and video navigation races.
4. `npm run test:removal` — public form, escaped inbox and admin unpublish action with Node DOM doubles.
5. `npm run smoke` — isolated server, real MP4/WebM uploads, authentication and admin-host separation, draft privacy, media byte ranges/cache replacement, view counting, featured content, search/pagination/categories, concurrent operations, deletion and migration. It also checks the complete report lifecycle and persistence in a restored database.

These checks do not prove that every browser/device can decode every video. A live browser rendering and real-device playback pass remains unverified in this environment. The ZIP contains source code, not your credentials, database or uploaded videos.

## Before a public launch

Configure persistent hosting, the public/admin domain names, HTTPS and off-server backups. Bunny Stream is not integrated; uploads currently use local disk. Test representative videos on the intended browsers/phones and test hosting limits with your real workload. Configure operator/contact information and the applicable content, privacy and age-assurance requirements.

This release completes the local gaps identified in this review. It is not a claim of zero bugs or a completed public deployment.
