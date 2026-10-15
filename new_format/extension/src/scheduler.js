/*
 * scheduler.js - "Schedule Post-Match Thread": watch an HLTV match until it is
 * over, then build the thread and post it to reddit with nobody at the keyboard.
 *
 * Loaded into the service worker by background.js (importScripts), so it uses
 * that file's tab helpers: navigate, runInTab, tabEdit, wait.
 *
 * Watching is done the way every other read in this extension is done - in a
 * real tab. Each job gets one inactive tab on the match page, sent back to the
 * match on every check (never reloaded - see checkUrl). A fetch would be
 * lighter, but HLTV answers fetches with Cloudflare's
 * interstitial often enough, and the thread is built by content.js reading the
 * live page anyway, so the tab doing the watching is also the tab that builds
 * the thread once the match is over. It is deliberately not the shared lookup
 * tab: that one is navigated to Google and Liquipedia halfway through a build,
 * which would pull the match page out from under content.js.
 *
 * A job lives in chrome.storage.local under `pmt:jobs`, so the worker being
 * shut down after 30 idle seconds loses nothing. Its states:
 *
 *   watching     looked at every checkMinutes until the page says "Match over"
 *                (sleeping towards the start time when that is far off)
 *   generating   content.js is running the normal Post-Match pipeline in the
 *                watch tab and reports back with `scheduledThread`
 *   submitting   the submit page is open; reddit.js fills in the body, applies
 *                and checks the flair, and asks for the one go-ahead to submit
 *   posted       the submit tab landed on the new thread
 *   attention    stopped short with the tab left open for a person: a captcha,
 *                reddit's rate limit, a flair that would not apply, or
 *                auto-submit switched off
 *   failed       gave up - match deleted, page gone, repeated build errors
 *   cancelled
 *
 * The one thing that must never happen is a thread posted twice. The submit
 * click is gated on `submitClickedAt`, set here under the jobs lock and cleared
 * only by an explicit Retry, so a reloaded submit page, a second tab or a worker
 * restart mid-submit all find the go-ahead already spent.
 */

var JOBS_KEY = 'pmt:jobs';
var SCHEDULE_ALARM = 'pmt-schedule';
var SCHEDULE_DEFAULTS = {
  subreddit: 'GlobalOffensive',
  flair: 'Discussion | Esports',
  checkMinutes: 1,
  autoSubmit: true
};
// the subreddit removes an unflaired post-match thread, so a scheduled one is
// always flaired even when the manual flow has been told not to bother
var REQUIRED_FLAIR = 'Discussion | Esports';

var ACTIVE_STATES = ['watching', 'generating', 'submitting'];
var FINISHED_STATES = ['posted', 'failed', 'cancelled'];

var STATS_GRACE_MS = 5 * 60000;       // after "Match over", how long to wait for the stats tables
var BUILD_TIMEOUT_MS = 5 * 60000;     // no word from the match page by then: build again
var SUBMIT_TIMEOUT_MS = 10 * 60000;   // no thread by then: hand it to a person
var UNSEEN_SUBMIT_MS = 2 * 60000;     // the submit page has not even asked for its thread by then
var GIVE_UP_MS = 12 * 3600000;        // still not over this long after the start time
var FAR_OFF_MS = 15 * 60000;          // a start further off than this is slept towards
var MAX_BUILD_ATTEMPTS = 3;
var MAX_SUBMIT_OPENS = 3;
var KEEP_FINISHED_MS = 7 * 24 * 3600000;
var HEARTBEAT_MS = 30 * 60000;        // a "still live" line this often, so a quiet log means something
var JOB_LOG_LIMIT = 40;

var checking = {};    // job id -> a check is in flight (this worker's lifetime only)
var alarmOn = null;   // what this worker last told chrome.alarms; null until known

function scheduleSettings() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(SCHEDULE_DEFAULTS, function (v) { resolve(v || SCHEDULE_DEFAULTS); });
  });
}

function checkInterval(settings) {
  var m = parseFloat(settings.checkMinutes);
  if (!(m > 0)) m = SCHEDULE_DEFAULTS.checkMinutes;
  // chrome.alarms will not fire more often than every 30 seconds
  return Math.min(30, Math.max(0.5, m)) * 60000;
}

function errorText(e) {
  return String((e && e.message) || e);
}

/* ------------------------------------------------------------------ jobs */

function readJobs() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([JOBS_KEY], function (v) { resolve((v && v[JOBS_KEY]) || {}); });
  });
}

var jobsLock = Promise.resolve();

// Read-modify-write, one at a time. Two messages landing together (the submit
// page asking for its go-ahead while a check finishes, say) must not each save
// a copy of the list that is missing the other's change. `change` is
// synchronous and edits the list in place.
function withJobs(change, readOnly) {
  var run = jobsLock.then(function () {
    return readJobs().then(function (jobs) {
      var out = change(jobs);
      var saved = readOnly ? Promise.resolve() : new Promise(function (resolve) {
        var patch = {};
        patch[JOBS_KEY] = jobs;
        chrome.storage.local.set(patch, resolve);
      });
      return saved.then(function () {
        syncAlarmAndBadge(jobs);
        return out;
      });
    });
  });
  jobsLock = run.catch(function () {});
  return run;
}

// Change one job; resolves with a copy of it afterwards, or null if it is gone.
function updateJob(id, change) {
  return withJobs(function (jobs) {
    var job = jobs[id];
    if (!job) return null;
    change(job);
    return JSON.parse(JSON.stringify(job));
  });
}

function jobList(jobs) {
  return Object.keys(jobs).map(function (k) { return jobs[k]; });
}

function jobNote(job, msg, data) {
  var entry = { at: Date.now(), msg: msg };
  if (data !== undefined) entry.data = data;
  job.log = (job.log || []).concat([entry]).slice(-JOB_LOG_LIMIT);
  job.updatedAt = entry.at;
  console.info('[PMT schedule ' + job.id + '] ' + msg, data === undefined ? '' : data);
}

