var DEFAULTS = {
  subreddit: 'GlobalOffensive',
  autoOpen: true,
  flair: 'Discussion | Esports',
  flairSelector: '.linkflair.linkflair-discussion.linkflair-esports > .linkflairlabel',
  flairApplySelector: '#newlink-flair-dropdown > form > button',
  logoOverrides: {},
  checkMinutes: 1,
  autoSubmit: true
};

function toText(map) {
  return Object.keys(map || {}).sort().map(function (k) { return k + ' = ' + map[k]; }).join('\n');
}

function toMap(text) {
  var out = {};
  String(text || '').split('\n').forEach(function (line) {
    var i = line.indexOf('=');
    if (i < 0) return;
    var name = line.slice(0, i).trim().toLowerCase();
    var slug = line.slice(i + 1).trim().toLowerCase();
    if (name && slug) out[name] = slug;
  });
  return out;
}

chrome.storage.sync.get(DEFAULTS, function (v) {
  document.getElementById('subreddit').value = v.subreddit;
  document.getElementById('autoOpen').checked = !!v.autoOpen;
  document.getElementById('flair').value = v.flair;
  document.getElementById('flairSelector').value = v.flairSelector;
  document.getElementById('flairApplySelector').value = v.flairApplySelector;
  document.getElementById('logos').value = toText(v.logoOverrides);
  document.getElementById('checkMinutes').value = v.checkMinutes;
  document.getElementById('autoSubmit').checked = v.autoSubmit !== false;
});

document.getElementById('save').addEventListener('click', function () {
  var minutes = parseFloat(document.getElementById('checkMinutes').value);
  chrome.storage.sync.set({
    subreddit: document.getElementById('subreddit').value.trim().replace(/^\/?r\//, '') || 'GlobalOffensive',
    autoOpen: document.getElementById('autoOpen').checked,
    flair: document.getElementById('flair').value.trim(),
    flairSelector: document.getElementById('flairSelector').value.trim(),
    flairApplySelector: document.getElementById('flairApplySelector').value.trim(),
    logoOverrides: toMap(document.getElementById('logos').value),
    checkMinutes: minutes > 0 ? Math.min(30, Math.max(0.5, minutes)) : DEFAULTS.checkMinutes,
    autoSubmit: document.getElementById('autoSubmit').checked
  }, function () {
    var s = document.getElementById('status');
    s.textContent = 'Saved';
    setTimeout(function () { s.textContent = ''; }, 1500);
  });
});

/* ------------------------------------------------------------- diagnostics */

function logText(run) {
  return ['# HLTV post-match thread - run log', '# ' + run.label, '# ' + run.at, '']
    .concat(run.entries.map(function (e) {
      return String(e.ms).padStart(6) + 'ms  ' + e.level.toUpperCase().padEnd(5) + ' ' + e.step +
        (e.data === undefined ? '' : '  ' + JSON.stringify(e.data));
    })).join('\n');
}

function renderRuns() {
  chrome.storage.local.get(['pmt:logs'], function (v) {
    var runs = (v && v['pmt:logs']) || [];
    var host = document.getElementById('runs');
    host.textContent = '';
    if (!runs.length) {
      host.appendChild(Object.assign(document.createElement('p'),
        { className: 'hint', textContent: 'No runs recorded yet.' }));
      return;
    }
    runs.slice().reverse().forEach(function (run) {
      var bad = run.entries.filter(function (e) { return e.level === 'warn' || e.level === 'error'; });
      var box = document.createElement('div');
      box.className = 'run';

      var h = document.createElement('h3');
      h.textContent = run.at;
      box.appendChild(h);

      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = run.label + ' — ' + run.entries.length + ' steps, ';
      var count = document.createElement('span');
      count.className = bad.length ? 'bad' : '';
      count.textContent = bad.length + ' warning/error' + (bad.length === 1 ? '' : 's');
      meta.appendChild(count);
      box.appendChild(meta);

      var pre = document.createElement('pre');
      pre.textContent = logText(run);

      var copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', function () {
        navigator.clipboard.writeText(logText(run)).then(function () {
          copy.textContent = 'Copied';
          setTimeout(function () { copy.textContent = 'Copy'; }, 1200);
        });
      });
      var show = document.createElement('button');
      show.textContent = 'Show';
      show.addEventListener('click', function () {
        pre.classList.toggle('open');
        show.textContent = pre.classList.contains('open') ? 'Hide' : 'Show';
      });

      box.appendChild(copy);
      box.appendChild(show);
      box.appendChild(pre);
      host.appendChild(box);
    });
  });
}

document.getElementById('clearLogs').addEventListener('click', function () {
  chrome.storage.local.remove('pmt:logs', renderRuns);
});

