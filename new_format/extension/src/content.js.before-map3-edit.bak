/*
 * content.js - runs on an HLTV match page and drives the whole thing.
 *
 * What gets fetched, per thread:
 *   - the HLTV event page      venue for the Setting line, and a name -> flag
 *                              directory used for the next opponent
 *   - a map stats page         only for maps that went to overtime; the match
 *                              page reports OT as a single aggregate, the
 *                              per-half split is in the round history. Fetched
 *                              same-origin from this page; a Cloudflare 403
 *                              ("Just a moment...") drops to the background
 *                              tab, the same fallback Liquipedia already uses.
 *   - HLTV team pages          only when the match page has no role pills;
 *                              HLTV hides `#lineups` the moment a series ends
 *   - the Liquipedia event and team pages
 *
 * Liquipedia has no lookup by HLTV name, so those three pages are located by
 * search (Google, then Brave). Those lookups are the one thing that IS cached -
 * keyed by the HLTV URL, kept indefinitely, and editable in the panel - so a
 * team is only ever searched for once. Clearing a box in the panel forgets the
 * saved page and searches again. Page contents are always re-read, so a thread
 * can never be built from a stale roster or ranking.
 *
 * Two threads from the same page:
 *   Post-Match Thread              finished match, VRS, highlights, "advances to"
 *   Live Match Discussion Thread   upcoming or in progress: streams, veto if it
 *                                  exists, completed maps only, no VRS
 *
 * And a third button that schedules the first: the service worker
 * (scheduler.js) keeps a tab on this match, reloads it until the match is over,
 * then asks the content script in *that* tab to run the same Post-Match
 * pipeline (`scheduledGenerate`) and posts what comes back.
 */

var DEFAULTS = {
  subreddit: 'GlobalOffensive',
  autoOpen: true,
  flair: 'Discussion | Esports',
  flairSelector: '.linkflair.linkflair-discussion.linkflair-esports > .linkflairlabel',
  flairApplySelector: '#newlink-flair-dropdown > form > button',
  logoOverrides: {}
};

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(DEFAULTS, function (v) { resolve(v || DEFAULTS); });
  });
}

/* ------------------------------------------------------------------ fetch */

// HLTV is same-origin from here, so it is fetched directly. Anything else
// has to go via the service worker. A challenged HLTV response (Cloudflare's
// "Just a moment..." on /stats/ is the usual one) drops to the same tab
// Liquipedia already uses - a fetch cannot run that interstitial.
function fetchDoc(url, label) {
  var t0 = Date.now();
  var tag = label ? label + ' <- ' + url : url;

  if (url.indexOf('https://www.hltv.org') === 0) {
    return fetch(url, { credentials: 'include' }).then(function (r) {
      return r.text().then(function (t) {
        var info = { via: 'page', status: r.status, bytes: t.length, ms: Date.now() - t0 };
        if (r.ok && !hltvLooksChallenged(t)) {
          PMTLog.info('fetch ' + tag, info);
          return { doc: parseHtml(t), url: r.url };
        }
        info.excerpt = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
        info.challenge = hltvLooksChallenged(t) || undefined;
        info.intercepted = r.ok || undefined;
        return fetchViaWorker(url, tag, true, info);
      });
    }, function (e) {
      return fetchViaWorker(url, tag, true, {
        via: 'page', status: 0, ms: Date.now() - t0,
        networkError: true, error: String((e && e.message) || e)
      });
    });
  }

  return fetchViaWorker(url, tag, false, null);
}

function hltvLooksChallenged(text) {
  return /just a moment|verify you are human|checking your browser/i.test(text || '');
}

function fetchViaWorker(url, tag, viaTab, pageFailed) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'fetchText', url: url, viaTab: viaTab }, function (res) {
      if (chrome.runtime.lastError) {
        PMTLog.error('fetch ' + tag, chrome.runtime.lastError);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!res) {
        PMTLog.error('fetch ' + tag, new Error('no reply from service worker'));
        return reject(new Error('no reply from service worker'));
      }
      var info = {
        via: res.via || 'worker', status: res.status, statusText: res.statusText,
        bytes: res.bytes, ms: res.ms, contentType: res.contentType,
        redirectedTo: res.url !== url ? res.url : undefined,
        error: res.error, headers: res.headers, excerpt: res.excerpt,
        challenge: res.challenge, intercepted: res.intercepted,
        retriedAfter: res.retriedAfter, afterTabFetch: res.afterTabFetch
      };
      if (pageFailed && !info.retriedAfter) {
        info.retriedAfter = {
          status: pageFailed.status, bytes: pageFailed.bytes,
          challenge: pageFailed.challenge, intercepted: pageFailed.intercepted,
          networkError: pageFailed.networkError, error: pageFailed.error,
          excerpt: pageFailed.excerpt
        };
      }
      if (res.ok) PMTLog.info('fetch ' + tag, info);
      else PMTLog.fail('fetch ' + tag + ' rejected', info);
      if (!res.ok) return reject(new Error(res.error || ('HTTP ' + res.status)));
      resolve({ doc: parseHtml(res.text), url: res.url });
    });
  });
}

function parseHtml(text) {
  return new DOMParser().parseFromString(text, 'text/html');
}

/* --------------------------------------------------- liquipedia link cache */

function liquipediaCacheKey(kind, hltvUrl) {
  return 'lp:' + kind + ':' + hltvUrl;
}

