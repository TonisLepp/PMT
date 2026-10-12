# HLTV Post-Match Thread Extension

A Chrome/Edge browser extension for generating Counter-Strike match discussion and post-match threads for [r/GlobalOffensive](https://www.reddit.com/r/GlobalOffensive/).

Automatically collects match information from HLTV and Liquipedia, formats it into a Reddit thread, and allows you to review and edit the result before posting.

## Installation

1. Extract the downloaded ZIP file, if you haven't already.
2. Open your browser's extensions page:
   - **Google Chrome:** `chrome://extensions`
   - **Microsoft Edge:** `edge://extensions`
3. Enable **Developer mode** (usually in the top-right corner).
4. Click **Load unpacked**.
5. Select the folder containing this README and `manifest.json`.

The extension should now be installed!

**Important:** Keep the extension folder on your computer after installation. Moving or deleting it may prevent the extension from working.

## How to Use

1. Visit any match page on [HLTV](https://www.hltv.org/matches).
2. Look for the extension's buttons in the bottom-right corner.
3. Choose one of the following options:

   - **Live Match Discussion Thread:** Generate a discussion thread for an upcoming or ongoing match.
   - **Post-Match Thread:** Generate a post-match thread for a completed match.
   - **Schedule Post-Match Thread:** Automatically generate and post a thread once the match finishes.

4. For manually generated threads, review the information in the extension's panel.
5. Edit the title, highlights, or body as needed, then open the Reddit submission page to post your thread.

The extension automatically gathers available match statistics, team information, map results, highlights, and tournament details.

### Scheduled Posting

You can schedule a post-match thread before or during a match.

Once scheduled, the extension will periodically check HLTV for the match result. When the match finishes, it will generate the thread and either submit it automatically or leave it for you to review, depending on your settings.

To manage scheduled threads:

1. Open your browser's extensions page.
2. Find the extension and open **Options**.
3. Navigate to **Scheduled threads**.

From there, you can view scheduled jobs, cancel them, retry failed submissions, and access completed threads.

You can also configure how often the extension checks match results and whether scheduled threads are submitted automatically.

**Note:** Keep your browser running and stay logged into Reddit for automatic posting to work. Occasionally, Reddit may require manual intervention, such as completing a CAPTCHA.

## Troubleshooting

### Missing or incorrect information

The extension retrieves information from both HLTV and Liquipedia. Occasionally, it may be unable to find the correct Liquipedia page.

If this happens, check the Liquipedia URLs displayed in the extension's panel. You can correct them manually and click **Regenerate** to rebuild the thread.

To clear previously remembered Liquipedia links, use **Forget Liquipedia links** in the extension's Options page.

### Scheduled thread failed to post

Open **Options → Scheduled threads** to see the job's status and any reported problems.

You may need to finish the submission manually if Reddit requires a CAPTCHA, rejects the submission, or cannot apply the required flair.

### Reporting a bug

If something isn't working correctly, you can copy diagnostic information to help identify the problem.

- **Copy diagnostics** in the thread panel provides information about the latest thread generation.
- **Options → Diagnostics** contains logs from recent runs.
- **Options → Scheduled threads → Copy log** provides information about an individual scheduled job.

When reporting an issue, include the relevant logs and a brief explanation of what went wrong.

## Updating

To install a newer version:

1. Download the updated extension files from the [GitHub repository](https://github.com/FRojas1/PMT).
2. Replace the files in your existing extension folder.
3. Open `chrome://extensions` or `edge://extensions`.
4. Click **Reload** on the extension.

Your browser should now use the updated version.

## Additional Information

For more information, updates, and source code, visit the [GitHub repository](https://github.com/FRojas1/PMT).

This is an unofficial community extension and is not affiliated with HLTV, Liquipedia, or Reddit.