// The Liquipedia link cache never expires, so this is how a wrong match gets undone.
document.getElementById('clearCache').addEventListener('click', function () {
  chrome.storage.local.get(null, function (all) {
    var keys = Object.keys(all).filter(function (k) { return k.indexOf('lp:') === 0; });
    chrome.storage.local.remove(keys, function () {
      var s = document.getElementById('cacheStatus');
      s.textContent = 'Forgot ' + keys.length + ' link' + (keys.length === 1 ? '' : 's');
      setTimeout(function () { s.textContent = ''; }, 2500);
    });
  });
});

/* --------------------------------------------------------- scheduled jobs */

var openLogs = {};

var JOB_STATES = {
  watching: 'watching', generating: 'building', submitting: 'posting', posted: 'posted',
  attention: 'needs you', failed: 'failed', cancelled: 'cancelled'
};

function when(ms) {
  return ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function jobLogText(job) {
  return (job.log || []).map(function (e) {
    return when(e.at) + '  ' + e.msg + (e.data === undefined ? '' : '  ' + JSON.stringify(e.data));
  }).join('\n');
}

// What gets pasted into a bug report: the job's log with enough of the job
// around it to read it cold.
function jobReport(job) {
  var v = '?';
  try { v = chrome.runtime.getManifest().version; } catch (e) { /* options page */ }
  var seen = job.lastSeen || {};
  return ['# HLTV post-match thread - scheduled job log',
    '# ' + (job.label || job.matchUrl),
    '# ' + job.matchUrl,
    '# id ' + job.id + ', state ' + job.state + (job.error ? ' - ' + job.error : '') + ', version ' + v,
    // the log only records changes; this is what the watch was doing when copied
    '# checks ' + (job.checks || 0) + ', last ' + (when(job.lastCheckAt) || 'never') +
      (seen.phase ? ' (' + seen.phase + (seen.countdown ? ', "' + seen.countdown + '"' : '') + ')' : '') +
      (job.state === 'watching' ? ', next ' + when(job.nextCheckAt) : '') +
      (job.staleChecks ? ', stale pages in a row ' + job.staleChecks : '') +
      (job.errors ? ', errors in a row ' + job.errors : ''),
    '# copied ' + when(Date.now()),
    '# threads ' + JSON.stringify(job.threads && Object.keys(job.threads).map(function (kind) {
      var t = job.threads[kind];
      return { kind: kind, id: t.id, state: t.state, url: t.threadUrl,
        submitClickedAt: t.submitClickedAt, finalState: t.finalState, update: t.update && {
          purpose: t.update.purpose, status: t.update.status, attempts: t.update.attempts, error: t.update.error } };
    })),
    ''].concat(jobLogText(job)).join('\n');
}

function copyWithFeedback(button, text) {
  var label = button.textContent;
  navigator.clipboard.writeText(text).then(function () {
    button.textContent = 'Copied';
    setTimeout(function () { button.textContent = label; }, 1200);
  });
}

function jobButton(label, onClick) {
  var b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function sendJob(type, id, kind, allowResubmit) {
  chrome.runtime.sendMessage({ type: type, jobId: id, kind: kind, allowResubmit: allowResubmit }, function (res) {
    var error = chrome.runtime.lastError;
    if (error || (res && res.ok === false)) alert((res && res.error) || (error && error.message) || 'Could not update the schedule');
  });
}

function jobSummary(job) {
  var seen = job.lastSeen || {};
  if (job.active) {
    return 'last checked ' + (when(job.lastCheckAt) || 'not yet') +
      (seen.phase ? ' (' + seen.phase + (seen.countdown ? ', "' + seen.countdown + '"' : '') + ')' : '') +
      ', next ' + when(job.nextCheckAt);
  }
  if (job.state === 'posted') return 'posted ' + when(job.updatedAt);
  return 'since ' + when(job.updatedAt);
}

function renderThread(job, thread, box) {
  var name = thread.kind === 'live' ? 'LMT' : 'PMT';
  var line = document.createElement('div');
  line.className = 'meta thread';
  var summary = name + ': ' + (thread.state === 'watching' ? 'pending' : thread.state);
  if (thread.kind === 'live' && thread.state === 'posted') {
    summary += thread.finalState === 'done' ? ' · finalized' : job.liveUpdatesStopped ? ' · updates stopped'
      : job.overSince ? ' · PMT handoff pending' : ' · monitoring maps';
  }
  if (thread.update) summary += ' · ' + thread.update.purpose + ' updates: ' + thread.update.status;
  line.textContent = summary;
  box.appendChild(line);
  if (thread.threadUrl) {
    var link = document.createElement('a');
    link.href = thread.threadUrl; link.target = '_blank'; link.textContent = 'Open ' + name;
    line.appendChild(document.createTextNode(' · ')); line.appendChild(link);
  }
  var error = thread.error || (thread.update && thread.update.error);
  if (error) box.appendChild(Object.assign(document.createElement('div'), { className: 'err', textContent: name + ': ' + error }));
  if (thread.notes && thread.notes.length) box.appendChild(Object.assign(document.createElement('div'), {
    className: 'meta', textContent: name + ' missing: ' + thread.notes.join('; ')
  }));
  if (thread.state === 'attention' || thread.state === 'submitting') {
    box.appendChild(jobButton('Go to ' + name + ' submit tab', function () { sendJob('scheduleFocus', job.id, thread.kind); }));
  }
  if (['attention', 'failed', 'cancelled'].indexOf(thread.state) >= 0) {
    box.appendChild(jobButton('Retry ' + name, function () {
      var allowed = !thread.submitClickedAt || confirm(
        'Submit was already clicked for this ' + name + '. Check r/' + job.subreddit +
        ' first. Retrying may post it twice. Authorize another submission?');
      if (allowed) sendJob('scheduleRetry', job.id, thread.kind, !!thread.submitClickedAt);
    }));
  }
  if (thread.state === 'posted' && thread.update && thread.update.status === 'stopped' && !job.cancelled) {
    box.appendChild(jobButton(thread.kind === 'live' && job.liveUpdatesStopped ? 'Resume LMT editing' :
      thread.finalState === 'stopped' ? 'Retry final LMT edit' : 'Retry ' + name + ' updates',
    function () { sendJob('scheduleRetryUpdate', job.id, thread.kind); }));
  }
  if (thread.body && thread.state !== 'posted') {
    var title = jobButton('Copy ' + name + ' title', function () { copyWithFeedback(title, thread.title || ''); });
    var body = jobButton('Copy ' + name + ' body', function () { copyWithFeedback(body, thread.body); });
    box.appendChild(title); box.appendChild(body);
  }
}
function renderJobs() {
  chrome.storage.local.get(['pmt:jobs'], function (v) {
    var jobs = (v && v['pmt:jobs']) || {};
    var list = Object.keys(jobs).map(function (k) { return jobs[k]; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
    var host = document.getElementById('jobs');
    host.textContent = '';
    if (!list.length) {
      host.appendChild(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Nothing scheduled.' }));
      return;
    }
    list.forEach(function (job) {
      if (!job.threads) return; // The background migrates earlier records on startup.
      var box = document.createElement('div'); box.className = 'run job';
      var h = document.createElement('h3'), pill = document.createElement('span');
      pill.className = 'state ' + job.state; pill.textContent = JOB_STATES[job.state] || job.state;
      h.appendChild(pill);
      var match = document.createElement('a');
      match.href = job.matchUrl; match.target = '_blank'; match.textContent = job.label || job.matchUrl;
      h.appendChild(match); box.appendChild(h);
      box.appendChild(Object.assign(document.createElement('div'), { className: 'meta',
        textContent: (job.mode === 'live' ? 'LMT + PMT' : 'PMT only') + ' · r/' + job.subreddit +
          ' · scheduled ' + when(job.createdAt) + ' · ' + jobSummary(job) }));
      ['live', 'post'].forEach(function (kind) { if (job.threads[kind]) renderThread(job, job.threads[kind], box); });
      if (job.active) box.appendChild(jobButton('Cancel entire workflow', function () {
        if (confirm('Cancel all remaining work for this match, including the pending PMT?')) sendJob('scheduleCancel', job.id);
      }));
      if (job.threads.live && job.threads.live.state === 'posted' && !job.liveUpdatesStopped &&
          job.threads.live.finalState !== 'done' && !job.cancelled) {
        box.appendChild(jobButton('Stop live updates', function () {
          if (confirm('Stop LMT editing? The scheduled PMT will remain active.')) sendJob('scheduleStopUpdates', job.id);
        }));
      }
      if (!job.active) box.appendChild(jobButton('Remove', function () { sendJob('scheduleRemove', job.id); }));
      var copyLog = jobButton('Copy log', function () { copyWithFeedback(copyLog, jobReport(job)); });
      box.appendChild(copyLog);
      var pre = document.createElement('pre'); pre.textContent = jobLogText(job);
      if (openLogs[job.id]) pre.classList.add('open');
      var show = jobButton(openLogs[job.id] ? 'Hide log' : 'Log', function () {
        openLogs[job.id] = pre.classList.toggle('open'); show.textContent = openLogs[job.id] ? 'Hide log' : 'Log';
      });
      box.appendChild(show); box.appendChild(pre); host.appendChild(box);
    });
  });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes['pmt:jobs']) renderJobs();
});

renderJobs();
renderRuns();