function failJob(job, reason) {
  job.state = 'failed';
  job.error = reason;
  jobNote(job, 'gave up: ' + reason);
}

function needsPerson(job, reason) {
  job.state = 'attention';
  job.error = reason;
  jobNote(job, 'needs a person: ' + reason);
}

function matchIdOf(url) {
  return (/^https:\/\/www\.hltv\.org\/matches\/(\d+)(?:[/?#]|$)/.exec(url || '') || [])[1] || '';
}

function latestJobFor(jobs, matchId) {
  var best = null;
  jobList(jobs).forEach(function (j) {
    if (j.matchId === matchId && (!best || j.createdAt > best.createdAt)) best = j;
  });
  return best;
}

// The alarm only runs while something is being watched, and the toolbar badge
// counts what is: a number while jobs are running, a red "!" while one is
// waiting on a person. Called under the jobs lock after every write, so the
// alarm calls go out in the same order as the writes that caused them.
function syncAlarmAndBadge(jobs) {
  var list = jobList(jobs);
  var active = list.filter(function (j) { return ACTIVE_STATES.indexOf(j.state) >= 0; }).length;
  var stuck = list.filter(function (j) { return j.state === 'attention'; }).length;
  if (active && alarmOn !== true) {
    chrome.alarms.create(SCHEDULE_ALARM, { periodInMinutes: 0.5 });
    alarmOn = true;
  } else if (!active && alarmOn !== false) {
    chrome.alarms.clear(SCHEDULE_ALARM);
    alarmOn = false;
  }
  chrome.action.setBadgeBackgroundColor({ color: stuck ? '#c0392b' : '#2d6ca2' });
  chrome.action.setBadgeText({ text: stuck ? '!' : active ? String(active) : '' });
  chrome.action.setTitle({
    title: 'HLTV Post-Match Thread' +
      (active ? ' - ' + active + ' scheduled' : '') +
      (stuck ? ' - ' + stuck + ' waiting on you' : '')
  });
}

/* -------------------------------------------------------------- the tabs */

function getTab(id) {
  return new Promise(function (resolve) {
    if (id == null) return resolve(null);
    chrome.tabs.get(id, function (t) {
      resolve(chrome.runtime.lastError ? null : (t || null));
    });
  });
}

/*
 * Idle scheduled tabs wait in one tab group, created collapsed, so a few
 * matches being watched are one small chip in the tab strip rather than a row
 * of reloading HLTV pages. It is re-collapsed after a tab joins only if it was
 * collapsed already - someone who opened it up to watch keeps it open - and
 * Chrome expands it by itself whenever one of its tabs is brought forward.
 *
 * Only *idle* tabs, though. Chrome freezes the tabs of a group that has sat
 * collapsed for a few minutes, and a frozen tab runs nothing - no content
 * script, no message replies. A fresh load wakes one for about a second, which is
 * enough to read "Match over" and start the build, not to finish it: a build
 * stalled a second in, three attempts timed out, and it completed two and a
 * half hours later when someone opened the tab. So a tab is taken out of the
 * group for as long as it has work to do (see ungroupTab) - the watch tab
 * while it builds, the submit page until the thread is posted - and put back
 * when it is idle again. A submit page waiting on a person stays out, where
 * they can see it. The shared lookup tab is never grouped: it only exists
 * while a build is running.
 *
 * The group's id lives in chrome.storage.session: group ids only mean
 * something for one browser session, so an id remembered across a restart
 * could name some group of the user's own. A new group is made whenever the
 * remembered one is gone (closed, ungrouped, emptied, or from before the
 * restart).
 */
var GROUP_KEY = 'pmt:group';
var GROUP_TITLE = 'PMT scheduled';
var GROUP_COLOR = 'purple';   // the Schedule button's colour
var scheduledGroup = null;    // { id, windowId } as last seen
var groupLock = Promise.resolve();

function rememberGroup(g) {
  scheduledGroup = g;
  if (chrome.storage.session) {
    var patch = {};
    patch[GROUP_KEY] = g;
    chrome.storage.session.set(patch, function () { void chrome.runtime.lastError; });
  }
}

// The remembered group if it still exists (as a tabGroups.TabGroup), else null.
function liveGroup() {
  if (!chrome.tabGroups) return Promise.resolve(null);
  var remembered = scheduledGroup ? Promise.resolve(scheduledGroup) : new Promise(function (resolve) {
    if (!chrome.storage.session) return resolve(null);
    chrome.storage.session.get([GROUP_KEY], function (v) {
      void chrome.runtime.lastError;
      resolve((v && v[GROUP_KEY]) || null);
    });
  });
  return remembered.then(function (g) {
    if (!g) return null;
    return new Promise(function (resolve) {
      chrome.tabGroups.get(g.id, function (tg) {
        if (chrome.runtime.lastError || !tg) {
          scheduledGroup = null;
          return resolve(null);
        }
        scheduledGroup = { id: tg.id, windowId: tg.windowId };
        resolve(tg);
      });
    });
  });
}

// Put a tab in the group, making the group first if there is none. Serialised,
// or two tabs opened together would each start a group of their own. Every
// edit goes through tabEdit (background.js), which waits out a busy tab strip.
function addToScheduledGroup(tabId) {
  var run = groupLock.then(function () {
    return liveGroup().then(function (g) {
      var opts = g ? { groupId: g.id, tabIds: [tabId] } : { tabIds: [tabId] };
      return tabEditP(function (cb) { chrome.tabs.group(opts, cb); }).then(function (groupId) {
        if (groupId == null) throw new Error('no group id');
        var props = !g ? { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: true }
          : g.collapsed ? { collapsed: true } : null;
        rememberGroup({ id: groupId, windowId: g ? g.windowId : null });
        if (!props) return groupId;
        return tabEditP(function (cb) { chrome.tabGroups.update(groupId, props, cb); }).then(function (tg) {
          if (tg) rememberGroup({ id: tg.id, windowId: tg.windowId });
          return groupId;
        }, function () { return groupId; });
      }).catch(function (e) {
        // a tab that will not group is still a working tab
        console.warn('[PMT schedule] could not group tab ' + tabId, errorText(e));
        return null;
      });
    });
  });
  groupLock = run.catch(function () {});
  return run;
}

function inOurGroup(t) {
  return !!(t && scheduledGroup && t.groupId === scheduledGroup.id);
}

// Out of the group while it works, so Chrome cannot freeze it mid-task. Only
// a tab in *our* group is moved - one the user put in a group of theirs is
// left where they put it.
function ungroupTab(tabId) {
  return liveGroup().then(function () { return getTab(tabId); }).then(function (t) {
    if (!inOurGroup(t)) return;
    return tabEditP(function (cb) { chrome.tabs.ungroup(tabId, cb); }).catch(function (e) {
      console.warn('[PMT schedule] could not ungroup tab ' + tabId, errorText(e));
    });
  });
}

// Back into the group once idle - unless it is gone, or in a group already.
function regroupTab(tabId) {
  return getTab(tabId).then(function (t) {
    if (!t || (t.groupId != null && t.groupId !== -1)) return;
    return addToScheduledGroup(tabId);
  });
}

// Chrome flags a frozen tab. One of ours frozen while it is meant to be
// working is noted once in the job log and taken out of the group, which is
// what lifts a collapsed group's freeze. (A freeze from anything else - energy
// saver, say - cannot be lifted from here; the build timeout then retries on a
// fresh load.)
function thawIfFrozen(job, tabId) {
  return liveGroup().then(function () { return getTab(tabId); }).then(function (t) {
    if (!t || t.frozen !== true) return;
    var grouped = inOurGroup(t);
    return updateJob(job.id, function (j) {
      if (j.frozenSeen === tabId) return;
      j.frozenSeen = tabId;
      jobNote(j, 'Chrome froze the ' + (tabId === j.watchTabId ? 'watch' : 'submit') + ' tab',
        { inGroup: grouped, state: j.state });
    }).then(function () {
      if (grouped) return ungroupTab(tabId);
    });
  });
}

// An inactive tab, opened in the group's window (so grouping never has to move
// it between windows). `opts.created(tabId)` runs, and is waited for, before
// anything else; `opts.grouped: false` leaves the tab out of the group - one
// that has work to do from the moment it opens.
function openScheduledTab(url, opts) {
  opts = opts || {};
  return liveGroup().then(function (g) {
    var props = { url: url, active: false };
    if (g) props.windowId = g.windowId;
    var create = function () { return tabEditP(function (cb) { chrome.tabs.create(props, cb); }); };
    return create().catch(function (e) {
      if (props.windowId == null) throw e;
      // that window will not take tabs any more; fall back to the default one
      delete props.windowId;
      return create();
    }).then(function (t) {
      if (!t) throw new Error('could not open a tab');
      // hours in the background is exactly what memory saver discards, and a
      // tab discarded mid-build takes the thread down with it
      tabEdit(function (cb) { chrome.tabs.update(t.id, { autoDiscardable: false }, cb); }, function () {});
      return Promise.resolve(opts.created && opts.created(t.id))
        .then(function () { if (opts.grouped !== false) return addToScheduledGroup(t.id); })
        .then(function () { return t.id; }, function () { return t.id; });
    });
  });
}

// Only while it is still on the match: if someone has taken the tab somewhere
// else it is theirs now.
function closeWatchTab(job) {
  return getTab(job && job.watchTabId).then(function (t) {
    if (t && matchIdOf(t.url) === job.matchId) {
      tabEdit(function (cb) { chrome.tabs.remove(t.id, cb); }, function () {});
    }
  });
}

/*
 * Every look at the match is a fresh visit to a fresh address; the tab is
 * never reloaded. Once Cloudflare's "Just a moment..." check has run in it,
 * the page on screen is the answer to that check's form POST, and reloading a
 * POST makes Chrome ask "Confirm Form Resubmission". Nobody is there to
 * answer, the reload never happens, and the old page simply stays put: one
 * watch read the same frozen "LIVE" page check after check, long after the
 * match had ended. Going to the match afresh is always a plain GET.
 *
 * The token in the address is also how a check knows that the page it reads
 * is the one it just asked for, and not whatever was left on screen.
 */
function checkUrl(job, token) {
  return job.matchUrl + '?pmt-check=' + token;
}

// The job's own tab, sent to the match again - or a fresh one when it has been
// closed, taken elsewhere (the one left behind is not touched again), or has
// stopped loading pages (replaceWatchTab: closed, and a new one opened).
function watchTab(job) {
  var token = Date.now().toString(36);
  var url = checkUrl(job, token);
  return getTab(job.watchTabId).then(function (t) {
    var onMatch = !!t && matchIdOf(t.url || t.pendingUrl) === job.matchId;
    if (onMatch && !job.replaceWatchTab) {
      return navigate(t.id, url).then(function () { return { tabId: t.id, token: token }; });
    }
    return openScheduledTab('about:blank').then(function (id) {
      return updateJob(job.id, function (j) {
        if (onMatch) jobNote(j, 'replaced the watch tab with a fresh one');
        j.watchTabId = id;
        j.replaceWatchTab = false;
      }).then(function () {
        if (onMatch) tabEdit(function (cb) { chrome.tabs.remove(t.id, cb); }, function () {});
        return navigate(id, url);
      }).then(function () { return { tabId: id, token: token }; });
    });
  });
}

// A content script is only listening once the page has run it, which can be a
// beat after the load reports complete.
function sendToTab(tabId, msg, tries) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, msg, function (res) {
      var err = chrome.runtime.lastError;
      if (!err) return resolve(res);
      if (tries > 1 && /receiving end does not exist|could not establish connection/i.test(err.message)) {
        return wait(1000)
          .then(function () { return sendToTab(tabId, msg, tries - 1); })
          .then(resolve, reject);
      }
      reject(new Error(err.message));
    });
  });
}