function cacheGet(key) {
  return new Promise(function (resolve) {
    chrome.storage.local.get([key], function (v) { resolve(v[key] || ''); });
  });
}

function cacheSet(key, value) {
  var patch = {};
  patch[key] = value;
  chrome.storage.local.set(patch);
}

function cacheForget(key) {
  return new Promise(function (resolve) {
    chrome.storage.local.remove(key, function () { void chrome.runtime.lastError; resolve(); });
  });
}

/*
 * Resolve an HLTV entity to its Liquipedia page, remembering the answer.
 *
 * `forget` is an emptied box in the panel. Clearing one and hitting Regenerate
 * reads as "I do not want this page" - so the remembered answer is thrown away
 * and the search runs again from scratch, exactly as it would for a team being
 * seen for the first time. Reloading the same remembered link, which is what it
 * used to do, is the one thing that cannot be what was meant by clearing it.
 */
function liquipediaUrlFor(kind, hltvUrl, searchName, override, forget) {
  var key = liquipediaCacheKey(kind, hltvUrl);
  if (override) {
    PMTLog.info('liquipedia ' + kind + ' from panel override', { name: searchName, url: override });
    cacheSet(key, override);
    return Promise.resolve(override);
  }
  var remembered = forget
    ? cacheForget(key).then(function () {
        PMTLog.info('liquipedia ' + kind + ' box cleared - forgetting the saved page and searching again',
          { name: searchName, key: key });
        return '';
      })
    : cacheGet(key);
  return remembered.then(function (hit) {
    if (hit) {
      PMTLog.info('liquipedia ' + kind + ' cache hit', { name: searchName, key: key, url: hit });
      return hit;
    }
    if (!searchName) {
      PMTLog.warn('liquipedia ' + kind + ' skipped', { reason: 'no name to search for', key: key });
      return '';
    }
    PMTLog.info('liquipedia ' + kind + ' cache miss, searching', { name: searchName });
    return searchInTab(kind, searchName).then(function (res) {
      if (res.url) {
        PMTLog.info('liquipedia ' + kind + ' search hit',
          { name: searchName, url: res.url, via: res.via, trace: res.trace });
        cacheSet(key, res.url);
      } else {
        PMTLog.warn('liquipedia ' + kind + ' search found nothing',
          { name: searchName, via: res.via, error: res.error, trace: res.trace });
      }
      return res.url;
    });
  });
}

// The search runs in a background tab: a service-worker fetch gets a captcha
// that it can never solve, because solving one needs a browser running the
// page's JavaScript.
function searchInTab(kind, name) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: 'search', kind: kind, name: name }, function (res) {
      if (chrome.runtime.lastError) {
        return resolve({ url: '', via: 'error', error: chrome.runtime.lastError.message });
      }
      resolve(res || { url: '', via: 'error', error: 'no reply from service worker' });
    });
  });
}

/* -------------------------------------------------------- hltv extra pages */

// td.location holds "Paris, France" or "Europe (Online)" plus the country flag.
// The same page lists every attending team with its flag, which is how the next
// opponent from the Liquipedia bracket gets one.
function readEventPage(doc) {
  var locTd = doc.querySelector('td.location');
  var setting = null;
  if (locTd) {
    var img = locTd.querySelector('img');
    setting = {
      place: locTd.textContent.replace(/\s+/g, ' ').trim()
        .replace(/\s*\((?:Online|LAN)\)\s*$/i, '').split(',')[0].trim(),
      flag: ((img && img.getAttribute('src') || '').match(/\/flags\/[^/]*\/([A-Za-z_-]+)\./) || [])[1] || ''
    };
    setting.flag = setting.flag.toUpperCase();
  }

  return { setting: setting, directory: readTeamDirectory(doc) };
}

// A flag sitting next to a /team/ link. The old event-page markup had the img
// as the previous sibling; current pages wrap the name, so we also look a few
// ancestors up. The match page itself lists other event teams (related results)
// and is merged in so a 3-team event-page directory is not the only source.
function flagImgNear(el) {
  var prev = el.previousElementSibling;
  if (prev && prev.tagName === 'IMG' && /\/flags\//.test(prev.getAttribute('src') || '')) {
    return prev;
  }
  var n = el.parentElement;
  for (var up = 0; up < 3 && n; up++) {
    var img = n.querySelector('img.flag, img[src*="/flags/"]');
    if (img && /\/flags\//.test(img.getAttribute('src') || '')) return img;
    n = n.parentElement;
  }
  return null;
}

function addDirectoryEntry(directory, name, img, url) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name || directory[name] || !img) return;
  var src = img.getAttribute('src') || '';
  var flag = ((src.match(/\/flags\/[^/]*\/([A-Za-z_-]+)\./) || [])[1] || '').toUpperCase();
  if (!flag) return;
  directory[name] = { flag: flag, url: url || '' };
}

function readTeamDirectory(doc) {
  var directory = {};
  Array.prototype.forEach.call(doc.querySelectorAll('a[href*="/team/"]'), function (a) {
    addDirectoryEntry(directory, a.textContent, flagImgNear(a), a.getAttribute('href'));
  });
  // Upcoming/related match boxes list teams as a flag + span.team, with no
  // /team/ link. That is how Falcons (and most of the rest of the event) show
  // up on this match page at all.
  Array.prototype.forEach.call(doc.querySelectorAll('.teamrow'), function (row) {
    var span = row.querySelector('.team');
    var img = row.querySelector('img.flag, img[src*="/flags/"]');
    addDirectoryEntry(directory, span && span.textContent, img, '');
  });
  return directory;
}

