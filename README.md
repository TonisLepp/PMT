# HLTV → r/GlobalOffensive Post-Match Thread Extension

A browser extension for **Google Chrome, Microsoft Edge, and Firefox (desktop)** that helps create and post Counter-Strike match discussion threads to [r/GlobalOffensive](https://www.reddit.com/r/GlobalOffensive/).

PMT collects match information from [HLTV](https://www.hltv.org/) and [Liquipedia](https://liquipedia.net/counterstrike/Main_Page), formats it into a Reddit thread, and lets you review and edit the result before posting. It can also monitor a match and automatically submit its post-match thread when the match ends.

## Installation

### Firefox — signed add-on

The Firefox installer, **[`PMT-Firefox.xpi`](./PMT-Firefox.xpi)**, is located in the repository root, alongside `new_format/`. It must be the **Mozilla-signed** `.xpi` file, not a renamed ZIP archive.

1. Download `PMT-Firefox.xpi` from this repository.
2. Open Firefox and go to `about:addons`.
3. Click the gear icon and choose **Install Add-on From File…**.
4. Select the downloaded `.xpi` file and confirm installation.
5. Grant any requested website permissions, then open an [HLTV match page](https://www.hltv.org/matches).

You can also drag the signed `.xpi` into Firefox to start installation. The installed add-on remains available after restarting the browser. **Firefox 142 or newer** is required by the current Firefox manifest.

To load the Firefox source temporarily for development, use `about:debugging` → **This Firefox** → **Load Temporary Add-on** and choose `new_format/extension-firefox/manifest.json`.

### Chrome / Edge — unpacked extension

The extension is not distributed through the Chrome Web Store. To install it manually:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `new_format/extension/` (the folder containing `manifest.json`).

Keep the folder on your computer while using the extension. The Chromium and Firefox builds have separate source folders.

## Creating a Thread

Open a match on [HLTV](https://www.hltv.org/matches). Three buttons appear near the bottom-right corner:

- **Live Match Discussion Thread** — Generate a discussion thread for an upcoming or ongoing match.
- **Post-Match Thread** — Generate a post-match thread for a completed match.
- **Schedule Post-Match Thread** — Monitor a match and prepare or automatically post a thread after it finishes.

For manual thread creation:

1. Select the appropriate thread button on the HLTV match page.
2. Wait for PMT to gather and format the match information.
3. Review the generated title, body, and highlights in the panel.
4. Make any necessary changes, then open the Reddit submission page and submit the thread.

Depending on what's available, threads can include scores and map statistics, player and coach information, team rosters, event details, stream links, vetoes, highlights, tournament brackets, and social links.

### Correcting Liquipedia links

PMT searches for the relevant Liquipedia event and team pages. If a link is wrong or missing, change its URL in the thread panel and click **Regenerate**. Corrected links are remembered for future use. Clear a URL field and regenerate to search again.

If a Liquipedia page is unavailable, PMT will still attempt to build a thread using available HLTV data.

## Scheduling Post-Match Threads

1. Open an HLTV match page and click **Schedule Post-Match Thread**.
2. PMT checks the match periodically until it finishes.
3. After the match ends, PMT checks whether the required match and finished-map statistics are available.
4. If statistics are delayed, PMT waits **up to five minutes**, then generates the thread anyway rather than waiting indefinitely.
5. Depending on the **Auto-submit** setting, PMT either attempts to submit the thread to Reddit or prepares it for manual review.

The missing-statistics check covers **every finished map**, regardless of map number or series length (for example, best-of-1, best-of-3, or best-of-5). A finished map also counts as missing statistics if HLTV has not yet published its map-statistics link.

### Automatically updating a posted thread when statistics arrive

If PMT **automatically posts** a scheduled thread while statistics for one or more finished maps are still missing, it can update that **same Reddit post** later:

1. After posting, PMT keeps checking HLTV approximately once per minute.
2. When all required statistics become available, it regenerates the thread body.
3. It edits the original Reddit post rather than submitting a duplicate.
4. It stops checking after a successful update or when the **60-minute monitoring window** expires.

This applies to **any missing finished-map statistics**, not only Map 3 or matches ending 2–1. It can also handle a delayed final map in a longer series, such as Map 4 or Map 5 in a best-of-5.

To avoid overwriting your changes, PMT will not automatically replace a Reddit post whose body has been manually edited since PMT submitted it. The update feature applies to threads **automatically submitted by the scheduler**; manually submitted threads are not automatically edited.

> **Release note:** The automatic edit feature requires the updated `scheduler.js`, `content.js`, and `reddit.js` to be included in the distributed extension. Rebuild and re-sign `PMT-Firefox.xpi` after updating those files; an older signed `.xpi` will not gain the feature just because the repository source changed.

### Automatic submission

Use the extension's **Options** page to configure automatic submission:

- **Enabled:** PMT attempts to submit a scheduled thread when it is ready.
- **Disabled:** PMT prepares the thread for you to review and post manually.

Automatic posting requires an active Reddit login and a running browser. If Reddit requests a CAPTCHA, rejects the post, or the required flair cannot be applied, manual intervention may be necessary.

### Managing scheduled threads

Open **Options → Scheduled threads** to view pending, posted, and failed jobs, cancel a job, retry a failed job, open an existing Reddit post, copy the generated content, or inspect its log.

## Settings and Troubleshooting

### Missing or incorrect information

If a generated thread is incomplete or inaccurate:

1. Check the thread panel's status messages.
2. Verify the selected Liquipedia pages.
3. Correct any incorrect URLs and click **Regenerate**.
4. Review the updated body before submitting it.

Use **Forget Liquipedia links** in Options to clear previously remembered links.

### Scheduled thread not posting or updating

Check **Options → Scheduled threads** and inspect the job log. Common causes include an unfinished match, delayed HLTV statistics, an unavailable source page, an interrupted browser tab, Reddit authentication problems, CAPTCHA, or flair errors.

If a thread posts without some map statistics, the automatic update should keep checking **only if** that job was auto-submitted, its post-publication update state was activated, and the installed build contains the updated auto-edit code. A manually edited Reddit post will not be overwritten.

### Reporting problems

- **Copy diagnostics** in the thread panel provides details about the latest thread generation.
- **Options → Diagnostics** provides recent generation logs.
- **Options → Scheduled threads → Copy log** provides an individual scheduled job's log.

Include the relevant logs and a brief description when reporting an issue. Remove any personal information before sharing logs.

## Updating the Extension

### Chrome / Edge

1. Download the latest `new_format/extension/` source files.
2. Replace the contents of your existing unpacked extension folder.
3. Open `chrome://extensions` or `edge://extensions` and click **Reload** on PMT.

### Firefox

1. Download the latest **Mozilla-signed** `PMT-Firefox.xpi`.
2. Open `about:addons` → gear icon → **Install Add-on From File…** and select it.
3. Confirm the update if prompted.

To replace the currently installed add-on, the new `.xpi` must use the same Firefox add-on ID and a newer version number in its manifest. Manually distributed unlisted add-ons do not automatically update unless a separate update mechanism has been configured.

## Repository Layout

```text
PMT/
├── README.md
├── PMT-Firefox.xpi           # Mozilla-signed Firefox installer
├── new_format/
│   ├── extension/            # Chrome / Edge extension source
│   └── extension-firefox/    # Firefox extension source
└── old_format/               # Legacy format
```

## Notes

- PMT is designed for [r/GlobalOffensive](https://www.reddit.com/r/GlobalOffensive/).
- It uses publicly accessible HLTV and Liquipedia information and interacts with Reddit for submission and editing.
- An internet connection and access to the relevant websites are required.
- This is an unofficial community tool and is not affiliated with HLTV, Liquipedia, Reddit, or their respective owners.