/* ------------------------------------------------------------- the check */

/*
 * Runs inside the watch tab. Self-contained, since executeScript sends only the
 * function's source.
 *
 * Finished is either signal on its own: the countdown reads "Match over", or
 * the teams box shows a won/tie score - it has no score at all until the
 * series is decided, however many maps are in.
 *
 * The stats tables are looked at too, because they can trail "Match over" by a
 * minute: the Full Match Stats table (#all-content, one table per team) and one
 * tab per finished map. Those are most of the thread's body.
 */
function readMatchState() {
  function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  var box = document.querySelector('.teamsBox');
  var cd = document.querySelector('.timeAndEvent .countdown');
  var time = document.querySelector('.timeAndEvent .time[data-unix]');
  var countdown = txt(cd);
  var scoreOf = function (n) {
    var g = '.team' + n + '-gradient ';
    return txt(box && box.querySelector(g + '.won, ' + g + '.lost, ' + g + '.tie'));
  };
  var decided = !!(box && box.querySelector(
    '.team1-gradient .won, .team2-gradient .won, .team1-gradient .tie, .team2-gradient .tie'));

  var missing = [];
  Array.prototype.forEach.call(document.querySelectorAll('.mapholder'), function (h) {
    var over = h.querySelector('.results-left.won, .results-left.lost, .results-right.won, .results-right.lost');
    var a = h.querySelector('.results-center-stats a');
    var id = ((a && a.getAttribute('href')) || '').match(/\/mapstatsid\/(\d+)\//);
    if (!over || !id) return;
    var tab = document.getElementById(id[1] + '-content');
    if (!tab || !tab.querySelector('table.totalstats')) missing.push(txt(h.querySelector('.mapname')));
  });
  var allTables = document.querySelectorAll('#all-content table.totalstats').length;
  var head = (document.title || '') + ' ' + (document.body ? document.body.textContent.slice(0, 2000) : '');

  return {
    url: location.href,
    loadedAt: performance.timeOrigin,
    title: document.title,
    isMatchPage: !!box,
    challenged: !box && /just a moment|verify you are human|checking your browser/i.test(head),
    countdown: countdown,
    unix: parseInt((cd && cd.getAttribute('data-unix')) ||
                   (time && time.getAttribute('data-unix')) || '0', 10) || 0,
    live: !!(cd && (cd.classList.contains('countdown-live') || /^live$/i.test(countdown))),
    over: /match over/i.test(countdown) || decided,
    deleted: /deleted|cancel/i.test(countdown),
    teams: box ? Array.prototype.map.call(box.querySelectorAll('.teamName'), txt).slice(0, 2) : [],
    score: [scoreOf(1), scoreOf(2)],
    event: txt(document.querySelector('.timeAndEvent .event a')),
    statsReady: allTables >= 2 && !missing.length,
    statsTables: allTables,
    mapsMissingStats: missing
  };
}

// A load can finish on Cloudflare's interstitial, which reloads itself into
// the match a few seconds later - or on a page slow enough not to have built
// the teams box yet - or not have happened at all, leaving the previous page
// on screen (`stale`: the address lacks this check's token). In every case,
// look again before judging.

function readMatchStateSettled(tabId, token, matchId, startedAt, left) {
  if (left == null) left = 10;

  return runInTab(tabId, readMatchState).then(function (s) {
    var hasToken =
      String(s.url || '').indexOf('pmt-check=' + token) >= 0;

    var freshMatchPage =
      s.isMatchPage &&
      matchIdOf(s.url) === matchId &&
      s.loadedAt >= startedAt - 1000;

    s.stale = !hasToken && !freshMatchPage;

    if ((s.stale || !s.isMatchPage) && left > 1) {
      return wait(1500).then(function () {
        return readMatchStateSettled(
          tabId, token, matchId, startedAt, left - 1
        );
      });
    }

    return s;
  }, function (e) {
    if (isMissingTabError(e) || left <= 1) throw e;

    return wait(1500).then(function () {
      return readMatchStateSettled(
        tabId, token, matchId, startedAt, left - 1
      );
    });
  });
}


function phaseOf(s) {
  if (s.challenged) return 'challenged';
  if (!s.isMatchPage) return 'no match page';
  if (s.over) return 'over';
  return s.live ? 'live' : 'not started';
}

function checkJob(job) {
  var id = job.id;
  var startedAt = Date.now();
  checking[id] = true;
  return scheduleSettings().then(function (settings) {
    return watchTab(job).then(function (w) {
      return readMatchStateSettled(w.tabId, w.token, job.matchId, startedAt).then(function (s) {return judge(id, w.tabId, s, settings);});
    });
  }).catch(function (e) {
    return updateJob(id, function (j) {
      if (j.state !== 'watching') return;
      j.errors = (j.errors || 0) + 1;
      j.nextCheckAt = Date.now() + 60000;
      jobNote(j, 'check failed', { error: errorText(e), inARow: j.errors });
      // an error page, a dialog, a wedged tab: a new tab is the cheap cure
      if (j.errors >= 2) j.replaceWatchTab = true;
      if (j.errors >= 10) failJob(j, 'the match page could not be read ten times running (' + errorText(e) + ')');
    }).then(function (j) {
      if (j && j.state === 'failed') announce(j);
    });
  }).then(function () {
    delete checking[id];
  });
}

function judge(id, tabId, s, settings) {
  var now = Date.now();
  var interval = checkInterval(settings);
  var build = false;
  var tell = null;
  return updateJob(id, function (j) {
    if (j.state !== 'watching') return;   // cancelled while the page was loading
    j.watchTabId = tabId;
    j.lastCheckAt = now;

    // What is on screen is not the page this check asked for, so it says
    // nothing about the match. Say so, look again soon, and on the second
    // time running give up on the tab: a new one has no dialog stuck in it.
    if (s.stale) {
      j.staleChecks = (j.staleChecks || 0) + 1;
      jobNote(j, 'the watch tab did not load the match', {
        showing: String(s.url || '').split('?')[0] || s.title, inARow: j.staleChecks
      });
      if (j.staleChecks >= 2) j.replaceWatchTab = true;
      j.nextCheckAt = now + Math.min(interval, 60000);
      return;
    }
    j.staleChecks = 0;

    // Remember HLTV's new URL after a match gets renamed.
    var currentUrl = String(s.url || '').split(/[?#]/)[0];

    if (s.isMatchPage &&
        matchIdOf(currentUrl) === j.matchId &&
        j.matchUrl !== currentUrl) {
      j.matchUrl = currentUrl;
      jobNote(j, 'match URL updated', { url: currentUrl });
    }

    var phase = phaseOf(s);
    var before = j.lastSeen && j.lastSeen.phase;
    var lastNoteAt = j.log && j.log.length ? j.log[j.log.length - 1].at : 0;
    j.checks = (j.checks || 0) + 1;
    j.errors = 0;
    j.lastSeen = {
      phase: phase, countdown: s.countdown, score: s.score,
      unix: s.unix || (j.lastSeen && j.lastSeen.unix) || 0
    };
    if (s.teams.length === 2 && s.teams[0] && s.teams[1]) {
      j.label = s.teams.join(' vs ') + (s.event ? ' / ' + s.event : '');
    }
    if (phase !== before) {
      jobNote(j, phase, { countdown: s.countdown, score: s.score.join(':') });
    } else if (now - lastNoteAt >= HEARTBEAT_MS) {
      // a quiet log is otherwise indistinguishable from a watch that stopped
      jobNote(j, 'still ' + phase, { countdown: s.countdown, checks: j.checks });
    }
    j.nextCheckAt = now + interval;

    if (s.challenged) {
      // a person can pass it in the tab, and the next check finds the match
      j.challenges = (j.challenges || 0) + 1;
      if (j.challenges === 3) {
        tell = ['HLTV is showing a challenge',
                'Open the watching tab for ' + j.label + ' and pass the check - it keeps being refreshed.'];
      }
      return;
    }
    j.challenges = 0;

    if (!s.isMatchPage) {
      j.misses = (j.misses || 0) + 1;
      if (j.misses >= 3) failJob(j, 'the HLTV match page did not load (' + (s.title || s.url) + ')');
      return;
    }
    j.misses = 0;

    if (s.deleted) return failJob(j, 'HLTV says "' + s.countdown + '"');

    if (s.over) {
      if (!j.overSince) j.overSince = now;
      // A thread posted without the stats tables is missing most of its body,
      // so give HLTV a few minutes to put them up - but not forever: a forfeit
      // never gets any.
      if (!s.statsReady && now - j.overSince < STATS_GRACE_MS) {
        j.nextCheckAt = now + Math.min(interval, 60000);
        jobNote(j, 'waiting for the stats tables', { tables: s.statsTables, missing: s.mapsMissingStats });
        return;
      }
      if (!s.statsReady) jobNote(j, 'stats tables still missing - building anyway', { missing: s.mapsMissingStats });
      j.state = 'generating';
      j.buildStartedAt = now;
      j.buildAttempts = (j.buildAttempts || 0) + 1;
      jobNote(j, 'building the thread', { attempt: j.buildAttempts, score: s.score.join(':') });
      build = true;
      return;
    }

    var start = j.lastSeen.unix;
    if (now - Math.max(j.createdAt, start) > GIVE_UP_MS) {
      return failJob(j, 'the match was still not over 12 hours after it was due to start');
    }
    // Far from the start: sleep towards it, but look in every half hour in case
    // HLTV brings it forward.
    if (!s.live && start - now > FAR_OFF_MS) {
      j.nextCheckAt = now + Math.min(30 * 60000, Math.max(interval, start - now - 5 * 60000));
    }
  }).then(function (job) {
    if (!job) return;
    if (job.state === 'failed') announce(job);
    else if (tell) notify(job, tell[0], tell[1]);
    // out of the group first: a build in a collapsed group's tab gets frozen
    if (build) return ungroupTab(tabId).then(function () { return requestBuild(job, tabId); });
    // still watching: an idle watch tab belongs in the group, including after
    // the group was ungrouped or deleted out from under it
    if (job.state === 'watching') return regroupTab(tabId);
  });
}

/* ------------------------------------------------------------- the build */

function requestBuild(job, tabId) {
  return sendToTab(tabId, { type: 'scheduledGenerate', jobId: job.id }, 15).then(function (res) {
    if (!res || !res.accepted) throw new Error((res && res.error) || 'no answer');
  }).catch(function (e) {
    return buildFailed(job.id, 'the match page would not start the build: ' + errorText(e));
  });
}

function buildFailed(id, error) {
  return updateJob(id, function (j) {
    if (j.state !== 'generating') return;
    if ((j.buildAttempts || 0) >= MAX_BUILD_ATTEMPTS) return failJob(j, error);
    j.state = 'watching';
    j.nextCheckAt = Date.now() + 60000;
    jobNote(j, 'build failed, trying again in a minute', { error: error });
  }).then(function (j) {
    if (!j) return;
    if (j.state === 'failed') announce(j);
    return regroupTab(j.watchTabId);   // idle again either way
  });
}

// A build that reports in after its job stopped waiting for it. Not posted -
// the job gave up, and the thread may well have been posted by hand since -
// but kept, so Copy title / Copy body in Options have something to copy.
function lateBuild(msg) {
  return updateJob(msg.jobId, function (j) {
    if (j.state !== 'failed' || j.body) return;
    j.title = msg.title;
    j.body = msg.body;
    j.notes = msg.notes || [];
    jobNote(j, 'the build finished after the job had given up - not posted; ' +
      'Copy body in Options to post it by hand, or Retry', { bodyLength: msg.body.length });
  });
}

// content.js finished the normal Post-Match pipeline in the watch tab.
function threadBuilt(msg) {
  if (!msg.ok || !msg.title || !msg.body) {
    return buildFailed(msg.jobId, msg.error || 'the build produced no thread');
  }
  return scheduleSettings().then(function (settings) {
    var open = false;
    var late = false;
    return updateJob(msg.jobId, function (j) {
      if (j.state === 'failed') late = true;
      // a build that outlived its timeout but beat the retry is as good as any
      var slow = j.state === 'watching' && !!j.overSince;
      if (j.state !== 'generating' && !slow) return;
      if (slow) jobNote(j, 'a build that had timed out reported in after all - using it');
      j.title = msg.title;
      j.body = msg.body;
      j.notes = msg.notes || [];
      j.gamblingLeft = msg.gamblingLeft || [];
      j.subreddit = settings.subreddit || SCHEDULE_DEFAULTS.subreddit;
      j.flair = settings.flair || REQUIRED_FLAIR;
      j.state = 'submitting';
      j.submitOpenedAt = Date.now();
      j.submitPageSeenAt = undefined;
      j.submitOpenFailures = 0;
      j.reopenSubmitAt = undefined;
      jobNote(j, 'thread built, opening the submit page',
        { title: j.title, bodyLength: j.body.length, missing: j.notes });
      open = true;
    }).then(function (job) {
      if (late) return lateBuild(msg);
      if (!open || !job) return;
      return openSubmitTab(job).then(function () { return regroupTab(job.watchTabId); });
    });
  });
}

// Title in the query, where the manual flow already puts it; flair and job id
// in the hash, which never reaches reddit. The body is asked for by reddit.js -
// it is ~10 KB and has no business in a URL.
function submitUrlFor(job) {
  return 'https://old.reddit.com/r/' + encodeURIComponent(job.subreddit) +
    '/submit?selftext=true&title=' + encodeURIComponent(job.title) +
    '#pmt-flair=' + encodeURIComponent(job.flair) + '&pmt-job=' + encodeURIComponent(job.id);
}

// The tab id is recorded the moment the tab exists, before it is grouped: a
// submit page that lost its hash is recognised by that id, and it may ask
// before grouping has finished.
// Opened outside the group: it has work to do from the start, and stays out
// until the thread is posted.
function openSubmitTab(job) {
  return openScheduledTab(submitUrlFor(job), {
    grouped: false,
    created: function (tabId) {
      return updateJob(job.id, function (j) { j.submitTabId = tabId; });
    }
  }).catch(function (e) {
    // tabEdit has already waited out a busy tab strip; if Chrome still says no,
    // the loop tries again in a minute (reopenSubmitAt) before asking a person
    return updateJob(job.id, function (j) {
      if (j.state !== 'submitting') return;
      j.submitOpenFailures = (j.submitOpenFailures || 0) + 1;
      if (j.submitOpenFailures >= MAX_SUBMIT_OPENS) {
        return needsPerson(j, 'could not open the submit page: ' + errorText(e));
      }
      j.submitTabId = null;
      j.reopenSubmitAt = Date.now() + 60000;
      jobNote(j, 'could not open the submit page, trying again in a minute',
        { error: errorText(e), attempt: j.submitOpenFailures });
    }).then(function (j) {
      if (j && j.state === 'attention') announce(j);
    });
  });
}

function reopenSubmitTab(job) {
  return updateJob(job.id, function (j) {
    if (j.state !== 'submitting' || !j.reopenSubmitAt) return;
    j.reopenSubmitAt = undefined;
    j.submitOpenedAt = Date.now();   // the page's own timeouts count from here
    jobNote(j, 'opening the submit page again');
  }).then(function (j) {
    if (j && j.state === 'submitting') return openSubmitTab(j);
  });
}

/* ------------------------------------------------------ the submit page */

// Asked by reddit.js with the job id from the hash - or, when the hash did not
// survive (old reddit can be served from www.reddit.com, and the hop there is
// not guaranteed to carry it), with no id, in which case the tab we opened for
// the job is what identifies it.
function jobForSubmit(msg, sender) {
  var tabId = sender.tab ? sender.tab.id : null;
  return Promise.all([scheduleSettings(), readJobs()]).then(function (r) {
    var settings = r[0], jobs = r[1];
    var id = msg.jobId;
    if (!id) {
      jobList(jobs).forEach(function (j) {
        if (tabId != null && j.submitTabId === tabId && j.state === 'submitting') id = j.id;
      });
      if (!id) return { ok: false, none: true, error: 'no scheduled thread for this tab' };
    }
    return updateJob(id, function (j) {
      if (j.state === 'submitting' && j.submitTabId == null && tabId != null) j.submitTabId = tabId;
      if (j.state === 'submitting') {
        j.submitPageSeenAt = j.submitPageSeenAt || Date.now();
        jobNote(j, 'submit page asked for the thread',
          { found: msg.jobId ? 'by the id in the URL' : 'by tab - the URL had lost the job id', page: msg.page });
      }
    }).then(function (j) {
      if (!j) return { ok: false, error: 'this scheduled thread no longer exists' };
      if (j.state !== 'submitting') return { ok: false, error: 'this scheduled thread is ' + j.state };
      // a thread still naming a gambling brand would only be removed by the
      // subreddit's filters: fill it in, but leave the submit to a person
      var held = j.gamblingLeft && j.gamblingLeft.length
        ? 'it still names a gambling brand (' + j.gamblingLeft.join(', ') + ') - edit that out, then press submit'
        : '';
      return {
        ok: true, id: j.id, title: j.title, body: j.body, flair: j.flair, subreddit: j.subreddit,
        autoSubmit: settings.autoSubmit !== false && !held, holdReason: held,
        clicked: !!j.submitClickedAt
      };
    });
  });
}

// A step reported by reddit.js, so the job log says what happened on the
// submit page and not just that nothing came back from it.
function submitPageLog(msg) {
  if (!msg.jobId) return Promise.resolve();
  return updateJob(msg.jobId, function (j) {
    jobNote(j, 'reddit: ' + msg.msg, msg.data);
  });
}

// The single go-ahead to click submit. See the note at the top.
function submitGoAhead(msg, sender) {
  var go = false;
  return updateJob(msg.jobId, function (j) {
    if (j.state !== 'submitting' || j.submitClickedAt) return;
    j.submitClickedAt = Date.now();
    if (sender.tab) j.submitTabId = sender.tab.id;
    jobNote(j, 'clicking submit');
    go = true;
  }).then(function () { return { go: go }; });
}

function submitStopped(msg) {
  return updateJob(msg.jobId, function (j) {
    if (j.state !== 'submitting') return;
    j.stopReason = msg.reason || 'error';
    needsPerson(j, msg.error || 'stopped on the submit page');
  }).then(function (j) {
    if (j && j.state === 'attention') announce(j);
  });
}

// reddit.js on a /comments/ page reached from a submit page. Matched by tab, so
// a thread finished by hand after a stop (a captcha, say) still counts.
function submitLanded(msg, sender) {
  if (!sender.tab) return Promise.resolve();
  return withJobs(function (jobs) {
    var hit = null;
    jobList(jobs).forEach(function (j) {
      if (j.submitTabId === sender.tab.id && (j.state === 'submitting' || j.state === 'attention')) hit = j;
    });
    if (!hit) return null;
    hit.state = 'posted';
    hit.threadUrl = msg.url;
    hit.error = undefined;
    jobNote(hit, 'posted', { url: msg.url });
    return JSON.parse(JSON.stringify(hit));
  }).then(function (j) {
    if (!j) return;
    announce(j);
    // done: the thread tab goes back out of sight, the watch tab goes away
    return Promise.all([closeWatchTab(j), regroupTab(j.submitTabId)]);
  });
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  readJobs().then(function (jobs) {
    var touched = jobList(jobs).some(function (j) { return j.watchTabId === tabId || j.submitTabId === tabId; });
    if (!touched) return;
    var said = [];
    return withJobs(function (all) {
      jobList(all).forEach(function (j) {
        if (j.watchTabId === tabId) {
          j.watchTabId = null;   // a new one is opened on the next check
          if (j.state === 'generating') {
            // the build died with the page; start over rather than time out
            j.state = 'watching';
            j.nextCheckAt = Date.now();
            jobNote(j, 'the watching tab was closed mid-build');
          }
        }
        if (j.submitTabId === tabId) {
          j.submitTabId = null;
          if (j.state === 'submitting') {
            needsPerson(j, j.submitClickedAt
              ? 'the submit tab was closed after submit was clicked - check the subreddit before retrying'
              : 'the submit tab was closed before the thread was posted');
            said.push(JSON.parse(JSON.stringify(j)));
          }
        }
      });
    }).then(function () { said.forEach(announce); });
  });
});

// The submit page never asked for its thread: reddit.js did not run there.
// Say where the tab actually is, since that is nearly always the reason - a
// host the manifest does not cover, a login page, or reddit's new design.
function submitPageSilent(job) {
  return getTab(job.submitTabId).then(function (t) {
    var where = t ? String(t.url || t.pendingUrl || '').split('?')[0] : 'the tab is gone';
    return updateJob(job.id, function (j) {
      if (j.state !== 'submitting' || j.submitPageSeenAt) return;
      jobNote(j, 'the submit page never picked the thread up', { tabUrl: where });
      needsPerson(j, 'the submit page never picked the thread up (' + where + ') - ' +
        'copy the thread from Options and post it by hand, or Retry');
    });
  }).then(function (j) {
    if (j && j.state === 'attention') announce(j);
  });
}

/* -------------------------------------------------------------- the loop */

function tick() {
  return readJobs().then(function (jobs) {
    var now = Date.now();
    var work = [];
    var prune = [];
    jobList(jobs).forEach(function (j) {
      if (j.state === 'watching') {
        if ((j.nextCheckAt || 0) <= now && !checking[j.id]) work.push(checkJob(j));
      } else if (j.state === 'generating') {
        if (now - (j.buildStartedAt || 0) > BUILD_TIMEOUT_MS) {
          work.push(getTab(j.watchTabId).then(function (t) {
            return buildFailed(j.id, 'the match page never reported back' +
              (t && t.frozen === true ? ' - Chrome had frozen the tab' : ''));
          }));
        } else {
          work.push(thawIfFrozen(j, j.watchTabId));
        }
      } else if (j.state === 'submitting') {
        if (j.reopenSubmitAt) {
          // the submit page could not be opened last time; nothing to time out yet
          if (now >= j.reopenSubmitAt) work.push(reopenSubmitTab(j));
        } else if (!j.submitPageSeenAt && now - (j.submitOpenedAt || 0) > UNSEEN_SUBMIT_MS) {
          work.push(submitPageSilent(j));
        } else if (now - (j.submitOpenedAt || 0) > SUBMIT_TIMEOUT_MS) {
          work.push(updateJob(j.id, function (x) {
            if (x.state === 'submitting') needsPerson(x, 'reddit never confirmed the post - check the submit tab');
          }).then(function (x) { if (x && x.state === 'attention') announce(x); }));
        } else {
          work.push(thawIfFrozen(j, j.submitTabId));
        }
      } else if (FINISHED_STATES.indexOf(j.state) >= 0 && now - (j.updatedAt || 0) > KEEP_FINISHED_MS) {
        prune.push(j.id);
      }
    });
    if (prune.length) {
      work.push(withJobs(function (all) { prune.forEach(function (id) { delete all[id]; }); }));
    }
    return Promise.all(work);
  }).catch(function (e) {
    console.error('[PMT schedule] tick failed', e);
  });
}

chrome.alarms.onAlarm.addListener(function (a) {
  if (a && a.name === SCHEDULE_ALARM) tick();
});

/* ----------------------------------------------------------- the outside */

function notify(job, title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create('pmt|' + job.id + '|' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: title,
    message: message || '',
    priority: 1
  }, function () { void chrome.runtime.lastError; });
}

// A job's outcome, said once when it gets there.
function announce(job) {
  if (job.state === 'posted') notify(job, 'Post-match thread posted', job.title || job.label);
  else if (job.state === 'attention') notify(job, 'Scheduled thread needs you', job.label + ': ' + job.error);
  else if (job.state === 'failed') notify(job, 'Scheduled thread gave up', job.label + ': ' + job.error);
}

// Take the user to whatever the job is about: the thread once posted, the
// submit tab while it is waiting on them, the watch tab while watching, and
// the options page (which lists every job) when there is nothing else.
function focusJob(id) {
  return readJobs().then(function (jobs) {
    var j = jobs[id];
    if (j && j.state === 'posted' && j.threadUrl) {
      tabEdit(function (cb) { chrome.tabs.create({ url: j.threadUrl }, cb); }, function () {});
      return;
    }
    var tabId = !j ? null : j.state === 'watching' || j.state === 'generating' ? j.watchTabId : j.submitTabId;
    return getTab(tabId).then(function (t) {
      if (!t) return chrome.runtime.openOptionsPage();
      tabEdit(function (cb) { chrome.tabs.update(t.id, { active: true }, cb); }, function () {});
      chrome.windows.update(t.windowId, { focused: true });
    });
  });
}

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener(function (nid) {
    var parts = String(nid).split('|');
    if (parts[0] !== 'pmt') return;
    chrome.notifications.clear(nid);
    focusJob(parts[1]);
  });
}