function mergeDirectory(a, b) {
  var out = {};
  [a, b].forEach(function (dir) {
    Object.keys(dir || {}).forEach(function (k) {
      if (!out[k]) out[k] = dir[k];
    });
  });
  return out;
}

var ORG_WORDS = ['esports', 'esport', 'gaming', 'team', 'club'];

// "FUT Esports" and "FUT" are the same org; so are "Team Vitality" and
// "Vitality". Comparing on the significant words only lets the two spellings
// meet. Splitting into words first means a standalone "Esports" is dropped
// while a name that merely contains those letters is left alone.
function orgKey(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (w) { return w && ORG_WORDS.indexOf(w) < 0; })
    .join('');
}

// Find a team in the HLTV event directory by a name that may carry a different
// org suffix. Returns { name, flag, url } using HLTV's own spelling.
function lookupTeam(directory, name) {
  if (!directory) return null;
  if (directory[name]) return Object.assign({ name: name }, directory[name]);
  var want = orgKey(name);
  if (!want) return null;
  var names = Object.keys(directory);
  for (var i = 0; i < names.length; i++) {
    if (orgKey(names[i]) === want) return Object.assign({ name: names[i] }, directory[names[i]]);
  }
  return null;
}

/* ------------------------------------------------------------------- panel */

var panel = null;

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
  }
  return legacyCopy(text);
}

function legacyCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

// selftext=true opens old.reddit's text-post tab; the flair rides in the hash so
// it never reaches the server or the posted URL.
function submitUrl(title, subreddit, flair) {
  return 'https://old.reddit.com/r/' + encodeURIComponent(subreddit) +
    '/submit?selftext=true&title=' + encodeURIComponent(title) +
    (flair ? '#pmt-flair=' + encodeURIComponent(flair) : '');
}

function field(parent, id, label, placeholder) {
  parent.appendChild(el('label', 'pmt-label', label));
  var i = el('input', 'pmt-input');
  i.id = id;
  if (placeholder) i.placeholder = placeholder;
  parent.appendChild(i);
  return i;
}

function buildPanel() {
  panel = el('div', 'pmt-panel');

  var head = el('div', 'pmt-head');
  head.appendChild(el('span', 'pmt-title-label', 'Post-Match Thread'));
  var close = el('button', 'pmt-x', '×');
  close.addEventListener('click', function () { panel.classList.remove('pmt-open'); });
  head.appendChild(close);
  panel.appendChild(head);

  field(panel, 'pmt-title', 'Thread title');

  panel.appendChild(el('div', 'pmt-label',
    'Liquipedia pages (found by search, remembered per team - clear one and Regenerate to search for it again)'));
  var lp = el('div', 'pmt-lp');
  ['pmt-lp-event', 'pmt-lp-t1', 'pmt-lp-t2'].forEach(function (id, i) {
    var input = el('input', 'pmt-input');
    input.id = id;
    input.placeholder = ['event', 'team 1', 'team 2'][i] + ' - https://liquipedia.net/counterstrike/…';
    lp.appendChild(input);
  });
  panel.appendChild(lp);

  panel.appendChild(el('label', 'pmt-label', 'Highlights (one per line: Title | url)'));
  var hl = el('textarea', 'pmt-hl');
  hl.id = 'pmt-hl';
  hl.rows = 3;
  panel.appendChild(hl);

  panel.appendChild(el('label', 'pmt-label', 'Body (markdown)'));
  var body = el('textarea', 'pmt-body');
  body.id = 'pmt-body';
  panel.appendChild(body);

  var row = el('div', 'pmt-row');
  var regen = el('button', 'pmt-btn', 'Regenerate');
  regen.addEventListener('click', function () { generate({ noOpen: true, fromPanel: true }); });
  var copy = el('button', 'pmt-btn pmt-primary', 'Copy body');
  copy.addEventListener('click', function () {
    copyText(document.getElementById('pmt-body').value)
      .then(function () { status('Copied to clipboard.'); })
      .catch(function () { status('Copy failed - select the text and press Ctrl+C.', true); });
  });
  var diag = el('button', 'pmt-btn', 'Copy diagnostics');
  diag.id = 'pmt-diag';
  diag.title = 'Copy this run\'s log - paste it when reporting a problem';
  diag.addEventListener('click', function () {
    copyText(PMTLog.text())
      .then(function () { status('Diagnostics copied - paste them into the bug report.'); })
      .catch(function () { status('Could not copy; the log is also in the devtools console.', true); });
  });
  var open = el('button', 'pmt-btn', 'Open reddit submit');
  open.addEventListener('click', function () {
    getSettings().then(function (s) {
      chrome.runtime.sendMessage({
        type: 'openTab',
        url: submitUrl(document.getElementById('pmt-title').value, s.subreddit, s.flair)
      });
    });
  });
  row.appendChild(regen);
  row.appendChild(copy);
  row.appendChild(open);
  row.appendChild(diag);
  panel.appendChild(row);

  panel.appendChild(el('div', 'pmt-status', ''));
  document.body.appendChild(panel);
  return panel;
}

function status(msg, isError) {
  if (!panel) return;
  var s = panel.querySelector('.pmt-status');
  s.textContent = msg;
  s.className = 'pmt-status' + (isError ? ' pmt-error' : '');
}

