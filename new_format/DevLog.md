# HLTV → r/GlobalOffensive Post-Match Thread — new format

Chrome/Edge extension, same button and reddit flow as the old-format one, but it
renders the new thread layout and pulls event, team and bracket detail from
Liquipedia.

The old-format build is kept unchanged at `../../old_format/extension/` (and its
working copy at `../../extension/`). The two are independent — load whichever you
want, or both, though they inject the same button so run one at a time.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → pick this `extension/` folder.
3. Open any HLTV match page. Three buttons sit bottom-right:
   **Live Match Discussion Thread** for a match that has not finished,
   **Schedule Post-Match Thread** to have the post-match thread posted by
   itself once the match ends (see [Scheduled posting](#scheduled-posting)), and
   **Post-Match Thread** for a match that has already finished.

## What it fetches

Everything comes off the match page unless listed here.

| Fetch | Why |
|---|---|
| HLTV event page | the venue for the Setting line, and a name → flag directory used to give the next bracket opponent a flag |
| HLTV team pages ×2 | **only when the match page has no role pills** — HLTV hides `#lineups` the moment a series ends, and the IGL/AWP markers live on the team profiles instead |
| HLTV map stats page | **only for maps that went to overtime** — the match page reports OT as a single aggregate (`(4:2)`), and the per-half split the format needs is in the round history |
| Search ×3 | locating the Liquipedia event and team pages — Google, falling back to Brave |
| Liquipedia event page | stream links, and the bracket for "advances to … and will face …" |
| Liquipedia team pages ×2 | full team name, social links, roster, coach, benched players |

**Only the search lookups are cached.** The HLTV↔Liquipedia mapping is stored in
`chrome.storage.local` keyed by the HLTV URL and kept indefinitely, so a team is
searched for once and never again. Page *contents* are always re-read, so a
thread can never be built from a stale roster, prize pool or ranking.

The three resolved Liquipedia URLs appear in the panel. Editing one and hitting
**Regenerate** uses it and writes it to the cache — which is also the fallback if
search ever fails or returns the wrong article. **Clearing** a box and hitting
Regenerate forgets the remembered page and searches again from scratch, exactly
as if the team were being seen for the first time; reloading the same saved link
is the one thing emptying the box cannot have meant.

## Why everything goes through a background tab

Both sources refuse a service-worker fetch, for different reasons:

| Source | Response | Reason |
|---|---|---|
| Liquipedia | 403, 2059 bytes, "Verify you are human" | needs the clearance cookie it hands out after you pass the check in a browser |
| Google / Brave | Brave: 429, "your browser does not seem to have JavaScript enabled"; Google: a redirect to `/sorry/` | a captcha, which needs a page's JavaScript to run |

The Liquipedia half was proven by fetching one URL twice from the same page at
the same moment: `credentials: 'include'` returned 200/380 KB, `credentials:
'omit'` returned 403/2059 bytes. The search half cannot be fixed by any fetch at
all — no fetch runs JavaScript.

So a background tab does the work. It is a real browser: it has the cookies, it
runs the scripts, and it looks like the user because it *is* the user. One tab is
opened lazily (inactive), shared for the whole run, and closed when the run goes
idle. If a Liquipedia tab is already open it is borrowed and left alone.

- **Searches** navigate the tab and read the results after the page's scripts
  have run. They are serialised and spaced 1.2s apart. Google is asked first and
  Brave only if it comes back empty or blocked (`via`: `google-tab` /
  `brave-tab`) — see below.
- **Liquipedia pages** try a plain credentialed fetch first, since that is much
  quicker when the cookie travels, and drop to the tab the moment that comes
  back as anything other than the article. The read escalates through three
  rungs and stops at the first that returns a real page:

  | Rung | `via` | Notes |
  |---|---|---|
  | worker fetch | `worker` | fastest; works only when the clearance cookie travels |
  | tab fetch | `tab-fetch` | same-origin, from inside the tab — skipped unless the tab is already on liquipedia.net |
  | tab navigation | `tab-navigate` | the tab simply goes to the page, exactly as you would |

  The escalation is deliberately blind to *why* a rung failed, because the
  failure modes look nothing alike: a Cloudflare challenge is a 403 with a
  captcha in it, a school or office web filter is usually a **200 serving its
  own block page**, and a DNS blackhole is no response at all — the fetch just
  throws. Each of those drops to the next rung.

  A 200 is therefore not taken at face value: the body has to carry MediaWiki's
  markers (`mw-parser-output` and friends) to count as the article. That check
  is for what a Liquipedia page *has* rather than for what a block page *says* —
  a blocklist of filter vendors' wording would both miss the next filter and
  fire on an article that happens to quote one. An intercepted response is
  logged with `"intercepted": true` and an excerpt of whatever answered instead,
  rather than being parsed into a thread with an empty roster in it.

Search results are cached forever, so a repeat run performs **zero** searches —
which is the main defence against being rate-limited in the first place.

The run log records the route every request took (`"via"`: `worker`, `tab-fetch`,
`tab-navigate`, `google-tab`, `brave-tab`) and, on a fallback, what triggered it —
`"retriedAfter"` for the worker fetch that was abandoned, `"afterTabFetch"` for
a tab fetch that was skipped past.

### Liquipedia's own search is not used

It looked tempting — no captcha, and its "go" jump resolves `Vitality` straight
to `Team_Vitality`. But it resolves `Spirit` to `/counterstrike/Spirit`, which is
a **player** page, and it ranked FaZe Clan first for "IEM Beijing 2026 Open
Qualifier". Wrong-but-plausible is the worst failure mode available here, because
the thread still renders — just with the wrong team's roster in it. A general
search engine was correct on every case tested, so a search engine it is.

### Google first, Brave second

Brave is right about the teams everyone has heard of and gets worse as they get
smaller — which is the wrong way round, since an obscure org is exactly the one
nobody proofreading the thread will catch. Google was correct on the obscure
cases (`yawara` → `Yawara_E-Sports`, `FOKUS` → `FOKUS`), so it is asked first.

Brave is kept rather than deleted because Google is the stricter of the two about
automation: a captcha there must not take the whole run down. A blocked engine is
detected (a redirect to `/sorry/`, `consent.google.com`, or a body that talks
about unusual traffic) and recorded in the trace as `"blocked": true`, which is
worth telling apart from a genuine miss — a captcha means *ask someone else*,
an empty result means this name will not be found by asking twice.

**Neither engine's markup is parsed.** Naming the classes a result is built from
is what makes SERP scraping rot, and Google's are generated (`.PMDqCb`,
`.NMq1me`, different next month). But only *one* link is ever needed, so the
markup can be ignored: collect every anchor in the results column and keep the
first that points at a Counter-Strike article. That rule is identical on both
engines, which is why one extractor serves both — and it is markedly sturdier
than the `.result-content > a` it replaced, which returned nothing the moment
Brave reshuffled. The only ids used are `#rso` / `#search` / `#center_col`, and
only to scope the scan; Brave has none of them and falls through to the body.

One wrinkle that scoping earns its keep on: in the saved `yawara` page the first
Liquipedia link on the page is an invisible zero-text anchor outside `#rso`.

**A team-shaped URL is preferred.** A team lives at a single path segment
(`Team_Spirit`, `K27`, `FOKUS`, `Yawara_E-Sports`) while tournaments nest
(`European_Pro_League/Series_6/Play-In`, `Fiesta_Series/1`). So a team lookup
passes over a nested article in favour of a flat one further down the results.
It is a preference rather than a filter — if nothing flat turns up the best
candidate is still returned, and the page it lands on is checked before anything
is built from it.

**Tab subpages are demoted.** Google ranks a team's `/Matches` and `/Results`
pages as results in their own right, so `FOKUS/Results` can outrank `FOKUS`.
Those are the same article one level down, and the parent is the one with the
roster on it, so a known tab suffix is stripped. Event pages are nested too
(`Esports_World_Cup/2026`), which is why the tabs are named explicitly rather
than any trailing segment being treated as a subpage.

### The page has to be the right kind of page

A search can hand back a page that is not the thing asked for, and none of the
parsers will complain: a tournament page has an infobox with a name and social
links in it, so it parses cleanly into a team that never existed. `Bebop` once
resolved to European Pro League Series 6 Play-In, and the thread went out
listing that tournament as one of the teams, wearing the tournament's Twitter
and Twitch. It renders perfectly. It is just wrong — which is the failure mode
worth spending code on, because nothing about the output looks broken.

Liquipedia labels the infobox with what the page is, so that is the whole check:

| Header | Page |
|---|---|
| `Team Information` | a team |
| `League Information` | a tournament |
| `Player Information` | a player |

The categories at the foot of the page (`Teams`, `Tournaments`, `Players`) are
kept as a second opinion for pages carrying no infobox at all. That only ever
matters for events, whose streams and bracket are read from the body — a team
page with no infobox has no name and no links to give, so there is nothing to
rescue. Matching there is anchored to the *end* of the category, because a
tournament is also filed under `Team Tournaments`.

**The page must prove what it is.** A page that matches nothing is rejected, not
allowed through. The permissive rule sounds like the careful one and is not: it
let `/counterstrike/Qualifier_Tournaments` — an index page, no infobox, no
roster — print as a team called "Qualifier Tournaments". Nothing is lost by
insisting, since a page with no team infobox has nothing to contribute anyway.

A page of the wrong kind is **discarded, not used**: the thread falls back to
HLTV's name and flag, the run log says what was found instead, and the panel
says so in words — `Liquipedia link for Bebop was a tournament page (European
Pro League Series 6 Play-In), ignored`. The bad URL is dropped from the cache
too, or every future run would repeat the mistake.

Wiki plumbing is filtered out one step earlier, when results are picked:
`Category:`, `Template:`, `Special:` and friends are not articles. The saved
FOKUS results carry a `Template:Team_Vitality_Roster_Navbox` link, which was
eligible before. Namespaces are listed by name rather than excluding anything
with a colon in it, because a real article is allowed one
(`Counter-Strike:_Global_Offensive`).

Teams that genuinely have no Liquipedia page — which is most of the field in an
open qualifier — land where they always did: `no Liquipedia page for X`, and a
thread built from HLTV alone.

## Details worth knowing

**Overtime columns.** `|Team|T|CT|OT1^CT:T|OT2^T:CT|Total|` — one column per
overtime played, its header naming the sides that team held across the two
halves, and `2:1` under it meaning 2 rounds won in the first half and 1 in the
second.

Working out how many overtimes there were takes some care. The match page
aggregates them all into one figure (`(7:5)`), and the map stats page puts every
overtime in a *single* row per team however many were played. The
`.round-history-bar` dividers are what give it away: one precedes each half, so a
row with four bars is two overtimes. Splitting on the bars rather than assuming a
length also copes with a half of unusual size. Pages that render no bars fall
back to MR3.

Every outcome icon that is not `emptyHistory` is a round that team won, and the
icon names the side: `bomb_exploded` and `t_win` are T; `ct_win`, `stopwatch` (a
CT win on the timer) and `bomb_defused` (a defusal is a CT win) are CT.

A team that loses *every* round of a half leaves no icons there, so its side
cannot be read directly. It is still knowable: the opponent held the opposite
side that half, and the same team held the opposite side in the other half. Both
inferences are applied, which is what turns OG's `^:T` into `^CT:T`.

**Roles.** `♛` in-game leader, `⊕` main AWPer, from HLTV's role pills. They
usually sit in `#lineups` on the match page. Right after a series HLTV hides
that block, so the same pills are read from each team's profile
(`.bodyshot-team`) instead. A player can hold both — cadiaN captains OG *and*
AWPs for them — so every pill is rendered, in the order HLTV lists them:
`cadiaN ♛ ⊕`.

Matching a pill to a player is fiddlier than it looks, because the same person
arrives under three spellings: HLTV's URL slug drops punctuation (`hunter`),
HLTV's stats tables keep it (`huNter-`), and Liquipedia has its own. Roles are
therefore indexed by HLTV player id *and* by a nick folded to letters and digits;
the id wins wherever there is one, and Liquipedia's roster — which carries no
HLTV ids — falls back to the folded nick.

**Lineup.** A separate **Lineups** table, same shape as Full Match Stats, for
who HLTV lists as playing this match — so a stand-in who is not on the
Liquipedia roster still appears. The numbers are HLTV's last-3-months
highlighted stats (KPR, DPR, KAST, ADR, Round Swing, Rating), already on the
match page as `data-teamN-players-data`. Omitted when lineups have not been
posted yet.

**Team names across sources.** Liquipedia's bracket says "FUT Esports" where
HLTV says "FUT". Looking a team up in the HLTV event directory ignores the org
words (`Esports`, `Gaming`, `Team`, `Club`), and the HLTV spelling is the one
carried forward, since that is what the subreddit flair table is keyed on.

**Who counts as a player.** Liquipedia's roster table has one column for both
support staff ("Coach", "Analyst") and qualifiers that still describe a playing
member ("Loan", "Stand-in", "Trial"). Only staff titles disqualify someone —
treating every label as staff dropped OG's two loaned-in players, who had just
played the match. Coaches are pulled from the same column by name.

**Links reddit will not have.** r/GlobalOffensive's spam filter autoremoves a
post that links to Russian social media, Telegram or Discord, and it removes the
*whole* thread over one link — a CIS team's infobox routinely carries three, so
Spirit's thread would never have survived its own Team Information line. Those
links are dropped before they reach the body; everything else on the line keeps
its order, and the run log names what went.

Two rules decide, because neither signal covers the other's ground. A link is
dropped if Liquipedia tagged it `lp-vk`, `lp-telegram` or `lp-discord` — the
icon is what catches a Discord invite behind a vanity redirect like `dsc.gg` or
a team's own subdomain. It is also dropped on its host: any `.ru` domain, or
`vk.com` / `vk.cc` / `vkplay.live` / `t.me` / `telegram.me` / `telegram.org` /
`discord.gg` / `discord.com`. That half is what catches the link no icon marks
— a blocked link is as often the Official Site as it is the VK one. `.ru` as a
rule covers vk.ru, vkvideo.ru, ok.ru and rutube.ru without naming them, so only
the networks sitting on other TLDs are listed.

**Gambling brands.** The same filters remove a post that names a gambling
brand, and several teams carry one. Some carry a sponsor's name; others are
owned outright by a bookmaker. `src/censor.js` rewrites those names everywhere
the thread prints a name: the title, headers, team information, tables,
"advance to" lines, highlight titles and stream labels. The replacements are
what these teams are already called where betting brands aren't allowed. The
Esports World Cup uses PVISION and BB Team, Liquipedia itself lists 1win as
"1w Team" and BET-M 33 as "33", and SportsBetExpert is SBE to everyone. Checked
by hand against the Valve ranking's top 150 (25 August and 2 October 2026), these
seven are the only gambling-branded teams in it:

| Team (HLTV / Liquipedia) | Brand | Becomes |
|---|---|---|
| BETBOOM / BetBoom Team | BetBoom, a bookmaker (owner) | BB / BB Team |
| PARIVISION | PARI, a bookmaker (owner) | PVISION |
| 1win / 1w Team | 1win, a bookmaker (owner) | 1W / 1w Team |
| BC.Game / BC.Game Esports | BC.Game, a crypto casino (owner) | BCG / BCG Esports |
| Betclic / Betclic Apogee Esports | Betclic, a bookmaker (sponsor) | Apogee / Apogee Esports |
| BET-M / BET-M 33 (now 33) | BET-M, a bookmaker (sponsor) | 33 |
| SportsBetExpert | a betting tipster (owner) | SBE |

Three sponsors also have event-name rules: *Stake Ranked* becomes *StarLadder
Ranked* (StarLadder's own billing is "StarLadder Stake Ranked"), *Thunderpick*
becomes *TP*, and *Parimatch* becomes *PM*. Academies and events named after a
team brand come along for free ("BetBoom Dacha" → "BB Dacha", "1win Private
Club" → "1W Private Club").

Links carry names too, so:

- **Socials:** a team's social link is dropped when its host or handle carries
  the brand, through the same filter as VK/Telegram/Discord. Unbranded links
  stay: a FACEIT team id, a YouTube channel id, `@BBTEAMCS2`, `team33_official`,
  `SBETeam`. On the live pages, BC.Game loses its site, Instagram, Twitter, Twitch
  and YouTube. BetBoom loses its site, Facebook, Instagram and Twitter. PARIVISION
  loses Instagram, TikTok and Twitter. 1win loses Instagram and Twitter.
  Betclic Apogee loses its site, Facebook, Instagram, Twitter and Twitch.
- **Streams:** a stream channel named after a brand is dropped.
- **HLTV links:** HLTV finds a page by its id and ignores the slug.
  `/matches`, `/team`, `/events` and `/stats/matches/mapstatsid` all redirect
  `<id>/<anything>` to the right page. So a branded slug is rewritten by the
  same rules: `/matches/2398001/b8-vs-fnatic-stake-ranked-episode-4` becomes
  `…/b8-vs-fnatic-starladder-ranked-episode-4`.
- **Liquipedia links:** Liquipedia addresses a page by its name, so a branded
  link becomes the page's id, `index.php?curid=<wgArticleId>`, which opens the
  same article.
- **Flairs:** a subreddit flair anchor carrying the brand (`#betboom-logo`) is
  skipped, and the team gets its country flag.

All of this happens on a copy, at the last moment before rendering. The bracket
lookup, overtime rows and flag directory all match on the real names, and the
panel's Liquipedia boxes and the link cache keep the real addresses.

Anything the rules miss is still caught. The finished title and body are
scanned for these brands and about twenty other betting and skin-gambling
names that sponsor CS (Stake, GG.BET, 1xBet, Parimatch, Rainbet, CSGORoll and
others). Anything found is named in the run log and in the panel's "Missing"
note. A **scheduled** thread that still names one is filled in and flaired but
*not* submitted: its submit page stops with the brand named, for you to edit
out. Short or ordinary-looking words carry word boundaries, so "Paris",
"mistakes" and "stakes" don't count. The bare word "stake" does, so a highlight
titled "…at stake" would be flagged; that only adds a note, nothing is
rewritten.

To add a team, add a line to `GAMBLING_NAME_RULES` (and its brand to
`GAMBLING_TERMS`) in `src/censor.js`.

**Bracket.** The match is found by the two team names. The score is used only
when they have already met in another round of the same event; if Liquipedia's
cell is still on an earlier map (1-1 on a finished 2-1), HLTV's score decides
who won. The winner's parent match is the next round; the loser's next unplayed
slot in the other section is the drop. Either slot may still be TBA — the two
teams playing for it are read from the feeder matches under that slot, and
printed as `A or B` rather than dropping the line.

Round names lose the word "Bracket" (`Upper Bracket Final` → `Upper Final`). A
loss in the upper bracket is `drop to the Lower bracket`, not the specific
lower-round title.

Finding the round name is the fiddly part, because a bracket is not one column
list. A double-elimination group is rendered as several *sections*, each with its
own header row followed by its trees:

```
.brkts-bracket
  .brkts-round-header    Upper Bracket QF | Upper Bracket SF | Qualified
  .brkts-round-body      (upper bracket trees)
  .brkts-round-header    Lower Bracket QF | Lower Bracket SF | Qualified
  .brkts-round-body      (lower bracket trees)
```

So a match's column is counted back from *its own section's* last playable
column, and trailing "Qualified" columns are skipped — they are qualification
slots, not rounds. Counting them was what made an upper bracket quarter-final
report that its winner advanced to "Qualified".

Sections aren't always side by side at the top, though. A bracket where both
halves run into one grand final nests the lower half, header row and all,
*inside* the grand final's tree:

```
.brkts-bracket
  .brkts-round-header    Upper Bracket QF | Upper SF | Upper Final | Grand Final
  .brkts-round-body      (the grand final)
    .brkts-round-lower
      .brkts-round-body    (the upper final, and the upper half under it)
      .brkts-round-header  Lower Bracket Round 1 | Lower QF | Lower SF | Lower Final
      .brkts-round-body    (the lower final, and the lower half under it)
```

Reading only the top-level header put every lower-bracket match under the upper
header. At Stake Ranked Episode 4, Fnatic won Lower Bracket Round 1 and the
thread said they "advance to Upper Quarter Finals". Losers of upper-bracket
matches also got no drop line, because their lower-bracket match was read as an
upper one. So the header that applies to a match is the nearest one before *any*
of its ancestors, and columns are counted within the tree that header heads. On
the five saved event pages (EWC 2026, IEM Beijing qualifier, BLAST Open Fall
2026, FISSURE Playground #3, Stake Ranked Episode 4), that changes only the
Stake Ranked results. The other 87 played matches give the same answers as
before.

Team names are compared both verbatim and with org words dropped, so the bracket
still resolves when HLTV says "Falcons" and Liquipedia says "Team Falcons" —
including when the Liquipedia team page failed to load and only HLTV's spelling
is available.

A section final (winning the upper bracket, say) has no parent match, so the
advance line is omitted rather than guessed at. Same for a grand final. The
loser of that section final can still get a drop line if they have already been
placed in the lower bracket.

**Team names.** The header and Team Information use Liquipedia's full name
("Team Vitality"); the VRS table, veto table and stats tables use HLTV's short
one ("Vitality"). That is what the sample does.

## Deviations from `../SampleBody.md`

The renderer reproduces the sample line-for-line (215 lines) except for the
deliberate differences below:

| Difference | Why |
|---|---|
| `𖦏` → `⊕` (20 lines) | requested fix; the sample's AWP glyph is U+1698F, a Miao vowel sign |
| `Team Spirit Spirit` → `Team Spirit` (1) | the sample concatenates the Liquipedia and HLTV names |
| `#spiritw-logo` → `#spirit-logo` (1) | the veto table's sample anchor is the *women's* team flair; every other line in the sample uses `#spirit-logo` |
| a stray `\t ` line (1) | dropped; Maps 1 and 3 have a plain blank line there |
| parenthesised asides stripped from highlights (6) | requested fix |
| extra social links (2) | Liquipedia lists two networks it did not when the sample was made — Facebook for Vitality, Bilibili for Spirit |
| `advances to the Semi Finals` → `advance to Semi Finals` | requested double-elim wording: plural verb, no "the", `A or B` when the next slot is TBA, and a drop line for the loser |

The sample's `NaN` after Spirit's last link is gone.

**One judgement call in the paren stripping.** HLTV splits some plays across
several clips and only a `(Part 1 - observer)` / `(Part 2 - REPLAY…)` marker
tells them apart, so stripping every aside left two identical links side by side.
Asides that begin with "Part" are kept; everything else goes. Say the word and
it strips those too.

**Also unreproduced, deliberately:** the sample's full-match-stats separator row
has six cells for five columns (`|:--|--:|--:|--:|--:|--:|`). That one *is*
copied verbatim — reddit ignores the extra cell, and it is what the format emits.

## Diagnostics

Every run is logged: each fetch with its status, byte count and duration; each
cache hit or miss; each parse result with counts (`roster: 5, coaches: 1`); and
what the bracket lookup searched for and found. On a failed fetch the log also
carries the response headers and a 400-character text excerpt of the body —
which is where Liquipedia and Cloudflare put the reason for a 403.

Nothing sensitive is recorded: public page URLs, element counts, and error
messages. Page contents are never logged beyond sizes and that failure excerpt.

**Getting a log out:**

- **Copy diagnostics** in the panel copies the run you just did. The button
  shows a count and turns amber on warnings, red on errors, so a thread that is
  quietly missing its team information is obvious before you post it.
- The **options page** keeps the last five runs, newest first, each with Copy
  and Show. Use this when you notice a problem after closing the tab.
- Everything is also in the page's devtools console, prefixed `[PMT]`.

The panel's status line already names what is missing in plain words, e.g.
`Body copied. Missing: Liquipedia event (HTTP 403); Liquipedia Spirit (HTTP 403).`

**Options page also has "Forget Liquipedia links"** — the link cache never
expires, so this is how a wrong search result gets undone. It only removes the
`lp:` keys, not your settings.

## Scheduled posting

**Schedule Post-Match Thread** keeps watching a match and posts the thread as
soon as it is over. Nobody has to be at the keyboard. It can be clicked at any
point: before the match starts, during it, or after it ends (in which case it
posts straight away). The button then shows how far the job has got, and
clicking it again cancels. The toolbar badge counts running jobs and turns into
a red `!` when one needs you. A desktop notification says when a thread went up
or when a job stopped.

It works like every other lookup here, in a real tab rather than a fetch
(`src/scheduler.js`):

1. **Watch.** The job gets its own inactive tab on the match page. Every
   *Check every* minutes (1 by default; set it in Options), that tab is sent to
   the match again at a fresh address, `…?pmt-check=<token>`. A start time more
   than 15 minutes away is slept towards, with a look every half hour in case
   HLTV moves the match. If you close the tab, or navigate it somewhere else, a
   new one opens at the next check and yours is left alone. Memory saver is told
   not to discard the tab.

   **It never reloads.** After Cloudflare's "Just a moment…" check has run in a
   tab, the page shown is the reply to a form the check submitted. Reloading it
   would re-send that form, so Chrome asks *"Confirm Form Resubmission"*. Nobody
   answers, the reload never happens, and the old page stays where it is. Up to
   2.4.2 the watch reloaded, so after a challenge it read the same stale `LIVE`
   page every minute, long after the match had ended, while those dialogs
   piled up. A plain visit never asks that. The token in the address also
   proves the page being read is the one just asked for. A check that finds
   anything else on screen logs `the watch tab did not load the match` and
   decides nothing. On the second one in a row, the tab is closed and replaced
   with a fresh one. Two check errors in a row (an error page, say) do the same.

   The log only records changes, so a long quiet match also gets a
   `still live` line every half hour. A quiet log then means the watch has
   stopped, not just that nothing changed. **Copy log** opens with the check
   count, the last check and what it saw, and the next check.
2. **Wait for the stats.** A match counts as over when the countdown reads
   `Match over` *or* the teams box shows a won/tie score, since a live page has
   no score there at all. The thread is not built until the Full Match Stats
   table and every finished map's stats tab are on the page. Those can trail
   `Match over` by a minute, and they make up most of the body. After five
   minutes the thread is built without them, because a forfeit never gets any.
3. **Build.** The content script in that same tab runs the normal Post-Match
   pipeline (the same fetches, cache and checks as clicking the button) and hands
   the title and body to the worker. This is a separate tab from the shared
   Google/Liquipedia tab on purpose: the shared tab gets navigated away during a
   build. A build that fails is retried twice, a minute apart.
4. **Submit.** The old.reddit submit page opens in a background tab. The title
   goes in the query string, as in the manual flow. The body is fetched from the
   worker rather than put in the URL. `reddit.js` applies the
   `Discussion | Esports` flair first, then reads it back from the form's
   preview, and only then fills in the body and clicks **submit**. Once reddit
   lands on `/comments/…`, the job is marked posted and the watch tab closes.

   Old reddit is also served from **www.reddit.com**, and a tab opened on
   old.reddit.com can end up there, so `reddit.js` runs on both hosts. It decides
   it is looking at old reddit from the markup (the `#newlink` form), not from
   the hostname. It also doesn't rely on the `#pmt-job` hash surviving the move:
   a submit page without one asks the worker whether its tab was opened for a
   scheduled thread. The first 2.3.0 build matched only old.reddit.com, so on a
   www page it never ran, and the job just sat in *posting*. Now, if the submit
   page hasn't asked for its thread within 2 minutes, the job stops as
   *needs you* and the message says where the tab actually ended up.

**Idle tabs wait in one tab group.** While a match is being watched, its tab
sits in a collapsed purple group titled `PMT scheduled`. A few matches being
watched are then one small chip in the tab strip. The posted thread's tab goes
back in there once it's posted.

*Idle* is the important word. **Chrome freezes the tabs of a group that has been
collapsed for a few minutes**, and a frozen tab runs nothing: no content script,
no message replies. A reload wakes the watch tab for about a second, which is
enough to read `Match over` and start the build, but not to finish it. In 2.4.0
every tab lived in the group: a build stalled a second in, all three attempts
timed out, and it finished 2½ hours later when someone opened the tab. So now a
tab only stays in the group while it is idle, and it is taken out for as long as
it has work to do:

| Tab | In the group | Out of it |
|---|---|---|
| watch tab | between checks | while it builds the thread (seconds), then back in |
| submit page | after the thread is posted | from opening until posted, and while it waits on you |
| shared Google/Liquipedia tab | never | it only exists during a build |

The group isn't the only reason Chrome freezes a tab. A later log showed the
watch tab frozen while it was *out* of the group (`"inGroup": false`): Chrome
freezes plain hidden tabs too. So the working pages also hold a **Web Lock**,
because Chrome leaves a page that holds one alone. The build holds
`pmt-build-<job>` and releases it when it finishes, so an idle watch tab can
still be frozen as usual. The submit page holds `pmt-submit-<job>` for as long
as it's open, and loses it when it navigates to the new thread. A manual run
takes no lock.

The worker also watches Chrome's `frozen` flag on its working tabs. A tab frozen
mid-build is logged (`Chrome froze the watch tab`) and taken out of the group.
A build that times out says whether Chrome had frozen the tab, and the retry's
reload wakes it. A build that reports in after its timeout but before the retry
is used. One that reports in after the job gave up is kept, not posted, so
**Copy body** has it.

**A busy tab strip is waited out.** Chrome refuses every tab edit (open, reload,
close, group) while it considers the tab strip busy, with *"Tabs cannot be
edited right now (user may be dragging a tab)"*. A drag is one cause. The moment
after a tab is clicked is another, so it happens with nobody dragging: a submit
page once failed to open that way while the user sat on an unrelated tab. Every
tab edit the extension makes (`tabEdit` in `background.js`) now retries for up to
30 s when it gets that error. If the submit page still won't open, the job tries
again a minute later, up to three times, before it asks for you.

**If the group is deleted or ungrouped, nothing breaks:**

- **Ungroup:** the tabs stay open and the group disappears. At its next check,
  an idle watch tab is put into a new collapsed group.
- **Close group:** this closes its tabs. Each job opens a new watch tab at its
  next check, in a new group, and carries on.
- **A tab you move into a group of your own** is left there.
- **Tabs that are working** aren't in the group anyway, so neither action
  affects a build or a submit.

New tabs open in the group's window. The group is only re-collapsed after a tab
joins if it was collapsed already, and Chrome expands it on its own when a
notification or **Go to the submit tab** brings one of its tabs forward. When
the only tab in the group leaves, Chrome deletes the group and a new one is made
the next time a tab joins. The group's id is kept in `chrome.storage.session`,
because group ids only last one browser session: an id remembered across a
restart could point at one of your own groups. A tab you put in a group of your
own is never moved.

**It cannot post twice.** Submit is clicked only after the worker gives a
go-ahead, and it gives one per job. That go-ahead is recorded before the click,
so a reloaded submit page, a duplicated tab or a worker restart all find it
already used. Only **Retry** in Options clears it, and Retry asks first if
submit had already been clicked.

**It stops and leaves the tab to you** rather than guess:

| Stop | What to do |
|---|---|
| reddit shows a captcha | solve it and press submit (it is never touched) |
| the flair would not apply, or did not stick | set it by hand and press submit |
| reddit answered with an error (e.g. *you are doing that too much*) | wait it out and press submit |
| no answer 90 s after submit | check the subreddit before retrying |
| **Submit scheduled threads automatically** is off | review the page and press submit |

A thread you finish by hand from that tab still counts as posted. A job gives up
(`failed`) if HLTV deletes the match, if the page will not load three times
running, if the build fails three times, or if the match is still not over 12
hours after its start time. If HLTV shows a challenge three checks running, a
notification asks you to pass it in the watch tab.

**Options → Scheduled threads** lists every job, newest first, with its state,
last check, the thread link once posted, anything the thread was missing, and a
per-job log. Cancel, Retry and Remove are there as well, plus **Copy title** /
**Copy body** for finishing a stuck thread by hand. Finished jobs are dropped
after a week.

There are two logs, and a bug report wants both:

- **The job log** (**Copy log** on the job): every check, the build, and each
  step on the submit page. `reddit.js` reports `page loaded` (with the host,
  whether the hash survived, and whether the old layout is there), `form found`,
  `flair picked`, `flair is on the form`, `title and body filled in` and
  `clicked submit` to the worker. A failed flair step also records what the
  page looked like (picker button, dropdown, label count, selector hit, preview
  text).
- **The run log** (Diagnostics, labelled `scheduled run`): the thread build
  itself, exactly as for a manual run. It ends at `run finished` and says
  nothing about reddit.

A scheduled thread gets whatever the pipeline could find, just like a manual run
does. If Liquipedia or search fails, it is posted with HLTV's details, and the
job lists what was missing. Turn auto-submit off if you would rather check each
one before it goes up.

## Panel, options, reddit

Same as the old-format build: title, highlights and body are all editable,
**Regenerate** re-renders without re-opening reddit, and the submit page opens as
a text post with the title filled in and the `Discussion | Esports` flair applied.
See `../../old_format/extension/README.md` for the flair selectors and the
generated `src/teams.js` flair table.