function addJob(url, label) {
  var matchUrl = String(url || '').split('#')[0].split('?')[0];
  var matchId = matchIdOf(matchUrl);
  if (!matchId) return Promise.resolve({ ok: false, error: 'not an HLTV match page' });
  return withJobs(function (jobs) {
    var current = latestJobFor(jobs, matchId);
    // one job per match; only a failed or cancelled one can be scheduled again
    if (current && current.state !== 'failed' && current.state !== 'cancelled') {
      return { ok: true, job: current, existed: true };
    }
    var now = Date.now();
    var job = {
      id: matchId + '-' + now.toString(36),
      matchId: matchId,
      matchUrl: matchUrl,
      label: label || matchUrl,
      state: 'watching',
      createdAt: now,
      updatedAt: now,
      nextCheckAt: now,
      checks: 0,
      buildAttempts: 0,
      log: []
    };
    jobNote(job, 'scheduled', { url: matchUrl });
    jobs[job.id] = job;
    return { ok: true, job: JSON.parse(JSON.stringify(job)) };
  }).then(function (res) {
    if (res.ok && !res.existed) tick();
    return res;
  });
}

function cancelJob(id) {
  var job = null;
  return updateJob(id, function (j) {
    if (FINISHED_STATES.indexOf(j.state) >= 0) return;
    job = JSON.parse(JSON.stringify(j));
    j.state = 'cancelled';
    jobNote(j, 'cancelled');
  }).then(function (j) {
    if (job) closeWatchTab(job);
    return { ok: !!j, job: j };
  });
}