// Make the Copy diagnostics button shout when the run logged anything bad, so a
// partial thread is noticed before it is posted rather than after.
function refreshDiagnostics() {
  var btn = document.getElementById('pmt-diag');
  if (!btn) return;
  var c = PMTLog.counts();
  var bad = c.error + c.warn;
  btn.textContent = bad ? 'Copy diagnostics (' + bad + ')' : 'Copy diagnostics';
  btn.className = 'pmt-btn' + (c.error ? ' pmt-alert' : bad ? ' pmt-warn' : '');
}

function parseHighlights(raw) {
  return String(raw || '').split('\n').map(function (line) {
    var i = line.lastIndexOf('|');
    if (i < 0) return null;
    var title = line.slice(0, i).trim();
    var url = line.slice(i + 1).trim();
    return title && /^https?:/.test(url) ? { title: title, url: url } : null;
  }).filter(Boolean);
}

// Liquipedia's event streams are preferred (same as the post-match thread).
// When that table is empty - typical of a small online qualifier - fall back
// to the match page, WORLD feeds first, capped so a 70-caster BLAST list does
// not become the body of the thread.
function pickHltvStreams(list) {
  var src = list || [];
  var world = src.filter(function (s) { return s.flag === 'WORLD'; });
  var rest = src.filter(function (s) { return s.flag !== 'WORLD'; });
  return world.concat(rest).slice(0, 4).map(function (s) {
    return { label: s.label, url: s.url };
  });
}

/*
 * The thread's copy of what it is built from, with gambling brands rewritten
 * or dropped (censor.js): names through the replacement rules, HLTV slugs
 * rewritten, branded Liquipedia links swapped for the page id, branded stream
 * links dropped. A copy, because the originals are still wanted as they are -
 * the panel's Liquipedia boxes and the link cache hold the real addresses.
 * `changed` lists every rewrite, for the run log.
 */
function censorForThread(d, extra) {
  var changed = [];
  var name = function (s) {
    var c = censorName(s);
    if (s && c !== s) changed.push(s + ' -> ' + c);
    return c;
  };
  var url = function (u, id) {
    var c = censorUrl(u, id);
    if (u && c !== u) changed.push(u + ' -> ' + c);
    return c;
  };
  var opponents = function (list) {
    return (list || []).map(function (o) { return Object.assign({}, o, { name: name(o.name) }); });
  };
  var titled = function (list) {
    return list && list.map(function (h) { return Object.assign({}, h, { title: name(h.title) }); });
  };

  var copy = Object.assign({}, d, {
    matchUrl: url(d.matchUrl),
    event: Object.assign({}, d.event, { name: name(d.event.name), url: url(d.event.url) }),
    teams: d.teams.map(function (t) {
      return Object.assign({}, t, { name: name(t.name), url: url(t.url), urlPlain: url(t.urlPlain) });
    }),
    maps: d.maps.map(function (m) { return Object.assign({}, m, { statsUrl: url(m.statsUrl) }); }),
    highlights: titled(d.highlights || []),
    format: Object.assign({}, d.format, {
      stage: name(d.format.stage),
      outcomeSentences: (d.format.outcomeSentences || []).map(name)
    })
  });
  var next = extra.next && Object.assign({}, extra.next, {
    advance: extra.next.advance && Object.assign({}, extra.next.advance, {
      round: name(extra.next.advance.round), opponents: opponents(extra.next.advance.opponents)
    }),
    drop: extra.next.drop && Object.assign({}, extra.next.drop, {
      opponents: opponents(extra.next.drop.opponents)
    })
  });
  return {
    d: copy,
    lp: extra.lp.map(function (t) {
      return t && Object.assign({}, t, { name: name(t.name), url: url(t.url, t.articleId) });
    }),
    lpEventUrl: extra.lpe ? url(extra.lpe.url, liquipediaArticleId(extra.lpe.doc)) : '',
    streams: (extra.streams || []).filter(function (s) {
      if (!isGamblingLink(s.url)) return true;
      changed.push('stream dropped: ' + s.url);
      return false;
    }).map(function (s) { return Object.assign({}, s, { label: name(s.label) }); }),
    next: next,
    highlights: titled(extra.highlights),
    changed: changed
  };
}

/* ---------------------------------------------------------------- generate */

var busy = false;
var lastKind = 'post';

