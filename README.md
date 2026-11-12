# HLTV → r/GlobalOffensive Post-Match Thread Extension

A browser extension for **Google Chrome, Microsoft Edge, and Firefox (desktop)** that helps create and post Counter-Strike match discussion threads to [r/GlobalOffensive](https://www.reddit.com/r/GlobalOffensive/).

The extension collects match information from [HLTV](https://www.hltv.org/) and [Liquipedia](https://liquipedia.net/counterstrike/Main_Page), formats it into a Reddit thread, and lets you review and edit the result before posting. It can also monitor a match and automatically submit its post-match thread when the match ends.

This guide uses the following terms:

| Term | Meaning |
| --- | --- |
| **PMT** | **Post-match thread** — a Reddit discussion for a completed match. |
| **LMT** | **Live match thread** — a Reddit discussion before and during a match. |
| **The extension** or **PMT extension** | The browser add-on that creates and manages these threads. |

PMT and LMT on their own always refer to threads in this guide.

## Installation

### Firefox — signed add-on

The Firefox installer, **[`PMT-Firefox.xpi`](./PMT-Firefox.xpi)**, is located in the repository root, alongside `new_format/`. It must be the **Mozilla-signed** `.xpi` file, not a renamed ZIP archive.

1. Download `PMT-Firefox.xpi` from this repository.
2. Open Firefox and go to `about:addons`.
3. Click the gear icon and choose **Install Add-on From File…**.
4. Select the downloaded `.xpi` file and confirm installation.
5. Grant any requested website permissions, then open an [HLTV match page](https://www.hltv.org/matches).

You can also drag the signed `.xpi` into Firefox to start installation. The installed add-on remains available after restarting the browser. **Firefox 142 or newer** is required by the current Firefox manifest.

To load the Firefox source temporarily for development, use `about:debugging` → **This Firefox** → **Load Temporary Add-on** and choose `new_format/extension/manifest.json`.

### Chrome / Edge — unpacked extension

The extension is not distributed through the Chrome Web Store. To install it manually:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `new_format/extension/` (the folder containing `manifest.json`).

Keep the folder on your computer while using the extension. The Chromium and Firefox builds have separate source folders.

## Creating a Thread

Open a match on [HLTV](https://www.hltv.org/matches). Four buttons appear near the bottom-right corner:

- **Live Match Discussion Thread** — Generate a discussion thread for an upcoming or ongoing match.
- **Post-Match Thread** — Generate a post-match thread for a completed match.
- **Schedule Live Match Discussion** — Schedule both threads: start the LMT five minutes before the match, update it after completed maps, then post the PMT and link to it from the LMT.
- **Schedule Post-Match Thread** — Monitor a match and prepare or automatically post a thread after it finishes.

For manual thread creation:

1. Select the appropriate thread button on the HLTV match page.
2. Wait for the extension to gather and format the match information.
3. Review the generated title, body, and highlights in the panel.
4. Make any necessary changes, then open the Reddit submission page and submit the thread.

Depending on what's available, threads can include scores and map statistics, player and coach information, team rosters, event details, stream links, vetoes, highlights, tournament brackets, and social links.

### Correcting Liquipedia links

The extension searches for the relevant Liquipedia event and team pages. If a link is wrong or missing, change its URL in the thread panel and click **Regenerate**. Corrected links are remembered for future use. Clear a URL field and regenerate to search again.

If a Liquipedia page is unavailable, the extension will still attempt to build a thread using available HLTV data.

## Scheduling Live Match Discussion Threads

1. Open a match on HLTV and click **Schedule Live Match Discussion**. This schedules **both the LMT and PMT**.
2. The extension starts generating the LMT **five minutes before HLTV's scheduled start**. Actual publication follows generation and Reddit submission. If scheduled during a live match, generation starts on the next check.
3. After publication, the extension checks approximately every minute and edits that same LMT when a completed map or its delayed statistics become available.
4. When the series ends, the workflow posts the PMT using the normal statistics readiness rules below. PMT publication proceeds independently of any failed LMT edit.
5. Once Reddit confirms the PMT URL, the extension makes one final LMT update with the final score, available final-map information, and a notice linking to the **post-match discussion**. The rest of the LMT stays in place.
6. LMT editing then stops. If the PMT still lacks statistics, the same HLTV watcher continues checking for its later update.

Each match and destination subreddit has **one scheduled entry and one shared HLTV watch tab**, with separate submission and editing records for each Reddit post. Scheduling a PMT first and then an LMT upgrades the existing workflow; scheduling both never creates a second PMT. If the match has already ended before an LMT was posted, the workflow skips the LMT and proceeds to the PMT.

In **Options → Scheduled threads**:

- **Stop live updates** stops LMT editing, including the final notice, while keeping the PMT scheduled.
- **Cancel entire workflow** stops all remaining work for that match.
- Both thread links, their individual progress, errors and retry controls appear in the same match entry.
- A failed closing LMT edit can be retried without reposting the PMT. An unconfirmed submission requires explicitly authorizing another submission after checking Reddit.

Progress is persisted across background-worker or browser restarts. Existing independent schedules are combined on upgrade, retaining their original Reddit URLs and duplicate-submit protection. Active LMT schedules gain the pending PMT; already archived LMTs do not retroactively publish old PMTs.

The browser must remain running and logged into the posting Reddit account. Hidden Reddit tabs for the same thread are reused where available. Saving uses old Reddit's own **Edit → Save** form and verifies the saved Markdown, including a fresh load when needed. The thread, subreddit, author account and previously confirmed body must match. A manually changed body is never overwritten, and an edit failure never causes a duplicate submission.

The extension does not fetch `/api/info.json` or `/api/me.json` or send its own `/api/editusertext` request. A CAPTCHA, rejected save or unconfirmed result remains an error requiring retry or manual attention. A manually posted LMT is not automatically adopted.

## Scheduling Post-Match Threads

1. Open an HLTV match page and click **Schedule Post-Match Thread**.
2. The extension checks the match periodically until it finishes.
3. After the match ends, the extension checks whether the required match and finished-map statistics are available.
4. If statistics are delayed, the extension waits **up to one minute**, then generates the thread anyway rather than waiting indefinitely.
5. Depending on the **Auto-submit** setting, the extension either attempts to submit the thread to Reddit or prepares it for manual review.

The missing-statistics check covers **every finished map**, regardless of map number or series length (for example, best-of-1, best-of-3, or best-of-5). A finished map also counts as missing statistics if HLTV has not yet published its map-statistics link.

### Automatically updating a posted thread when statistics arrive

If the extension **automatically posts** a scheduled thread while statistics for one or more finished maps are still missing, it can update that **same Reddit post** later:

1. After posting, the extension keeps checking HLTV approximately once per minute.
2. When all required statistics become available, it regenerates the thread body.
3. It edits the original Reddit post rather than submitting a duplicate.
4. It stops checking after a successful update or when the **60-minute monitoring window** expires.

This applies to **any missing finished-map statistics**, not only Map 3 or matches ending 2–1. It can also handle a delayed final map in a longer series, such as Map 4 or Map 5 in a best-of-5.

To avoid overwriting your changes, the extension will not automatically replace a Reddit post whose body has been manually edited since it submitted the post. The update feature applies to threads **automatically submitted by the scheduler**; manually submitted threads are not automatically edited.

These post-match updates use the same old-Reddit **Edit → Save** flow and save verification as live discussion updates.


### Automatic submission

Use the extension's **Options** page to configure automatic submission:

- **Enabled:** The extension attempts to submit a scheduled thread when it is ready.
- **Disabled:** The extension prepares the thread for you to review and post manually.

Automatic posting requires an active Reddit login and a running browser. If Reddit requests a CAPTCHA, rejects the post, or the required flair cannot be applied, manual intervention may be necessary.

### Managing scheduled threads

Open **Options → Scheduled threads** to view one entry per match, open its LMT and PMT, stop LMT updates, cancel remaining work, retry an individual thread or edit, copy generated content, or inspect the shared match log. The destination subreddit is fixed when scheduled.

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
3. Open `chrome://extensions` or `edge://extensions` and click **Reload** on the PMT extension.

### Firefox

1. Download the latest **Mozilla-signed** `PMT-Firefox.xpi`.
2. Open `about:addons` → gear icon → **Install Add-on From File…** and select it.
3. Confirm the update if prompted.

The signed Firefox installer and extension source are published together with matching version numbers.

To replace the currently installed add-on, the new `.xpi` must use the same Firefox add-on ID and a newer version number in its manifest. Manually distributed unlisted add-ons do not automatically update unless a separate update mechanism has been configured.

## Repository Layout

```text
PMT/
├── README.md
├── PMT-Firefox.xpi           # Mozilla-signed Firefox installer
├── new_format/
│   └── extension/            # Extension source code
└── old_format/               # Legacy format
```

## Development checks

Run `node --test tests/*.test.js` from the repository root (Node.js 18 or newer). The tests simulate browser storage, tabs, alarms and Reddit acknowledgements without making network requests or posting real threads. They cover the combined handoff, delayed statistics, retries, restart recovery, migration, duplicate protection and final LMT formatting.

## Notes

- The extension is designed for [r/GlobalOffensive](https://www.reddit.com/r/GlobalOffensive/).
- It uses publicly accessible HLTV and Liquipedia information and interacts with Reddit for submission and editing.
- An internet connection and access to the relevant websites are required.
- This is an unofficial community tool and is not affiliated with HLTV, Liquipedia, Reddit, or their respective owners.
