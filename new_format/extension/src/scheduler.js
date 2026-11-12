/*
 * One persisted workflow per HLTV match and destination subreddit. The match owns
 * one watch tab; live and post-match threads have separate submit and edit records.
 * Loaded by background.js, whose navigation and tab helpers are used below.
 */

var JOBS_KEY = 'pmt:jobs';
var SCHEDULE_ALARM = 'pmt-schedule';
var SCHEDULE_DEFAULTS = { subreddit: 'GlobalOffensive', flair: 'Discussion | Esports',
                          checkMinutes: 1, autoSubmit: true };
var STATS_GRACE_MS = 60000;
var STATS_UPDATE_WINDOW_MS = 60 * 60000;
var UPDATE_CHECK_MS = 60000;
var EDIT_TIMEOUT_MS = 3 * 60000;
var MAX_EDIT_ATTEMPTS = 3;
var LIVE_MAX_MONITOR_MS = 18 * 3600000;
var LIVE_POST_LEAD_MS = 5 * 60000;
var BUILD_TIMEOUT_MS = 5 * 60000;
var SUBMIT_TIMEOUT_MS = 10 * 60000;
var UNSEEN_SUBMIT_MS = 2 * 60000;
var GIVE_UP_MS = 12 * 3600000;
var FAR_OFF_MS = 15 * 60000;
var MAX_BUILD_ATTEMPTS = 3;
var MAX_SUBMIT_OPENS = 3;
var KEEP_FINISHED_MS = 7 * 24 * 3600000;
var HEARTBEAT_MS = 30 * 60000;
var JOB_LOG_LIMIT = 100;
var checking = {};
var alarmOn = null;
var jobsLock = Promise.resolve();
var requestSequence = 0;