// opts.scheduled: the scheduler's job id. The run is the same, but nothing is
// copied (this is a background tab, the clipboard is not ours to use) and the
// result goes to opts.onDone instead of to a reddit tab opened from here.
function generate(opts) {
  opts = opts || {};
  var kind = opts.kind || lastKind;
  var done = opts.onDone || function () {};
  lastKind = kind;
  if (busy) return done({ ok: false, error: 'a thread is already being generated in this tab' });
  busy = true;
  if (!panel) buildPanel();
  panel.classList.add('pmt-open');
  var titleLabel = panel.querySelector('.pmt-title-label');
  if (titleLabel) {
    titleLabel.textContent = kind === 'live' ? 'Live Match Discussion Thread'
      : opts.scheduled ? 'Post-Match Thread (scheduled)' : 'Post-Match Thread';
  }
  PMTLog.start(location.href);
  if (opts.scheduled) PMTLog.info('scheduled run', { job: opts.scheduled });
  status('Reading match page…');

  var d;
  try {
    d = scrapeMatch(document, location.href);
  } catch (e) {
    PMTLog.error('scrapeMatch threw', e);
    busy = false;
    PMTLog.save();
    status('Could not read the match page: ' + e.message, true);
    return done({ ok: false, error: 'could not read the match page: ' + e.message });
  }
  PMTLog.info('match page parsed', {
    kind: kind,
    live: d.live,
    teams: d.teams.map(function (t) { return t.name + ' (' + t.flag + ') ' + t.score; }),
    event: d.event.name, eventUrl: d.event.url, prize: d.prize, venue: d.format.venue,
    stage: d.format.stage, veto: d.veto.length,
    maps: d.maps.map(function (m) {
      return m.name + ' [' + m.status + ']' +
        (m.status === 'finished' ? ' ' + m.score.join('-') + (m.hasOt ? ' OT' : '') : '');
    }),
    statsAll: !!d.statsAll, vrs: !!d.vrs, hltvStreams: (d.hltvStreams || []).length,
    roles: d.roles, highlights: d.highlights.length,
    lineups: (d.lineups || []).map(function (g) {
      return (g || []).map(function (p) { return p.nick + (p.rating ? ' ' + p.rating : ''); });
    })
  });
  if (!d.teams[0] || !d.teams[0].name) {
    busy = false;
    PMTLog.save();
    status('This does not look like a match page.', true);
    return done({ ok: false, error: 'this does not look like a match page' });
  }

  var hlBox = document.getElementById('pmt-hl');
  var highlights = null;
  if (kind !== 'live') {
    if (!hlBox.value && d.highlights.length) {
      hlBox.value = d.highlights.map(function (h) { return h.title + ' | ' + h.url; }).join('\n');
      hlBox.dataset.pristine = hlBox.value;
    }
    // While the box is untouched HLTV's own text is used verbatim; a round-trip
    // through the textarea would normalise away its double and trailing spaces.
    highlights = hlBox.value === hlBox.dataset.pristine ? null : parseHighlights(hlBox.value);
  }

  var overrides = {
    event: document.getElementById('pmt-lp-event').value.trim(),
    t1: document.getElementById('pmt-lp-t1').value.trim(),
    t2: document.getElementById('pmt-lp-t2').value.trim()
  };

  // An empty box only means "forget this one" when the panel had already filled
  // it in - on the first run they are all empty because nothing has run yet.
  var forget = {
    event: !!opts.fromPanel && !overrides.event,
    t1: !!opts.fromPanel && !overrides.t1,
    t2: !!opts.fromPanel && !overrides.t2
  };

  var notes = [];
  var result = null;   // what opts.onDone is handed at the end
  var soft = function (label) {
    return function (e) {
      PMTLog.error(label, e);
      notes.push(label + ' (' + (e.message || e) + ')');
      return null;
    };
  };

  status('Fetching event, Liquipedia and overtime details…');

  var eventPage = d.event.url
    ? fetchDoc(d.event.url, 'hltv event').then(function (r) {
        var ev = readEventPage(r.doc);
        PMTLog.info('hltv event parsed', {
          setting: ev.setting, teamsInDirectory: Object.keys(ev.directory).length
        });
        if (!ev.setting) PMTLog.warn('hltv event page had no td.location - Setting line will be omitted');
        return ev;
      }).catch(soft('HLTV event page'))
    : Promise.resolve(null);

  var lpEvent = liquipediaUrlFor('event', d.event.url, d.event.name, overrides.event, forget.event)
    .then(function (url) {
      if (!url) { notes.push('no Liquipedia event page found'); return null; }
      return fetchDoc(url, 'liquipedia event').then(function (r) {
        var kind = liquipediaPageKind(r.doc);
        // an event that resolved to a team page would put that team's streams
        // and a bracket that is not this one into the thread; as with teams,
        // the page has to prove what it is rather than just fail to look wrong
        if (kind !== 'tournament') {
          PMTLog.warn('liquipedia event page is not a tournament page', {
            url: url, kind: kind, title: lpPageTitle(r.doc), categories: pageCategories(r.doc).slice(0, 6)
          });
          notes.push('Liquipedia event link was ' + describeKind(kind) +
                     ' (' + (lpPageTitle(r.doc) || url) + '), ignored');
          return cacheForget(liquipediaCacheKey('event', d.event.url)).then(function () { return null; });
        }
        return { url: url, doc: r.doc };
      });
    }).catch(soft('Liquipedia event'));

  var lpTeams = [0, 1].map(function (i) {
    var name = d.teams[i].name;
    return liquipediaUrlFor('team', d.teams[i].urlPlain, name, overrides[i ? 't2' : 't1'],
                            forget[i ? 't2' : 't1'])
      .then(function (url) {
        if (!url) {
          notes.push('no Liquipedia page for ' + name);
          return null;
        }
        return fetchDoc(url, 'liquipedia team ' + name).then(function (r) {
          /*
           * Is this actually a team? A tournament page has an infobox with a
           * name and socials in it, so it parses cleanly into a team that never
           * existed - `Bebop` once came back as European Pro League Series 6
           * Play-In, and the thread listed the tournament's Twitter as the
           * team's. Better to print the HLTV name alone and say why.
           *
           * The page has to *prove* it is a team, rather than merely fail to
           * look like something else. Letting an unrecognised page through was
           * the more cautious-sounding rule and the wrong one: it let
           * `/counterstrike/Qualifier_Tournaments`, an index page with no
           * infobox and no roster on it, print as a team called "Qualifier
           * Tournaments". Nothing is lost by insisting - a page carrying
           * neither a team infobox nor a squad table has nothing to contribute
           * anyway, so rejecting it costs exactly the name it would have got
           * wrong.
           */
          var kind = liquipediaPageKind(r.doc);
          if (kind !== 'team') {
            PMTLog.warn('liquipedia page for ' + name + ' is not a team page', {
              url: url, kind: kind, title: lpPageTitle(r.doc),
              categories: pageCategories(r.doc).slice(0, 6)
            });
            notes.push('Liquipedia link for ' + name + ' was ' + describeKind(kind) +
                       ' (' + (lpPageTitle(r.doc) || url) + '), ignored');
            // do not remember it, or every future run repeats the mistake
            return cacheForget(liquipediaCacheKey('team', d.teams[i].urlPlain))
              .then(function () { return null; });
          }
          var parsed = parseTeamPage(r.doc, url);
          PMTLog.info('liquipedia team parsed ' + name, teamSummary(parsed));
          if (parsed.links.blocked.length) {
            PMTLog.info('links dropped for ' + name + ' - reddit autoremoves these', {
              dropped: parsed.links.blocked
            });
          }
          if (!parsed.roster.length) {
            PMTLog.warn('liquipedia team ' + name + ' has no roster', {
              url: url,
              squadTables: r.doc.querySelectorAll('.table2__table').length,
              infobox: !!r.doc.querySelector('.fo-nttax-infobox'),
              headings: Array.prototype.map.call(r.doc.querySelectorAll('h2,h3'), function (h) {
                return h.textContent.replace(/\s+/g, ' ').trim().slice(0, 24);
              }).slice(0, 12)
            });
            notes.push(name + ' roster empty');
          }
          return parsed;
        });
      }).catch(soft('Liquipedia ' + name));
  });

  var hltvTeamRoles = Promise.resolve(null);
  if (rolesMissing(d.roles)) {
    PMTLog.info('match page has no role pills - fetching HLTV team pages');
    hltvTeamRoles = Promise.all([0, 1].map(function (i) {
      var url = d.teams[i] && d.teams[i].urlPlain;
      if (!url) return Promise.resolve(null);
      return fetchDoc(url, 'hltv team ' + d.teams[i].name).then(function (r) {
        var roles = scrapeRoles(r.doc);
        PMTLog.info('hltv team roles ' + d.teams[i].name, {
          byId: roles.byId, byNick: roles.byNick,
          bodyshots: r.doc.querySelectorAll('.bodyshot-team a[href*="/player/"]').length
        });
        return roles;
      }).catch(soft('HLTV team page ' + d.teams[i].name));
    })).then(function (pair) {
      return mergeRoles(pair[0], pair[1]);
    });
  }

  // Only overtime maps need their stats page read. On a live page, only maps
  // that have actually finished can have overtime.
  var otMaps = d.maps.filter(function (m) {
    return m.hasOt && m.statsUrl && (kind === 'live' ? m.status === 'finished' : m.played);
  });
  PMTLog.info('overtime maps to fetch', otMaps.map(function (m) { return m.name; }));
  var overtimePages = Promise.all(otMaps.map(function (m) {
    return fetchDoc(m.statsUrl, 'mapstats ' + m.name)
      .then(function (r) {
        var ot = scrapeOvertimes(r.doc);
        PMTLog.info('overtime parsed ' + m.name, {
          periods: ot.length,
          rows: r.doc.querySelectorAll('.round-history-team-row').length,
          detail: ot.map(function (pair) {
            return pair.map(function (x) {
              return x.team + ' ' + x.halves.map(function (h) { return h.side + ':' + h.rounds; }).join('/');
            });
          })
        });
        if (!ot.length) notes.push('no overtime rows for ' + m.name);
        return { id: m.mapstatsId, ot: ot };
      })
      .catch(soft('overtime for ' + m.name));
  }));

  Promise.all([getSettings(), eventPage, lpEvent, lpTeams[0], lpTeams[1], overtimePages, hltvTeamRoles])
    .then(function (r) {
      var settings = r[0], ev = r[1], lpe = r[2], lp1 = r[3], lp2 = r[4], ots = r[5];
      if (r[6]) {
        d.roles = mergeRoles(d.roles, r[6]);
        PMTLog.info('roles after HLTV team pages', d.roles);
        if (rolesMissing(d.roles)) notes.push('no IGL/AWP pills on HLTV team pages');
      }

      var overtimes = {};
      (ots || []).forEach(function (o) {
        if (!o || !o.ot.length) return;
        // put the rows in page order: row 0 must be team 1
        overtimes[o.id] = o.ot.map(function (pair) {
          return pair[0].team && pair[0].team.toLowerCase() === d.teams[1].name.toLowerCase()
            ? [pair[1], pair[0]] : pair;
        });
      });

      var next = null;
      if (kind !== 'live' && lpe) {
        var names = [[d.teams[0].name, lp1 && lp1.name], [d.teams[1].name, lp2 && lp2.name]];
        var scores = [String(d.teams[0].score), String(d.teams[1].score)];
        next = nextRound(lpe.doc, names, scores);
        PMTLog.info('bracket lookup', {
          searchedFor: names, scores: scores, brackets: lpe.doc.querySelectorAll('.brkts-bracket').length,
          matches: lpe.doc.querySelectorAll('.brkts-match').length, result: next
        });
      }

      var directory = mergeDirectory(ev && ev.directory, readTeamDirectory(document));
      PMTLog.info('team directory', {
        eventPage: ev ? Object.keys(ev.directory).length : 0,
        withMatchPage: Object.keys(directory).length
      });

      var tagOpponents = function (list) {
        return (list || []).map(function (name) {
          var opp = lookupTeam(directory, name);
          var namesForTag = [name];
          if (opp) namesForTag.push(opp.name);
          // logo from the flair table (any spelling), flag from HLTV when we have it
          var tag = teamTag(namesForTag, opp && opp.flag, settings.logoOverrides);
          if (tag) {
            if (opp && opp.name !== name) {
              PMTLog.info('next opponent matched under a different name',
                { liquipedia: name, hltv: opp.name });
            }
          } else {
            PMTLog.warn('next opponent has no flag or logo flair', { opponent: name });
          }
          return { name: name, tag: tag };
        });
      };
      if (next && next.advance) next.advance.opponents = tagOpponents(next.advance.opponents);
      if (next && next.drop) next.drop.opponents = tagOpponents(next.drop.opponents);

      var streams = lpe ? parseStreams(lpe.doc) : [];
      if (kind === 'live' && !streams.length) {
        streams = pickHltvStreams(d.hltvStreams);
        if (streams.length) {
          PMTLog.info('using HLTV match streams - Liquipedia had none', {
            n: streams.length, labels: streams.map(function (s) { return s.label; })
          });
        }
      }

      PMTLog.info('liquipedia summary', {
        event: lpe && lpe.url,
        streams: streams.length,
        team1: teamSummary(lp1), team2: teamSummary(lp2)
      });
      if (!lp1 || !lp2) {
        PMTLog.warn('team information will be incomplete', { team1: !!lp1, team2: !!lp2 });
      }

      document.getElementById('pmt-lp-event').value = (lpe && lpe.url) || '';
      document.getElementById('pmt-lp-t1').value = (lp1 && lp1.url) || '';
      document.getElementById('pmt-lp-t2').value = (lp2 && lp2.url) || '';

      // Gambling brands out, as late as possible: everything above (the
      // bracket, the overtime rows, the flag directory) matches on the real
      // names. The thread gets a censored copy; see censor.js.
      var clean = censorForThread(d, { lp: [lp1, lp2], lpe: lpe, streams: streams, next: next,
                                       highlights: highlights });
      if (clean.changed.length) {
        PMTLog.info('gambling brands kept out of the thread', { changed: clean.changed });
      }

      var out = buildThread(clean.d, {
        kind: kind,
        lp: clean.lp,
        lpEventUrl: clean.lpEventUrl,
        streams: clean.streams,
        next: clean.next,
        setting: ev && ev.setting,
        overtimes: overtimes,
        highlights: clean.highlights,
        logoOverrides: settings.logoOverrides
      });

      // whatever the rules missed: say so, rather than let the filter find it
      var gamblingLeft = gamblingTermsIn(out.title + '\n' + out.body);
      if (gamblingLeft.length) {
        PMTLog.warn('the thread still names a gambling brand', { terms: gamblingLeft });
        notes.push('still names a gambling brand (' + gamblingLeft.join(', ') + ') - edit it out before posting');
      }

      document.getElementById('pmt-title').value = out.title;
      document.getElementById('pmt-body').value = out.body;
      if (kind !== 'live' && !next) notes.push('no bracket entry - "advances to" line omitted');
      PMTLog.info('rendered', { titleLength: out.title.length, bodyLength: out.body.length, notes: notes });
      result = { ok: true, title: out.title, body: out.body, notes: notes, gamblingLeft: gamblingLeft };

      if (opts.scheduled) {
        status('Built for the scheduled post - handing it to reddit.' +
               (notes.length ? ' Missing: ' + notes.join('; ') + '.' : ''));
        return;
      }
      return copyText(out.body)
        .then(function () { return 'Body copied.'; })
        .catch(function () { return 'Copy blocked - use the Copy body button.'; })
        .then(function (msg) {
          status(msg + (notes.length ? ' Missing: ' + notes.join('; ') + '.' : ''),
                 /blocked/.test(msg));
          if (settings.autoOpen && !opts.noOpen) {
            chrome.runtime.sendMessage({
              type: 'openTab',
              url: submitUrl(out.title, settings.subreddit, settings.flair)
            });
          }
        });
    })
    .catch(function (e) {
      PMTLog.error('generate failed', e);
      status('Failed: ' + (e.message || e), true);
      result = { ok: false, error: String(e.message || e) };
    })
    .then(function () {
      busy = false;
      PMTLog.info('run finished', PMTLog.counts());
      PMTLog.save();
      refreshDiagnostics();
      done(result || { ok: false, error: 'the run ended without a thread' });
    });
}