// Start again from the watching step. The options page asks first when submit
// had already been clicked, since clearing that is what allows a second post.
function retryJob(id) {
  return updateJob(id, function (j) {
    if (ACTIVE_STATES.indexOf(j.state) >= 0 || j.state === 'posted') return;
    j.state = 'watching';
    j.nextCheckAt = Date.now();
    j.error = undefined;
    j.stopReason = undefined;
    j.submitClickedAt = undefined;
    j.buildAttempts = 0;
    j.errors = 0;
    j.misses = 0;
    j.challenges = 0;
    j.staleChecks = 0;
    jobNote(j, 'retry');
  }).then(function (j) {
    tick();
    return { ok: !!j, job: j };
  });
}

function removeJob(id) {
  return withJobs(function (jobs) {
    var j = jobs[id];
    if (!j || ACTIVE_STATES.indexOf(j.state) >= 0) return { ok: false, error: 'cancel it first' };
    delete jobs[id];
    return { ok: true };
  });
}

var SCHEDULE_HANDLERS = {
  scheduleAdd: function (msg) { return addJob(msg.url, msg.label); },
  scheduleCancel: function (msg) { return cancelJob(msg.jobId); },
  scheduleRetry: function (msg) { return retryJob(msg.jobId); },
  scheduleRemove: function (msg) { return removeJob(msg.jobId); },
  scheduleFocus: function (msg) { return focusJob(msg.jobId); },
  scheduledThread: function (msg) { return threadBuilt(msg); },
  scheduledJobForSubmit: jobForSubmit,
  scheduledSubmitClicking: submitGoAhead,
  scheduledSubmitResult: function (msg) { return submitStopped(msg); },
  scheduledSubmitLog: function (msg) { return submitPageLog(msg); },
  scheduledLanded: submitLanded
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var handle = msg && SCHEDULE_HANDLERS[msg.type];
  if (!handle) return false;
  Promise.resolve()
    .then(function () { return handle(msg, sender); })
    .then(function (res) { sendResponse(res || { ok: true }); },
          function (e) { sendResponse({ ok: false, error: errorText(e) }); });
  return true;
});

// Every worker start: pick the group back up for background.js's synchronous
// checks, find out whether the alarm survived (a browser restart may clear
// it), then bring it and the badge in line with the stored jobs.
liveGroup();
chrome.alarms.get(SCHEDULE_ALARM, function (a) {
  if (alarmOn === null) alarmOn = !!a;
  withJobs(function () {}, true);
});