function errorText(e) { return String((e && e.message) || e); }
function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function requestId() { return Date.now().toString(36) + '-' + (++requestSequence).toString(36); }
function scheduleSettings() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(SCHEDULE_DEFAULTS, function (v) { resolve(v || SCHEDULE_DEFAULTS); });
  });
}
function checkInterval(settings) {
  var m = parseFloat(settings.checkMinutes);
  return Math.min(30, Math.max(0.5, m > 0 ? m : 1)) * 60000;
}
function readJobs() {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.get([JOBS_KEY], function (v) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve((v && v[JOBS_KEY]) || {});
    });
  });
}
function jobList(jobs) { return Object.keys(jobs).map(function (id) { return jobs[id]; }); }
function threads(job) {
  return ['live', 'post'].map(function (kind) { return job.threads[kind]; }).filter(Boolean);
}
function editing(t) { return !!(t.update && t.update.status === 'editing'); }
function finalNeeded(job) {
  var live = job.threads.live, post = job.threads.post;
  return !job.cancelled && !job.liveUpdatesStopped && live && live.state === 'posted' &&
    post && post.state === 'posted' && !!validRedditThread(job, post) &&
    live.finalState !== 'done' && live.finalState !== 'stopped';
}
function needsSource(job) {
  if (job.cancelled) return false;
  return !!job.build || !!finalNeeded(job) || threads(job).some(function (t) {
    return t.state === 'watching' || (t.state === 'posted' && t.update &&
      t.update.status === 'waiting' &&
      (t.kind === 'post' || (!job.overSince && !job.liveUpdatesStopped)));
  });
}
function hasWork(job) {
  return !job.cancelled && (needsSource(job) || threads(job).some(function (t) {
    return t.state === 'generating' || t.state === 'submitting' || editing(t);
  }));
}
function refreshJobState(job) {
  if (!job.threads) return;
  var all = threads(job);
  job.active = hasWork(job);
  var trouble = all.find(function (t) {
    return t.state === 'attention' || t.state === 'failed' || t.finalState === 'stopped';
  });
  job.error = trouble && (trouble.error || (trouble.update && trouble.update.error));
  if (job.cancelled) job.state = 'cancelled';
  else if (trouble) job.state = 'attention';
  else if (job.build) job.state = 'generating';
  else if (all.some(function (t) { return t.state === 'submitting'; })) job.state = 'submitting';
  else job.state = hasWork(job) ? 'watching' : 'posted';
}
// Every read/modify/write and submit permission is serialized. Returning a copy
// also prevents a caller from changing persisted state outside this lock.
function withJobs(change, readOnly) {
  var run = jobsLock.then(function () {
    return readJobs().then(function (jobs) {
      var out = change(jobs);
      jobList(jobs).forEach(refreshJobState);
      var saved = readOnly ? Promise.resolve() : new Promise(function (resolve, reject) {
        var patch = {}; patch[JOBS_KEY] = jobs;
        chrome.storage.local.set(patch, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      return saved.then(function () { syncAlarmAndBadge(jobs); return copy(out); });
    });
  });
  jobsLock = run.catch(function () {});
  return run;
}
function updateJob(id, change) {
  return withJobs(function (jobs) {
    if (!jobs[id]) return null;
    change(jobs[id]);
    return jobs[id];
  });
}
function getJob(id) { return readJobs().then(function (jobs) { return jobs[id] || null; }); }
function findThread(jobs, id, tabId, field) {
  var found = null;
  jobList(jobs).some(function (job) {
    return threads(job).some(function (t) {
      if (id ? t.id === id : tabId != null &&
          (field === 'edit' ? t.update && t.update.tabId === tabId : t.submitTabId === tabId)) {
        found = { job: job, thread: t }; return true;
      }
      return false;
    });
  });
  return found;
}
function updateThread(id, change) {
  return withJobs(function (jobs) {
    var found = findThread(jobs, id);
    if (!found) return null;
    change(found.thread, found.job);
    return found;
  });
}
function jobNote(job, msg, data) {
  var entry = { at: Date.now(), msg: msg };
  if (data !== undefined) entry.data = data;
  job.log = (job.log || []).concat([entry]).slice(-JOB_LOG_LIMIT);
  job.updatedAt = entry.at;
  console.info('[PMT schedule ' + job.id + '] ' + msg, data === undefined ? '' : data);
}
function threadNote(job, t, msg, data) {
  jobNote(job, (t.kind === 'live' ? 'LMT: ' : 'PMT: ') + msg, data);
}
function needsPerson(job, t, reason) {
  t.state = 'attention'; t.error = reason;
  threadNote(job, t, 'needs a person: ' + reason);
  notify(job, 'Scheduled thread needs you', reason);
}
function failThread(job, t, reason) {
  t.state = 'failed'; t.error = reason;
  threadNote(job, t, 'gave up: ' + reason);
  notify(job, 'Scheduled thread gave up', reason);
}
function matchIdOf(url) {
  return (/^https:\/\/www\.hltv\.org\/matches\/(\d+)(?:[/?#]|$)/.exec(url || '') || [])[1] || '';
}
function workflowId(matchId, subreddit) { return 'match-' + matchId + '-' + subreddit.toLowerCase(); }
function newThread(job, kind) {
  return { id: job.id + ':' + kind, kind: kind, state: 'watching', buildAttempts: 0 };
}
function newJob(matchId, matchUrl, label, settings) {
  var subreddit = String(settings.subreddit || SCHEDULE_DEFAULTS.subreddit).trim();
  var now = Date.now();
  var job = { schemaVersion: 2, id: workflowId(matchId, subreddit), matchId: matchId,
    matchUrl: matchUrl, label: label || matchUrl, subreddit: subreddit,
    flair: typeof settings.flair === 'string' ? settings.flair.trim() : '',
    mode: 'post', state: 'watching', createdAt: now, updatedAt: now,
    nextCheckAt: now, checks: 0, threads: {}, log: [] };
  job.threads.post = newThread(job, 'post');
  return job;
}
function syncAlarmAndBadge(jobs) {
  var list = jobList(jobs).filter(function (j) { return j.schemaVersion === 2; });
  var active = list.filter(hasWork).length;
  var stuck = list.filter(function (j) { return j.state === 'attention'; }).length;
  if (active && alarmOn !== true) {
    chrome.alarms.create(SCHEDULE_ALARM, { periodInMinutes: 0.5 }); alarmOn = true;
  } else if (!active && alarmOn !== false) {
    chrome.alarms.clear(SCHEDULE_ALARM); alarmOn = false;
  }
  chrome.action.setBadgeBackgroundColor({ color: stuck ? '#c0392b' : '#2d6ca2' });
  chrome.action.setBadgeText({ text: stuck ? '!' : active ? String(active) : '' });
  chrome.action.setTitle({ title: 'HLTV Post-Match Thread' +
    (active ? ' - ' + active + ' scheduled matches' : '') +
    (stuck ? ' - ' + stuck + ' waiting on you' : '') });
}

// Upgrade old independent jobs without resetting either post's submit permission.
// In-flight thread IDs remain valid, including URLs already open in Reddit.
function migrateJobs(jobs, settings) {
  var redundant = [], groups = {};
  function deliveryPriority(t) {
    if (t.threadUrl) return 3;
    if (t.submitClickedAt) return 2;
    return t.state === 'submitting' || t.state === 'generating' ? 1 : 0;
  }
  jobList(jobs).forEach(function (old) {
    if (old.schemaVersion === 2) return;
    var sub = old.subreddit || settings.subreddit || SCHEDULE_DEFAULTS.subreddit;
    var id = workflowId(old.matchId, sub);
    (groups[id] || (groups[id] = [])).push(old);
    delete jobs[old.id];
  });
  Object.keys(groups).forEach(function (id) {
    var oldJobs = groups[id].sort(function (a, b) { return a.createdAt - b.createdAt; });
    var first = oldJobs[0];
    var job = jobs[id] || newJob(first.matchId, first.matchUrl, first.label,
      { subreddit: first.subreddit || settings.subreddit, flair: first.flair == null ? settings.flair : first.flair });
    if (!jobs[id]) job.threads = {};
    oldJobs.forEach(function (old) {
      var kind = old.kind === 'live' ? 'live' : 'post';
      var t = copy(old);
      ['matchId', 'matchUrl', 'label', 'watchTabId', 'replaceWatchTab', 'lastSeen',
       'log', 'subreddit', 'flair'].forEach(function (key) { delete t[key]; });
      t.kind = kind;
      if (old.map3EditStatus) {
        t.update = { status: old.map3EditStatus === 'armed' ? 'done' : old.map3EditStatus,
          purpose: kind === 'live' ? 'maps' : 'stats', deadline: old.map3EditDeadline,
          nextAt: old.map3EditNextAt, startedAt: old.map3EditStartedAt,
          attempts: old.map3EditAttempts || 0, buildErrors: old.map3BuildErrors || 0,
          tabId: old.map3EditTabId, body: old.map3UpdatedBody,
          signature: old.livePendingSignature || '', legacy: true };
        if (kind === 'post' && old.map3EditStatus === 'armed') t.needsStats = true;
      }
      Object.keys(t).forEach(function (key) { if (/^map3/.test(key)) delete t[key]; });
      t.publishedSignature = old.livePublishedSignature || old.liveInitialSignature || '';
      if (old.watchTabId != null) redundant.push({ tabId: old.watchTabId, matchId: old.matchId });
      if (!job.lastCheckAt || old.lastCheckAt >= job.lastCheckAt) {
        job.lastSeen = old.lastSeen; job.lastCheckAt = old.lastCheckAt;
        job.matchUrl = old.matchUrl; job.label = old.label || job.label;
      }
      job.createdAt = Math.min(job.createdAt, old.createdAt || job.createdAt);
      job.log = job.log.concat((old.log || []).map(function (e) {
        return Object.assign({}, e, { msg: (kind === 'live' ? 'LMT: ' : 'PMT: ') + e.msg });
      }));
      if (old.overSince || old.liveOverSince) job.overSince = old.overSince || old.liveOverSince;
      // A newer unused retry must not discard a published post or its spent
      // submit permission. Keep the original ID addressable for late replies.
      var previous = job.threads[kind];
      if (previous && deliveryPriority(previous) > deliveryPriority(t)) {
        (job.legacyHistory || (job.legacyHistory = [])).push(t);
        return;
      }
      if (previous) {
        (job.legacyHistory || (job.legacyHistory = [])).push(previous);
        if (job.build && job.build.threadId === previous.id) job.build = null;
      }
      job.threads[kind] = t;
      // Prefer the PMT build if both old watch tabs happened to be generating.
      var building = old.state === 'generating' || (t.update && t.update.status === 'building');
      if (building && (!job.build || kind === 'post')) {
        if (job.build) {
          var displaced = job.threads[job.build.kind];
          if (job.build.purpose === 'initial') displaced.state = 'watching';
          else displaced.update.status = 'waiting';
        }
        job.watchTabId = old.watchTabId;
        job.build = { kind: kind, threadId: t.id, purpose: old.state === 'generating' ? 'initial' :
          kind === 'live' ? 'maps' : 'stats', startedAt: old.buildStartedAt || old.map3EditStartedAt || Date.now(),
          legacy: true, signature: old.livePendingSignature || '' };
      } else if (building) {
        if (t.state === 'generating') t.state = 'watching';
        else t.update.status = 'waiting';
      }
      if (!job.build && (job.watchTabId == null || kind === 'live')) job.watchTabId = old.watchTabId;
    });
    var live = job.threads.live;
    if (live) {
      job.mode = 'live';
      var liveActive = ['watching', 'generating', 'submitting', 'attention'].indexOf(live.state) >= 0 ||
        (live.state === 'posted' && live.update && ['waiting', 'building', 'editing'].indexOf(live.update.status) >= 0);
      if (!job.threads.post) {
        job.threads.post = newThread(job, 'post');
        // Archived LMTs must not suddenly publish old PMTs on upgrade.
        if (!liveActive) {
          job.threads.post.state = 'skipped'; live.finalState = 'done';
        }
      }
      if (live.state === 'posted') job.monitorDeadline = live.update && live.update.deadline || Date.now() + LIVE_MAX_MONITOR_MS;
    }
    job.cancelled = threads(job).every(function (t) { return t.state === 'cancelled'; });
    job.log.sort(function (a, b) { return a.at - b.at; });
    job.log = job.log.slice(-JOB_LOG_LIMIT);
    jobNote(job, 'combined existing schedules into one match workflow');
    refreshJobState(job);
    jobs[id] = job;
  });
  return redundant.filter(function (entry) {
    return !jobList(jobs).some(function (job) { return job.watchTabId === entry.tabId; });
  });
}

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


function readMatchState() {
  function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  var box = document.querySelector('.teamsBox');
  var cd = document.querySelector('.timeAndEvent .countdown');
  var time = document.querySelector('.timeAndEvent .time[data-unix]');
  var countdown = txt(cd);
  var matchOver = /match over/i.test(countdown);
  var scoreOf = function (n) {
    var g = '.team' + n + '-gradient ';
    return txt(box && box.querySelector(g + '.won, ' + g + '.lost, ' + g + '.tie'));
  };
  var decided = !!(box && box.querySelector(
    '.team1-gradient .won, .team2-gradient .won, .team1-gradient .tie, .team2-gradient .tie'));

  var missing = [];
  var finished = [];
  
Array.prototype.forEach.call(document.querySelectorAll('.mapholder'), function (h) {
  var over = h.querySelector('.results-left.won, .results-left.lost, .results-right.won, .results-right.lost');
  var a = h.querySelector('.results-center-stats a');
  var id = ((a && a.getAttribute('href')) || '').match(/\/mapstatsid\/(\d+)\//);

  // won/lost also marks a halftime leader. Use the same final-score rule as
  // scrapeMaps in hltv.js so a partial score cannot trigger a Reddit update
  // or become a supposedly finished map with missing statistics.
  var left = parseInt(txt(h.querySelector('.results-left .results-team-score')), 10);
  var right = parseInt(txt(h.querySelector('.results-right .results-team-score')), 10);
  var high = Math.max(left, right);
  var low = Math.min(left, right);
  var finalScore = (high === 13 && low <= 11) ||
    (high >= 16 && (high - 16) % 3 === 0 && low >= high - 4 && low <= high - 2);
  if (!over || !(low >= 0 && (matchOver || finalScore))) return;

  var mapName = txt(h.querySelector('.mapname'));
   var statsTab = id && document.getElementById(id[1] + '-content');
   var statsReady = !!(statsTab && statsTab.querySelector('table.totalstats'));
   finished.push([finished.length, mapName,
     txt(h.querySelector('.results-left')), txt(h.querySelector('.results-right')),
     id ? id[1] : '', statsReady ? 'ready' : 'pending'].join(':'));

  // Map is finished, but the stats link is missing
  if (!id) {
    missing.push(mapName + ' (stats link missing)');
    return;
  }

  // Stats link exists, but the stats table is missing
  var tab = document.getElementById(id[1] + '-content');
  if (!tab || !tab.querySelector('table.totalstats')) {
    missing.push(mapName + ' (stats table missing)');
  }
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
    over: matchOver || decided,
    deleted: /deleted|cancel/i.test(countdown),
    teams: box ? Array.prototype.map.call(box.querySelectorAll('.teamName'), txt).slice(0, 2) : [],
    score: [scoreOf(1), scoreOf(2)],
    event: txt(document.querySelector('.timeAndEvent .event a')),
    statsReady: allTables >= 2 && !missing.length,
    statsTables: allTables,
    mapsMissingStats: missing,
    finishedMaps: finished.length,
    finishedMapSignature: finished.join('|')
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


/* -------------------------------------------------------- shared watcher */

function releaseWatchTab(id) {
  var previous;
  return updateJob(id, function (job) {
    if (needsSource(job)) return;
    previous = { watchTabId: job.watchTabId, matchId: job.matchId };
    job.watchTabId = null;
  }).then(function () { if (previous) return closeWatchTab(previous); });
}
function stopUpdate(job, t, reason, permanent) {
  if (!t.update) return;
  t.update.status = 'stopped'; t.update.nextAt = null; t.update.error = reason;
  t.update.permanent = !!permanent;
  if (t.update.purpose === 'final' || (t.kind === 'live' && permanent)) t.finalState = 'stopped';
  threadNote(job, t, 'update stopped: ' + reason);
}
function expireWork(job) {
  var now = Date.now();
  threads(job).forEach(function (t) {
    if (t.update && ['waiting', 'building', 'editing'].indexOf(t.update.status) >= 0 &&
        t.update.deadline && now >= t.update.deadline) {
      stopUpdate(job, t, 'statistics/edit monitoring window expired');
      if (job.build && job.build.threadId === t.id && job.build.purpose !== 'initial') {
        job.build = null; job.replaceWatchTab = true;
      }
    }
  });
  var start = job.lastSeen && job.lastSeen.unix || 0;
  var deadline = job.monitorDeadline || Math.max(job.createdAt, start) + GIVE_UP_MS;
  if (!job.overSince && now >= deadline) {
    threads(job).forEach(function (t) {
      if (t.state === 'watching') failThread(job, t, 'match did not finish within the monitoring time limit');
      if (t.kind === 'live' && t.update && t.update.status === 'waiting') {
        stopUpdate(job, t, 'live monitoring time limit reached');
      }
    });
  }
}
function sourceFailed(id, reason, stale) {
  return updateJob(id, function (job) {
    if (job.cancelled) return;
    job.errors = (job.errors || 0) + 1;
    job.nextCheckAt = Date.now() + UPDATE_CHECK_MS;
    if (job.errors >= 2) job.replaceWatchTab = true;
    jobNote(job, stale ? 'the watch tab did not load the match' : 'match check failed',
      { error: reason, inARow: job.errors });
    if (job.errors >= 10) {
      threads(job).forEach(function (t) {
        if (t.state === 'watching') failThread(job, t, 'HLTV could not be read ten times running');
        if (t.update && t.update.status === 'waiting') stopUpdate(job, t, 'HLTV could not be read ten times running');
      });
    }
  });
}
function checkMatch(job, settings) {
  var startedAt = Date.now();
  return watchTab(job).then(function (w) {
    return readMatchStateSettled(w.tabId, w.token, job.matchId, startedAt).then(function (s) {
      if (s.stale || !s.isMatchPage) return sourceFailed(job.id, s.title || s.url, s.stale);
      var intent = null, abandonSubmit = null;
      return updateJob(job.id, function (j) {
        if (j.cancelled || j.build) return;
        var now = Date.now(), interval = checkInterval(settings);
        if (threads(j).some(function (t) { return t.state === 'posted' && t.update; })) {
          interval = Math.min(interval, UPDATE_CHECK_MS);
        }
        var before = j.lastSeen && j.lastSeen.phase;
        j.watchTabId = w.tabId; j.lastCheckAt = now;
        j.checks = (j.checks || 0) + 1; j.errors = 0;
        j.lastSeen = Object.assign({}, s, { phase: phaseOf(s),
          unix: s.unix || (j.lastSeen && j.lastSeen.unix) || 0 });
        var currentUrl = String(s.url || '').split(/[?#]/)[0];
        if (matchIdOf(currentUrl) === j.matchId) j.matchUrl = currentUrl;
        if (s.teams.length === 2 && s.teams[0] && s.teams[1]) {
          j.label = s.teams.join(' vs ') + (s.event ? ' / ' + s.event : '');
        }
        var lastNote = j.log.length ? j.log[j.log.length - 1].at : 0;
        if (before !== j.lastSeen.phase || now - lastNote >= HEARTBEAT_MS) {
          jobNote(j, j.lastSeen.phase, { countdown: s.countdown, score: s.score.join(':') });
        }
        j.nextCheckAt = now + interval;
        var live = j.threads.live, post = j.threads.post;
        if (s.deleted) {
          threads(j).forEach(function (t) {
            if (t.state === 'watching') failThread(j, t, 'HLTV says "' + s.countdown + '"');
            if (t.update && t.update.status === 'waiting') stopUpdate(j, t, 'match was deleted or cancelled', true);
          });
          return;
        }
        if (s.over) {
          if (!j.overSince) { j.overSince = now; jobNote(j, 'match finished; preparing the post-match thread'); }
          if (live && (live.state === 'watching' || (live.state === 'attention' && !live.submitClickedAt))) {
            live.state = 'skipped';
            abandonSubmit = live.submitTabId; live.submitTabId = null;
            threadNote(j, live, 'match already over; skipping the unposted live discussion');
          }
          if (live && live.update && live.update.purpose === 'maps' && live.update.status === 'waiting') {
            live.update.status = 'done';
          }
          // Publishing the PMT never depends on a successful LMT edit.
          if (post && post.state === 'watching' && now >= (post.nextAttemptAt || 0)) {
            if (!s.statsReady && now - j.overSince < STATS_GRACE_MS) {
              j.nextCheckAt = now + Math.min(interval, STATS_GRACE_MS);
              threadNote(j, post, 'waiting briefly for statistics', { missing: s.mapsMissingStats });
            } else {
              post.needsStats = !s.statsReady;
              intent = { kind: 'post', purpose: 'initial' };
            }
          }
          if (!intent && post && post.state === 'posted' && post.update &&
              post.update.status === 'waiting' && now >= (post.update.nextAt || 0) && s.statsReady) {
            intent = { kind: 'post', purpose: 'stats' };
          }
          return;
        }
        if (live && live.state === 'watching' && now >= (live.nextAttemptAt || 0) &&
            (s.live || (j.lastSeen.unix > 0 && now >= j.lastSeen.unix - LIVE_POST_LEAD_MS))) {
          intent = { kind: 'live', purpose: 'initial' };
        } else if (live && live.state === 'posted' && !j.liveUpdatesStopped && live.update &&
            live.update.status === 'waiting' && now >= (live.update.nextAt || 0) &&
            (s.finishedMapSignature || '') !== (live.publishedSignature || '')) {
          intent = { kind: 'live', purpose: 'maps' };
        }
        var start = j.lastSeen.unix;
        if (!s.live && start - now > FAR_OFF_MS) {
          j.nextCheckAt = now + Math.min(30 * 60000, start - now - LIVE_POST_LEAD_MS);
        } else if (live && live.state === 'watching' && start - LIVE_POST_LEAD_MS > now) {
          j.nextCheckAt = Math.min(j.nextCheckAt, start - LIVE_POST_LEAD_MS);
        }
      }).then(function (j) {
        var close = abandonSubmit == null ? Promise.resolve() : getTab(abandonSubmit).then(function (t) {
          if (t && /\/submit(?:[?#]|$)/.test(t.url || '')) {
            return tabEditP(function (cb) { chrome.tabs.remove(t.id, cb); });
          }
        });
        return close.then(function () {
          if (intent) return startBuild(job.id, intent.kind, intent.purpose, true);
          return j && regroupTab(j.watchTabId);
        });
      });
    });
  }).catch(function (e) { return sourceFailed(job.id, errorText(e)); });
}

/* ------------------------------------------------------------- generation */

function startBuild(id, kind, purpose, pageReady) {
  var build = null;
  return updateJob(id, function (job) {
    var t = job.threads[kind];
    if (job.cancelled || job.build || !t) return;
    if (purpose === 'initial' ? t.state !== 'watching' : t.state !== 'posted' || editing(t)) return;
    if (kind === 'live' && purpose !== 'initial' && job.liveUpdatesStopped) return;
    if (purpose === 'final' && !finalNeeded(job)) return;
    build = { kind: kind, purpose: purpose, threadId: t.id, requestId: requestId(),
      startedAt: Date.now(), signature: job.lastSeen && job.lastSeen.finishedMapSignature || '' };
    job.build = build;
    if (purpose === 'initial') {
      t.state = 'generating'; t.buildAttempts = (t.buildAttempts || 0) + 1;
    } else {
      var previous = t.update || {};
      t.update = { purpose: purpose, status: 'building', buildErrors: previous.purpose === purpose ? previous.buildErrors || 0 : 0,
        deadline: purpose === 'final' ? Date.now() + STATS_UPDATE_WINDOW_MS : previous.deadline };
      if (purpose === 'final') t.finalState = 'pending';
    }
    threadNote(job, t, 'generating ' + purpose + ' content');
  }).then(function (job) {
    if (!build || !job) return;
    var page = pageReady ? Promise.resolve({ tabId: job.watchTabId }) : watchTab(job).then(function (w) {
      return readMatchStateSettled(w.tabId, w.token, job.matchId, build.startedAt).then(function (s) {
        if (s.stale || !s.isMatchPage) throw new Error('HLTV did not load a settled match page');
        return w;
      });
    });
    return page.then(function (w) {
      return getJob(id).then(function (current) {
        if (!current || current.cancelled || !current.build || current.build.requestId !== build.requestId) return;
        return ungroupTab(w.tabId).then(function () {
          return sendToTab(w.tabId, { type: purpose === 'initial' ? 'scheduledGenerate' : 'scheduledRegenerate',
            jobId: build.threadId, requestId: build.requestId, kind: kind,
            matchOver: purpose === 'final', postMatchUrl: purpose === 'final' ? current.threads.post.threadUrl : '' }, 15);
        }).then(function (r) {
          if (!r || !r.accepted) throw new Error((r && r.error) || 'the match tab did not accept the build');
        });
      });
    }).catch(function (e) { return buildFailed(id, build.requestId, errorText(e)); });
  });
}
function buildFailed(id, token, error) {
  return updateJob(id, function (job) {
    var build = job.build;
    if (!build || build.requestId !== token) return;
    var t = job.threads[build.kind];
    job.build = null; job.replaceWatchTab = true; job.nextCheckAt = Date.now() + UPDATE_CHECK_MS;
    if (build.purpose === 'initial') {
      if (t.buildAttempts >= MAX_BUILD_ATTEMPTS) failThread(job, t, error);
      else { t.state = 'watching'; t.nextAttemptAt = job.nextCheckAt; threadNote(job, t, 'build failed; retrying', { error: error }); }
    } else {
      t.update.buildErrors = (t.update.buildErrors || 0) + 1;
      if (t.update.buildErrors >= MAX_BUILD_ATTEMPTS) stopUpdate(job, t, 'generation failed: ' + error);
      else {
        t.update.status = 'waiting'; t.update.nextAt = job.nextCheckAt;
        threadNote(job, t, 'update generation failed; retrying', { error: error });
      }
    }
  }).then(function (job) { if (job) return regroupTab(job.watchTabId); });
}
function threadBuilt(msg, sender) {
  var result = null;
  return withJobs(function (jobs) {
    var found = findThread(jobs, msg.jobId);
    if (!found) return;
    var job = found.job, t = found.thread, build = job.build;
    if (job.cancelled || !build || build.threadId !== t.id ||
        (build.legacy ? !!msg.requestId : build.requestId !== msg.requestId) ||
        !sender.tab || sender.tab.id !== job.watchTabId) return;
    result = { jobId: job.id, token: build.requestId, purpose: build.purpose, threadId: t.id };
    if (!msg.ok || !msg.body || (build.purpose === 'initial' && !msg.title)) {
      result.error = msg.error || 'the build produced no thread'; return;
    }
    if (build.purpose !== 'initial' && msg.gamblingLeft && msg.gamblingLeft.length) {
      job.build = null; stopUpdate(job, t, 'generated body contains a blocked term', true); return;
    }
    job.build = null;
    if (build.purpose === 'initial') {
      t.title = msg.title; t.body = msg.body; t.notes = msg.notes || [];
      t.gamblingLeft = msg.gamblingLeft || []; t.initialSignature = build.signature;
      t.state = 'submitting'; t.submitOpenedAt = Date.now(); t.submitPageSeenAt = null;
      t.submitOpenFailures = 0; t.reopenSubmitAt = null;
      threadNote(job, t, 'thread built; opening Reddit', { title: t.title }); result.submit = true;
    } else if (msg.body === t.body) {
      t.publishedSignature = build.signature;
      t.update.status = build.purpose === 'maps' ? 'waiting' : 'done';
      t.update.nextAt = Date.now() + UPDATE_CHECK_MS;
      if (build.purpose === 'final') t.finalState = 'done';
      threadNote(job, t, 'generated body is already current');
    } else {
      t.update.status = 'editing'; t.update.body = msg.body; t.update.attempts = 0;
      t.update.signature = build.signature; t.update.nextAt = Date.now();
      threadNote(job, t, 'content ready; preparing Reddit edit'); result.edit = true;
    }
  }).then(function () {
    if (!result) return;
    if (result.error) return buildFailed(result.jobId, result.token, result.error);
    if (result.submit) return openSubmitTab(result.threadId);
    if (result.edit) return startEdit(result.threadId);
  }).then(function () { return tick(); });
}

/* ------------------------------------------------------------- submitting */

function submitUrlFor(job, t) {
  return 'https://old.reddit.com/r/' + encodeURIComponent(job.subreddit) +
    '/submit?selftext=true&title=' + encodeURIComponent(t.title) +
    '#pmt-flair=' + encodeURIComponent(job.flair) + '&pmt-job=' + encodeURIComponent(t.id);
}
function openSubmitTab(threadId) {
  var token = requestId(), claimed = false;
  return updateThread(threadId, function (t, job) {
    if (job.cancelled || t.state !== 'submitting' || t.submitClickedAt || t.submitOpening) return;
    t.submitOpening = token; claimed = true;
  }).then(function (found) {
    if (!claimed || !found) return;
    return openScheduledTab(submitUrlFor(found.job, found.thread), { grouped: false,
      created: function (tabId) {
        var accepted = false;
        return updateThread(threadId, function (t, job) {
          if (job.cancelled || t.state !== 'submitting' || t.submitOpening !== token) return;
          t.submitTabId = tabId; t.submitOpening = null; accepted = true;
        }).then(function () {
          if (!accepted) return tabEditP(function (cb) { chrome.tabs.remove(tabId, cb); });
        });
      }
    }).then(function () { return regroupTab(found.job.watchTabId); }).catch(function (e) {
      return updateThread(threadId, function (t, job) {
        if (t.state !== 'submitting' || t.submitOpening !== token) return;
        t.submitOpening = null;
        t.submitOpenFailures = (t.submitOpenFailures || 0) + 1;
        if (t.submitOpenFailures >= MAX_SUBMIT_OPENS) needsPerson(job, t, 'could not open Reddit: ' + errorText(e));
        else {
          t.submitTabId = null; t.reopenSubmitAt = Date.now() + UPDATE_CHECK_MS;
          threadNote(job, t, 'could not open Reddit; will retry', { error: errorText(e) });
        }
      });
    });
  });
}
function jobForSubmit(msg, sender) {
  var tabId = sender.tab && sender.tab.id;
  return scheduleSettings().then(function (settings) {
    return withJobs(function (jobs) {
      var found = findThread(jobs, msg.jobId, tabId);
      if (!found) return { ok: false, none: true };
      var job = found.job, t = found.thread;
      if (job.cancelled || t.state !== 'submitting' || tabId == null || t.submitTabId !== tabId) {
        return { ok: false, error: 'this tab no longer owns the scheduled submission' };
      }
      t.submitPageSeenAt = t.submitPageSeenAt || Date.now();
      threadNote(job, t, 'Reddit submit page asked for the thread');
      var held = t.gamblingLeft && t.gamblingLeft.length ?
        'it still names a gambling brand (' + t.gamblingLeft.join(', ') + ') - edit it out before submitting' : '';
      return { ok: true, id: t.id, title: t.title, body: t.body, flair: job.flair, subreddit: job.subreddit,
        autoSubmit: settings.autoSubmit !== false && !held, holdReason: held, clicked: !!t.submitClickedAt };
    });
  });
}
function submitGoAhead(msg, sender) {
  var go = false;
  return updateThread(msg.jobId, function (t, job) {
    if (job.cancelled || t.state !== 'submitting' || t.submitClickedAt ||
        !sender.tab || sender.tab.id !== t.submitTabId) return;
    t.submitClickedAt = Date.now(); threadNote(job, t, 'clicking submit'); go = true;
  }).then(function () { return { go: go }; });
}
function submitStopped(msg, sender) {
  return updateThread(msg.jobId, function (t, job) {
    if (job.cancelled || t.state !== 'submitting' || !sender.tab || sender.tab.id !== t.submitTabId) return;
    t.stopReason = msg.reason; needsPerson(job, t, msg.error || 'Reddit submission stopped');
  });
}
function validRedditThread(job, t) {
  try {
    var url = new URL(t.threadUrl);
    if (url.protocol !== 'https:' || !/^(old|www)\.reddit\.com$/.test(url.hostname)) return null;
    var m = /^\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/|$)/i.exec(url.pathname);
    if (!m || decodeURIComponent(m[1]).toLowerCase() !== job.subreddit.toLowerCase()) return null;
    return { path: url.pathname, fullname: 't3_' + m[2].toLowerCase(), subreddit: decodeURIComponent(m[1]) };
  } catch (e) { return null; }
}
function submitLanded(msg, sender) {
  if (!sender.tab) return Promise.resolve();
  return withJobs(function (jobs) {
    var found = findThread(jobs, null, sender.tab.id);
    if (!found) return;
    var job = found.job, t = found.thread;
    if (['submitting', 'attention', 'cancelled'].indexOf(t.state) < 0 ||
        !validRedditThread(job, { threadUrl: msg.url })) return;
    t.state = 'posted'; t.threadUrl = msg.url; t.error = null; t.postedAt = Date.now();
    threadNote(job, t, 'posted', { url: msg.url });
    if (!job.cancelled && t.kind === 'live' && !job.liveUpdatesStopped) {
      t.publishedSignature = t.initialSignature || '';
      job.monitorDeadline = Date.now() + LIVE_MAX_MONITOR_MS;
      t.update = { purpose: 'maps', status: job.overSince ? 'done' : 'waiting',
        nextAt: Date.now() + UPDATE_CHECK_MS, deadline: job.monitorDeadline };
      job.nextCheckAt = Math.min(job.nextCheckAt || Infinity, Date.now() + UPDATE_CHECK_MS);
    } else if (!job.cancelled && t.kind === 'post' && t.needsStats) {
      t.update = { purpose: 'stats', status: 'waiting', nextAt: Date.now() + UPDATE_CHECK_MS,
        deadline: Date.now() + STATS_UPDATE_WINDOW_MS };
      job.nextCheckAt = Date.now() + UPDATE_CHECK_MS;
    }
    notify(job, t.kind === 'live' ? 'Live discussion posted' : 'Post-match thread posted', t.title || job.label);
    return found;
  }).then(function (found) {
    if (!found) return;
    return regroupTab(found.thread.submitTabId).then(function () { return releaseWatchTab(found.job.id); });
  }).then(function () { return tick(); });
}

/* ----------------------------------------------------------- Reddit edits */

function startEdit(threadId) {
  var claimed = false, previous = null;
  return updateThread(threadId, function (t, job) {
    var u = t.update;
    if (job.cancelled || !editing(t) || !u.nextAt || u.nextAt > Date.now() ||
        (t.kind === 'live' && job.liveUpdatesStopped)) return;
    if (!validRedditThread(job, t)) { stopUpdate(job, t, 'invalid Reddit thread address', true); return; }
    if ((u.attempts || 0) >= MAX_EDIT_ATTEMPTS) { stopUpdate(job, t, 'edit retry limit reached'); return; }
    previous = { tabId: u.tabId, owned: u.owned };
    u.attempts = (u.attempts || 0) + 1; u.nextAt = null; u.startedAt = Date.now();
    u.editToken = requestId(); u.legacy = false; u.tabId = null; u.owned = false;
    claimed = true;
    threadNote(job, t, 'opening Reddit to edit', { purpose: u.purpose, attempt: u.attempts });
  }).then(function (found) {
    if (!claimed || !found) return;
    var job = found.job, t = found.thread, target = validRedditThread(job, t), token = t.update.editToken;
    var editUrl = 'https://old.reddit.com' + target.path + '?pmt-edit-check=' + Date.now() +
      '#pmt-edit=' + encodeURIComponent(t.id);
    function remember(tabId, owned) {
      return updateThread(t.id, function (current) {
        if (!current.update || current.update.editToken !== token) return;
        current.update.tabId = tabId; current.update.owned = owned;
      });
    }
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ url: ['https://old.reddit.com/*', 'https://www.reddit.com/*'] }, function (tabs) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        var matches = (tabs || []).filter(function (tab) {
          var ref = validRedditThread(job, { threadUrl: tab.url });
          return ref && ref.fullname === target.fullname;
        });
        resolve(matches.find(function (tab) { return previous && tab.id === previous.tabId; }) ||
          matches.find(function (tab) { return tab.id === t.submitTabId; }) || matches[0] || null);
      });
    }).then(function (tab) {
      if (tab) return remember(tab.id, previous && previous.tabId === tab.id && previous.owned).then(function () {
        return ungroupTab(tab.id);
      }).then(function () { return navigate(tab.id, editUrl); });
      return openScheduledTab(editUrl, { grouped: false,
        created: function (tabId) { return remember(tabId, true); } });
    }).catch(function (e) { return editFailed(t.id, token, 'could not open Reddit: ' + errorText(e), false); });
  });
}
function jobForEdit(msg, sender) {
  return readJobs().then(function (jobs) {
    var tabId = sender.tab && sender.tab.id;
    var found = findThread(jobs, msg.jobId, tabId, 'edit');
    if (!found) return { ok: false, none: true };
    var job = found.job, t = found.thread, u = t.update, target = validRedditThread(job, t);
    var page = validRedditThread(job, { threadUrl: sender.tab && sender.tab.url });
    if (job.cancelled || t.state !== 'posted' || !editing(t) || tabId == null || u.tabId !== tabId ||
        !u.body || !target || !page || target.fullname !== page.fullname ||
        (t.kind === 'live' && job.liveUpdatesStopped)) return { ok: false, none: true };
    return { ok: true, jobId: t.id, editToken: u.editToken, thingId: target.fullname,
      subreddit: job.subreddit, originalBody: t.body, newBody: u.body };
  });
}
function cleanupEdit(found) {
  if (!found || !found.thread.update) return Promise.resolve();
  var t = found.thread, u = t.update;
  if (t.kind === 'live' || !u.owned) return regroupTab(u.tabId);
  return getTab(u.tabId).then(function (tab) {
    var target = validRedditThread(found.job, t);
    var page = tab && validRedditThread(found.job, { threadUrl: tab.url });
    if (target && page && target.fullname === page.fullname) {
      return tabEditP(function (cb) { chrome.tabs.remove(tab.id, cb); });
    }
  });
}
function editFailed(id, token, reason, permanent) {
  return updateThread(id, function (t, job) {
    var u = t.update;
    if (!editing(t) || (u.legacy ? !!token : u.editToken !== token)) return;
    if (permanent || (u.attempts || 0) >= MAX_EDIT_ATTEMPTS || Date.now() >= u.deadline) {
      stopUpdate(job, t, reason, permanent);
    } else {
      u.nextAt = Date.now() + UPDATE_CHECK_MS;
      threadNote(job, t, 'Reddit edit failed; will retry', { error: reason });
    }
  }).then(function (found) {
    if (found && found.thread.update.status === 'stopped') {
      return cleanupEdit(found).then(function () { return releaseWatchTab(found.job.id); });
    }
  });
}
function editResult(msg, sender) {
  var accepted = false;
  return updateThread(msg.jobId, function (t, job) {
    var u = t.update;
    if (job.cancelled || !editing(t) || !sender.tab || sender.tab.id !== u.tabId ||
        (u.legacy ? !!msg.editToken : u.editToken !== msg.editToken) ||
        (t.kind === 'live' && job.liveUpdatesStopped)) return;
    accepted = true;
    if (!msg.ok) return;
    t.body = u.body; u.body = null;
    t.publishedSignature = u.signature || t.publishedSignature || '';
    u.status = u.purpose === 'maps' && !job.overSince ? 'waiting' : 'done';
    u.nextAt = u.status === 'waiting' ? Date.now() + UPDATE_CHECK_MS : null;
    u.attempts = 0; u.buildErrors = 0; u.error = null;
    if (u.purpose === 'final') t.finalState = 'done';
    threadNote(job, t, u.purpose === 'final' ? 'finalized with the post-match discussion link' : 'Reddit thread updated');
    notify(job, u.purpose === 'final' ? 'Live discussion finalized' : 'Match thread updated', t.title || job.label);
  }).then(function (found) {
    if (!accepted || !found) return;
    if (!msg.ok) return editFailed(msg.jobId, msg.editToken, msg.error || 'Reddit edit failed', !!msg.permanent);
    return cleanupEdit(found).then(function () { return releaseWatchTab(found.job.id); });
  }).then(function () { return tick(); });
}

/* -------------------------------------------------------------- the loop */

function monitorSubmission(job, t) {
  if (t.state !== 'submitting') return Promise.resolve();
  var now = Date.now();
  if (t.reopenSubmitAt && now >= t.reopenSubmitAt) {
    return updateThread(t.id, function (current) {
      current.reopenSubmitAt = null; current.submitOpenedAt = now;
    }).then(function () { return openSubmitTab(t.id); });
  }
  if (t.reopenSubmitAt) return Promise.resolve();
  // A worker may have stopped between claiming and opening the tab. Recover
  // that unspent attempt; an already-clicked submit is never reopened.
  if (t.submitOpening && !t.submitTabId && !t.submitClickedAt && now - t.submitOpenedAt > UNSEEN_SUBMIT_MS) {
    return updateThread(t.id, function (current) {
      current.submitOpening = null; current.reopenSubmitAt = now;
    });
  }
  if ((!t.submitPageSeenAt && now - t.submitOpenedAt > UNSEEN_SUBMIT_MS) ||
      now - t.submitOpenedAt > SUBMIT_TIMEOUT_MS) {
    return getTab(t.submitTabId).then(function (tab) {
      return updateThread(t.id, function (current, owner) {
        if (current.state !== 'submitting') return;
        needsPerson(owner, current, current.submitClickedAt ?
          'Reddit has not confirmed the post; check the subreddit before retrying' :
          'Reddit submit page did not finish (' + (tab ? String(tab.url || '').split('?')[0] : 'tab closed') + ')');
      });
    });
  }
  return thawIfFrozen(job, t.submitTabId);
}
function tickJob(id, settings) {
  if (checking[id]) return Promise.resolve();
  checking[id] = true;
  return updateJob(id, expireWork).then(function (job) {
    if (!job || job.cancelled) return;
    return Promise.all(threads(job).map(function (t) {
      var submission = monitorSubmission(job, t);
      if (!editing(t)) return submission;
      return submission.then(function () {
        if (t.update.nextAt && Date.now() >= t.update.nextAt) return startEdit(t.id);
        if (!t.update.nextAt && Date.now() - t.update.startedAt > EDIT_TIMEOUT_MS) {
          return editFailed(t.id, t.update.editToken, 'Reddit did not confirm the edit', false);
        }
        return thawIfFrozen(job, t.update.tabId);
      });
    }));
  }).then(function () { return getJob(id); }).then(function (job) {
    if (!job || job.cancelled) return;
    if (job.build) {
      if (Date.now() - job.build.startedAt > BUILD_TIMEOUT_MS) {
        return buildFailed(id, job.build.requestId, 'the match tab did not finish generating');
      }
      return thawIfFrozen(job, job.watchTabId);
    }
    var live = job.threads.live;
    if (finalNeeded(job) && !editing(live) &&
        !(live.update && live.update.purpose === 'final' && live.update.status === 'waiting' &&
          live.update.nextAt > Date.now())) {
      return startBuild(id, 'live', 'final', false);
    }
    if (needsSource(job) && Date.now() >= (job.nextCheckAt || 0)) return checkMatch(job, settings);
  }).then(function () { return releaseWatchTab(id); }).catch(function (e) {
    console.error('[PMT schedule] match workflow failed', id, e);
  }).then(function () { delete checking[id]; });
}
function tick() {
  return Promise.all([readJobs(), scheduleSettings()]).then(function (r) {
    var jobs = r[0], settings = r[1];
    var old = jobList(jobs).filter(function (job) {
      return !hasWork(job) && job.state !== 'attention' && Date.now() - job.updatedAt > KEEP_FINISHED_MS;
    }).map(function (job) { return job.id; });
    var prune = !old.length ? Promise.resolve() : withJobs(function (all) {
      old.forEach(function (id) { if (all[id] && !hasWork(all[id]) && all[id].state !== 'attention') delete all[id]; });
    });
    return prune.then(function () {
      return Promise.all(jobList(jobs).filter(function (job) { return old.indexOf(job.id) < 0; })
        .map(function (job) { return tickJob(job.id, settings); }));
    });
  }).catch(function (e) { console.error('[PMT schedule] tick failed', e); });
}

/* --------------------------------------------------------- user controls */

function notify(job, title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create('pmt|' + job.id + '|' + Date.now(), {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: title, message: message || '', priority: 1
  }, function () { void chrome.runtime.lastError; });
}
function addJob(url, label, kind) {
  kind = kind === 'live' ? 'live' : 'post';
  var matchUrl = String(url || '').split(/[?#]/)[0], matchId = matchIdOf(matchUrl);
  if (!matchId) return Promise.resolve({ ok: false, error: 'not an HLTV match page' });
  return scheduleSettings().then(function (settings) {
    var sub = String(settings.subreddit || SCHEDULE_DEFAULTS.subreddit).trim();
    if (!/^[a-z0-9_]+$/i.test(sub)) return { ok: false, error: 'set a valid destination subreddit in Options' };
    return withJobs(function (jobs) {
      var id = workflowId(matchId, sub), job = jobs[id], existed = !!job;
      if (!job) job = jobs[id] = newJob(matchId, matchUrl, label, settings);
      if (job.cancelled) {
        if (threads(job).some(function (t) { return t.submitClickedAt && !t.threadUrl; })) {
          return { ok: false, error: 'a previous submission is unconfirmed; check Reddit and use Retry in Options' };
        }
        job.cancelled = false;
        threads(job).forEach(function (t) {
          if (t.state === 'cancelled' && !t.threadUrl) job.threads[t.kind] = newThread(job, t.kind);
        });
      }
      if (kind === 'live' && !job.threads.live) {
        job.mode = 'live'; job.threads.live = newThread(job, 'live');
        jobNote(job, existed ? 'upgraded to live discussion plus post-match thread' : 'scheduled live discussion plus post-match thread');
      } else if (!existed) jobNote(job, 'scheduled post-match thread');
      // An archived live-only schedule may have a deliberately skipped PMT.
      if (kind === 'post' && job.threads.post.state === 'skipped') job.threads.post = newThread(job, 'post');
      job.nextCheckAt = Date.now();
      return { ok: true, job: job, existed: existed };
    });
  }).then(function (result) { if (result.ok) tick(); return result; });
}
function cancelJob(id) {
  return updateJob(id, function (job) {
    job.cancelled = true; job.build = null; job.replaceWatchTab = true;
    threads(job).forEach(function (t) {
      if (t.state !== 'posted' && t.state !== 'skipped') t.state = 'cancelled';
      if (t.update) { t.update.status = 'stopped'; t.update.nextAt = null; }
    });
    jobNote(job, 'cancelled the entire match workflow');
  }).then(function (job) {
    if (!job) return { ok: false };
    return releaseWatchTab(id).then(function () { return { ok: true }; });
  });
}
function stopLiveUpdates(id) {
  return updateJob(id, function (job) {
    var live = job.threads.live;
    if (!live || live.state !== 'posted') return;
    job.liveUpdatesStopped = true;
    if (live.update) { live.update.status = 'stopped'; live.update.nextAt = null; }
    if (job.build && job.build.kind === 'live') { job.build = null; job.replaceWatchTab = true; }
    jobNote(job, 'stopped LMT editing; the scheduled PMT remains active');
  }).then(function () { return releaseWatchTab(id); }).then(function () { return { ok: true }; });
}
function retryJob(id, kind, allowResubmit) {
  return withJobs(function (jobs) {
    var job = jobs[id], t = job && job.threads[kind || 'post'];
    if (!t) return { ok: false, error: 'no scheduled thread of that type' };
    if (['failed', 'attention', 'cancelled', 'skipped'].indexOf(t.state) < 0) return { ok: false, error: 'thread is already active or posted' };
    if (t.submitClickedAt && !allowResubmit) return { ok: false, error: 'check Reddit before authorizing another submission' };
    job.cancelled = false;
    // Reset only this thread. The other thread's consumed permission survives.
    var replacement = newThread(job, t.kind);
    replacement.id = t.id;
    job.threads[t.kind] = replacement;
    job.nextCheckAt = Date.now(); job.errors = 0; job.replaceWatchTab = true;
    job.monitorDeadline = Date.now() + (job.mode === 'live' ? LIVE_MAX_MONITOR_MS : GIVE_UP_MS);
    threadNote(job, replacement, 'retry requested by user');
    return { ok: true };
  }).then(function (result) { if (result.ok) tick(); return result; });
}
function retryUpdate(id, kind) {
  return updateJob(id, function (job) {
    var t = job.threads[kind];
    if (!t || t.state !== 'posted' || editing(t) || (job.build && job.build.kind === kind)) return;
    var purpose = kind === 'post' ? 'stats' : job.threads.post.state === 'posted' ? 'final' : 'maps';
    if (kind === 'live') { job.liveUpdatesStopped = false; t.finalState = null; }
    t.update = { purpose: purpose, status: 'waiting', nextAt: Date.now(),
      deadline: Date.now() + (purpose === 'maps' ? LIVE_MAX_MONITOR_MS : STATS_UPDATE_WINDOW_MS) };
    job.nextCheckAt = Date.now();
    threadNote(job, t, 'retrying ' + purpose + ' updates');
  }).then(function () { tick(); return { ok: true }; });
}
function removeJob(id) {
  return withJobs(function (jobs) {
    if (!jobs[id] || hasWork(jobs[id])) return { ok: false, error: 'cancel the workflow first' };
    delete jobs[id]; return { ok: true };
  });
}
function focusJob(id, kind) {
  return getJob(id).then(function (job) {
    if (!job) return chrome.runtime.openOptionsPage();
    var t = job.threads[kind] || job.threads.post || job.threads.live;
    if (t && t.state === 'failed') return chrome.runtime.openOptionsPage();
    var tabId = t && (t.submitTabId || (t.update && t.update.tabId)) || job.watchTabId;
    return getTab(tabId).then(function (tab) {
      if (t && t.threadUrl && (!tab || !validRedditThread(job, { threadUrl: tab.url }) ||
          validRedditThread(job, { threadUrl: tab.url }).fullname !== validRedditThread(job, t).fullname)) {
        return tabEditP(function (cb) { chrome.tabs.create({ url: t.threadUrl, active: true }, cb); });
      }
      if (!tab) return chrome.runtime.openOptionsPage();
      return tabEditP(function (cb) { chrome.tabs.update(tab.id, { active: true }, cb); }).then(function () {
        chrome.windows.update(tab.windowId, { focused: true });
      });
    });
  });
}

/* ------------------------------------------------------------ messaging */

var SCHEDULE_HANDLERS = {
  scheduleAdd: function (msg) { return addJob(msg.url, msg.label, msg.kind); },
  scheduleStopUpdates: function (msg) { return stopLiveUpdates(msg.jobId); },
  scheduleCancel: function (msg) { return cancelJob(msg.jobId); },
  scheduleRetry: function (msg) { return retryJob(msg.jobId, msg.kind, msg.allowResubmit); },
  scheduleRetryUpdate: function (msg) { return retryUpdate(msg.jobId, msg.kind); },
  scheduleRemove: function (msg) { return removeJob(msg.jobId); },
  scheduleFocus: function (msg) { return focusJob(msg.jobId, msg.kind); },
  scheduledThread: threadBuilt,
  scheduledRegenerated: threadBuilt,
  scheduledJobForSubmit: jobForSubmit,
  scheduledSubmitClicking: submitGoAhead,
  scheduledSubmitResult: submitStopped,
  scheduledSubmitLog: function (msg, sender) {
    return updateThread(msg.jobId, function (t, job) {
      if (sender.tab && t.submitTabId === sender.tab.id) threadNote(job, t, 'reddit: ' + msg.msg, msg.data);
    });
  },
  scheduledLanded: submitLanded,
  // Keep the wire names for in-flight edit tabs from earlier versions.
  scheduledMap3EditJob: jobForEdit,
  scheduledMap3EditResult: editResult
};

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var handle = msg && SCHEDULE_HANDLERS[msg.type];
  if (!handle) return false;
  schedulerReady.then(function () { return handle(msg, sender); })
    .then(function (res) { sendResponse(res || { ok: true }); },
      function (e) { sendResponse({ ok: false, error: errorText(e) }); });
  return true;
});
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === SCHEDULE_ALARM) schedulerReady.then(tick);
});
chrome.tabs.onRemoved.addListener(function (tabId) {
  schedulerReady.then(function () {
    return withJobs(function (jobs) {
      var builds = [];
      jobList(jobs).forEach(function (job) {
        if (job.watchTabId === tabId) {
          job.watchTabId = null;
          if (job.build) builds.push({ id: job.id, token: job.build.requestId });
        }
        threads(job).forEach(function (t) {
          if (t.submitTabId === tabId) {
            t.submitTabId = null;
            if (!job.cancelled && t.state === 'submitting') needsPerson(job, t,
              t.submitClickedAt ? 'submit tab closed after clicking; check Reddit before retrying' : 'submit tab closed before posting');
          }
          if (t.update && t.update.tabId === tabId) {
            t.update.tabId = null;
            if (!job.cancelled && editing(t) && !t.update.nextAt) {
              t.update.nextAt = Date.now() + UPDATE_CHECK_MS;
              threadNote(job, t, 'Reddit edit tab closed; will retry');
            }
          }
        });
      });
      return builds;
    });
  }).then(function (builds) {
    return Promise.all(builds.map(function (b) { return buildFailed(b.id, b.token, 'watch tab closed during generation'); }));
  }).catch(function (e) { console.error('[PMT schedule] tab cleanup failed', e); });
});
if (chrome.notifications) chrome.notifications.onClicked.addListener(function (id) {
  var parts = String(id).split('|');
  if (parts[0] === 'pmt') { chrome.notifications.clear(id); schedulerReady.then(function () { return focusJob(parts[1]); }); }
});

function restoreScheduler() {
  return scheduleSettings().then(function (settings) {
    return withJobs(function (jobs) { return migrateJobs(jobs, settings); });
  }).then(function (redundant) {
    return Promise.all(redundant.map(function (entry) {
      return getTab(entry.tabId).then(function (tab) {
        if (tab && matchIdOf(tab.url) === entry.matchId) return tabEditP(function (cb) { chrome.tabs.remove(tab.id, cb); });
      });
    }));
  }).then(function () {
    return new Promise(function (resolve) {
      chrome.alarms.get(SCHEDULE_ALARM, function (alarm) { alarmOn = !!alarm; resolve(); });
    });
  }).then(function () { return withJobs(function () {}, true); });
}
var schedulerReady = restoreScheduler();
chrome.runtime.onStartup.addListener(function () { schedulerReady.then(tick); });
liveGroup();
schedulerReady.then(tick).catch(function (e) { console.error('[PMT schedule] restore failed', e); });