/* ---------------------------------------------------------------- schedule */

// The worker owns the jobs (scheduler.js); this button only shows the latest
// one for this match, straight from storage, and follows it as it changes.
var JOBS_KEY = 'pmt:jobs';
var scheduleBtn = null;
var scheduledJob = null;

var SCHEDULE_LABELS = {
  watching: 'Scheduled - waiting for the match to end',
  generating: 'Scheduled - building the thread…',
  submitting: 'Scheduled - posting to reddit…',
  posted: 'Posted ✓ - open the thread',
  attention: 'Scheduled thread needs you',
  failed: 'Schedule failed - schedule again'
};

function matchIdHere() {
  return (location.pathname.match(/^\/matches\/(\d+)(?:\/|$)/) || [])[1] || '';
}

function latestJobHere(jobs) {
  var id = matchIdHere();
  var best = null;
  Object.keys(jobs || {}).forEach(function (k) {
    var j = jobs[k];
    if (j.matchId === id && (!best || j.createdAt > best.createdAt)) best = j;
  });
  return best;
}

function clockTime(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function paintScheduleButton() {
  if (!scheduleBtn) return;
  var j = scheduledJob;
  var state = j && j.state !== 'cancelled' ? j.state : '';
  scheduleBtn.textContent = SCHEDULE_LABELS[state] || 'Schedule Post-Match Thread';
  scheduleBtn.className = 'pmt-launch pmt-launch-schedule' + (state ? ' pmt-sched-' + state : '');
  var tip = 'Keep refreshing this match until it is over, then build and post the thread automatically';
  if (state === 'watching') {
    tip = (j.lastCheckAt ? 'Last checked ' + clockTime(j.lastCheckAt) +
           (j.lastSeen ? ' (' + j.lastSeen.phase + ')' : '') + '. ' : '') +
          (j.nextCheckAt ? 'Next check around ' + clockTime(j.nextCheckAt) + '. ' : '') +
          'Click to cancel.';
  } else if (state === 'generating' || state === 'submitting') {
    tip = 'Click to cancel.';
  } else if (state === 'posted') {
    tip = j.threadUrl || '';
  } else if (state === 'attention' || state === 'failed') {
    tip = j.error || '';
  }
  scheduleBtn.title = tip;
}

function onScheduleClick() {
  var j = scheduledJob;
  var state = j ? j.state : '';
  if (state === 'watching' || state === 'generating' || state === 'submitting') {
    if (!confirm('Cancel the scheduled post-match thread for this match?')) return;
    chrome.runtime.sendMessage({ type: 'scheduleCancel', jobId: j.id });
    return;
  }
  if (state === 'posted' || state === 'attention') {
    chrome.runtime.sendMessage({ type: 'scheduleFocus', jobId: j.id });
    return;
  }
  var label = document.title;
  try {
    var d = scrapeMatch(document, location.href);
    if (d.teams[0].name && d.teams[1].name) {
      label = d.teams[0].name + ' vs ' + d.teams[1].name + (d.event.name ? ' / ' + d.event.name : '');
    }
  } catch (e) { /* the worker relabels it on its first check anyway */ }
  chrome.runtime.sendMessage({ type: 'scheduleAdd', url: location.href, label: label }, function (res) {
    var err = chrome.runtime.lastError;
    if (err || !res || !res.ok) {
      alert('Could not schedule the thread: ' + ((res && res.error) || (err && err.message) || 'no reply'));
    }
  });
}

function loadScheduledJob() {
  chrome.storage.local.get([JOBS_KEY], function (v) {
    scheduledJob = latestJobHere(v && v[JOBS_KEY]);
    paintScheduleButton();
  });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes[JOBS_KEY]) return;
  scheduledJob = latestJobHere(changes[JOBS_KEY].newValue);
  paintScheduleButton();
});

