# HLTV → r/GlobalOffensive Post-Match Thread Extension

A browser extension for Chrome and Edge that makes creating and posting Counter-Strike match discussion threads to r/GlobalOffensive quick and easy.

The extension automatically gathers match information from [HLTV](https://www.hltv.org/) and [Liquipedia](https://liquipedia.net/counterstrike/Main_Page), formats it into a Reddit thread, and lets you review and edit everything before posting. It also supports automatically posting threads when matches finish.

## Installation

The extension isn't available on the Chrome Web Store, but you can install it manually in a few steps.

### 1. Download the extension

Download the `new_format/extension` folder from the GitHub repository.

**[Download Extension](https://download-directory.github.io/?url=https://github.com/FRojas1/PMT/tree/main/new_format/extension&filename=PMT-Extension)**

Extract the ZIP to it's own folder on your computer. Keep this folder somewhere permanent, since your browser needs access to it for the extension to work.

### 2. Install in your browser

1. Open your browser's extensions page:
   - **Chrome:** `chrome://extensions`
   - **Edge:** `edge://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the extracted folder (the folder containing `manifest.json`).

The extension should now appear in your installed extensions.

### 3. Start using it

Open any [HLTV match page](https://www.hltv.org/matches).

You'll see three buttons in the bottom-right corner of the page:

- **Live Match Discussion Thread** — Create a discussion thread for an upcoming or ongoing match.
- **Schedule Post-Match Thread** — Automatically create and post a thread once the match finishes.
- **Post-Match Thread** — Generate a post-match thread for a completed match.

## Creating a Thread

1. Open the match you want to post about on HLTV.
2. Click the appropriate thread button in the bottom-right corner.
3. Wait for the extension to gather the match information.
4. Review the generated thread in the extension's panel.
5. Edit the title, body, or highlights as needed.
6. Open the Reddit submission page and submit your thread.

The extension automatically formats available information, including:

- Match scores, maps, and statistics
- Team rosters, coaches, and player roles
- Event details and stream links
- Map vetoes and match highlights
- Tournament bracket information and upcoming opponents
- Team information and social links

Some details come from Liquipedia. If a team or event isn't available there, the extension will still attempt to generate the thread using HLTV information.

### Correcting Liquipedia links

The extension automatically searches for the relevant Liquipedia event and team pages.

Occasionally, it may select the wrong page or fail to find one. If that happens, you can manually edit the Liquipedia URLs displayed in the panel and click **Regenerate**.

The corrected links are remembered for future use.

To make the extension search again, clear the corresponding URL field and click **Regenerate**.

## Scheduling Post-Match Threads

Instead of waiting for a match to finish, you can schedule its post-match thread in advance.

1. Open the match on HLTV.
2. Click **Schedule Post-Match Thread**.
3. The extension will periodically check whether the match has finished.
4. Once the match ends and statistics become available, it generates the thread and prepares the Reddit submission.
5. If automatic submission is enabled, the extension attempts to post it automatically.

You can schedule a thread before a match begins or while it's in progress.

### Managing scheduled threads

Open the extension's **Options** page and find **Scheduled threads**.

Here, you can:

- View scheduled, completed, and failed threads
- Cancel a scheduled thread
- Retry a failed job
- Open a successfully posted thread
- Copy a thread's title or body
- View logs when something goes wrong

The extension also displays notifications when a thread is posted or requires your attention.

### Automatic submission

In Options, you can configure whether scheduled threads should be submitted automatically.

- **Enabled:** The extension attempts to submit the thread when it's ready.
- **Disabled:** The extension prepares the submission for you to review and post manually.

For automatic posting, you'll need to be logged into Reddit. Keep your browser running while scheduled jobs are active.

If Reddit requires a CAPTCHA, rejects the submission, or the extension cannot apply the required flair, it will stop and leave the submission for you to finish manually.

**Important:** Automatically generated threads can contain missing or incorrect information, especially when external sources are unavailable. If you want to review every thread before publication, disable automatic submission.

## Settings and Troubleshooting

You can access the extension's Options page through your browser's extension management page.

### Missing or incorrect information

The extension uses HLTV and Liquipedia to collect information. Occasionally, a page may be unavailable or a search may return the wrong result.

If a generated thread is missing information:

1. Check the status message in the extension's panel.
2. Verify that the Liquipedia URLs are correct.
3. Correct any incorrect URLs and click **Regenerate**.
4. Review the generated thread before submitting.

You can also use **Forget Liquipedia links** in Options to clear previously remembered links.

### Scheduled thread isn't posting

Check the job's status under **Options → Scheduled threads**.

Some common reasons a thread may not post automatically include:

- The match hasn't finished yet.
- HLTV hasn't published the match statistics.
- Reddit requires a CAPTCHA or manual action.
- Reddit rejected the submission or the required flair couldn't be applied.
- The extension couldn't load the required pages.

If a job requires your attention, you can open its submission tab or copy the generated content and post it manually.

### Reporting problems

If something goes wrong, the extension includes diagnostic logs to help identify the issue.

- **Copy diagnostics** in the thread panel copies information about the most recent thread generation.
- **Options → Diagnostics** contains logs from the five most recent runs.
- **Options → Scheduled threads → Copy log** provides information about an individual scheduled job.

When reporting an issue, include a description of what happened and the relevant logs. For scheduled posting problems, include both the job log and the thread generation diagnostics.

## Updating the Extension

To update the extension:

1. Download the latest version of the `new_format/extension` folder.
2. Replace the contents of your existing extension folder with the new files.
3. Open `chrome://extensions` or `edge://extensions`.
4. Click the **Reload** button on the extension.

You should now be running the updated version.

## Notes

- Compatible with Chromium-based browsers, including Google Chrome and Microsoft Edge.
- Designed for creating threads on r/GlobalOffensive.
- Uses publicly available information from HLTV and Liquipedia.
- Requires an internet connection and access to the relevant websites.
- This is an unofficial community tool and is not affiliated with HLTV, Liquipedia, Reddit, or their respective owners.