/* -------------------------------------------------------------- entrypoint */

if (document.querySelector('.teamsBox') && !document.querySelector('.pmt-launch-stack')) {
  var stack = el('div', 'pmt-launch-stack');
  var liveBtn = el('button', 'pmt-launch pmt-launch-live', 'Live Match Discussion Thread');
  liveBtn.title = 'Generate the r/GlobalOffensive live match discussion thread';
  liveBtn.addEventListener('click', function () { generate({ kind: 'live' }); });
  scheduleBtn = el('button', 'pmt-launch pmt-launch-schedule', 'Schedule Post-Match Thread');
  scheduleBtn.addEventListener('click', onScheduleClick);
  var btn = el('button', 'pmt-launch', 'Post-Match Thread');
  btn.title = 'Generate the r/GlobalOffensive post-match thread';
  btn.addEventListener('click', function () { generate({ kind: 'post' }); });
  stack.appendChild(liveBtn);
  stack.appendChild(scheduleBtn);
  stack.appendChild(btn);
  document.body.appendChild(stack);
  paintScheduleButton();
  loadScheduledJob();
}

// The watch tab is hidden, and Chrome freezes hidden tabs - it froze one
// mid-build even outside the tab group, and a frozen tab runs nothing. Chrome
// leaves a page alone while it holds a Web Lock, so the scheduled build holds
// one, and lets go when it is done so an idle watch tab is frozen as usual.
// The scheduler's build timeout and retry stay as the backstop.
function holdAwake(name) {
  var done = false;
  var release = function () { done = true; };
  if (navigator.locks && navigator.locks.request) {
    navigator.locks.request(name, function () {
      if (done) return null;
      return new Promise(function (resolve) { release = resolve; });
    }).catch(function () {});
  }
  return { release: function () { done = true; release(); } };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;
  if (msg.type === 'generate') generate();
  if (msg.type === 'scheduledGenerate') {
    // answered straight away - the build takes a while, and its result comes
    // back as a message of its own, which keeps the worker awake for it
    if (busy) {
      sendResponse({ accepted: false, error: 'a thread is already being generated in this tab' });
      return false;
    }
    sendResponse({ accepted: true });
    var awake = holdAwake('pmt-build-' + msg.jobId);
    generate({
      kind: 'post',
      noOpen: true,
      scheduled: msg.jobId,
      onDone: function (res) {
        awake.release();
        chrome.runtime.sendMessage(Object.assign({ type: 'scheduledThread', jobId: msg.jobId }, res),
          function () { void chrome.runtime.lastError; });
      }
    });
  }
  return false;
});
