/*
 * reddit.js - runs on old.reddit's submit page and picks the post flair; for a
 * scheduled thread it also fills in the body and submits it.
 *
 * The flair name arrives in the URL hash (#pmt-flair=...) so it never reaches
 * the server or the submitted post's URL.
 *
 * Old reddit builds the flair control with its own JS after load, so this polls
 * until it appears. The known-good path is three clicks:
 *
 *   .flairselect-btn                                   open the picker
 *   .linkflair.linkflair-discussion.linkflair-esports  pick the flair
 *     > .linkflairlabel
 *   #newlink-flair-dropdown > form > button            apply it
 *
 * The steps after the first are fallbacks for when reddit's markup differs from
 * what this was written against. The apply step only ever clicks the configured
 * selector, and refuses if that button turns out to belong to the post's own
 * form - a stray click there would submit the thread before the body is pasted.
 *
 * Scheduled threads (scheduler.js) also carry `pmt-job=<id>` in the hash. The
 * title and body are asked of the service worker - the body is ~10 KB and has
 * no business in a URL. The flair goes on first and the body after it, so no
 * click made while flairing can ever send a half-built post; then the flair is
 * *read back* from the form's preview, because the subreddit removes an
 * unflaired thread and a flair that did not take is better caught here. Only
 * then is submit clicked, and only with the worker's go-ahead, which it hands
 * out once per job: a reload of this page can never post the thread twice.
 *
 * It stops short and leaves the tab to a person whenever a person is what is
 * needed - reddit showing a captcha (never touched), the flair not applying,
 * an error such as the rate limit after submit, or auto-submit switched off.
 *
 * Every step of a scheduled run is also reported to the worker, which writes it
 * into the job's log (Options -> Scheduled threads -> Log): a submit that did
 * not happen should say which step it stopped at.
 *
 * Old reddit is not only old.reddit.com - the same layout is served from
 * www.reddit.com too, and a tab opened on one can end up on the other. So this
 * runs on both, decides it is looking at old reddit from the markup (the
 * #newlink form) rather than the host, and does not count on the #pmt-job hash
 * surviving the hop: a submit page without one asks the worker whether its tab
 * is one opened for a scheduled thread.
 *
 * Reddit lands on the new thread after a successful submit, so on a /comments/
 * page reached from a submit page this only tells the worker where the tab
 * ended up. That is how a scheduled job learns it was posted.
 */

(function () {
  if (/\/comments\//.test(location.pathname)) {
    if (/\/submit\b/.test(document.referrer)) {
      chrome.runtime.sendMessage({ type: 'scheduledLanded', url: location.href.split('#')[0] },
        function () { void chrome.runtime.lastError; });
    }
    return;
  }

  var hash = {};
  location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i <= 0) return;
    try { hash[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* malformed */ }
  });
  var wanted = (hash['pmt-flair'] || '').trim();
  var jobId = hash['pmt-job'] || '';

  var DEFAULT_SELECTOR = '.linkflair.linkflair-discussion.linkflair-esports > .linkflairlabel';
  var DEFAULT_APPLY = '#newlink-flair-dropdown > form > button';
  var OPEN_SELECTOR = '.flairselect-btn';
  var TIMEOUT = 10000;

  var settings = { flairSelector: DEFAULT_SELECTOR, flairApplySelector: DEFAULT_APPLY };
  var started = Date.now();
  var opened = false;
  var done = false;
  var flairDone = function () {};
  var flairHow = '';

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  var target = norm(wanted);

  function visible(n) {
    return !!(n && (n.offsetParent || n.offsetHeight || n.getClientRects().length));
  }

  function click(n) {
    n.click();
    // some builds wire the choice to a radio rather than the label's click handler
    var li = n.closest && n.closest('li');
    var radio = li && li.querySelector('input[type=radio]');
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  var toasts = null;

  // sticky: a scheduled run stopped here and the tab is waiting for a person,
  // who may not look at it for a while
  function toast(msg, ok, sticky) {
    if (!toasts) {
      toasts = document.createElement('div');
      toasts.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;' +
        'flex-direction:column;gap:6px;align-items:flex-end;max-width:420px;';
      document.body.appendChild(toasts);
    }
    var n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText =
      'padding:8px 12px;border-radius:4px;font:600 12px/1.3 Arial,sans-serif;color:#fff;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.3);background:' + (ok ? '#2d7d46' : '#8a6d3b');
    toasts.appendChild(n);
    if (!sticky) setTimeout(function () { n.remove(); }, ok ? 3000 : 10000);
  }

  function finish(ok, how) {
    if (done) return;
    done = true;
    flairHow = how || '';
    if (ok) {
      toast('Flair set: ' + wanted, true);
      console.info('[PMT] flair applied via ' + how);
    } else {
      toast('Could not set the "' + wanted + '" flair - set it by hand.', false);
      console.warn('[PMT] no flair control matched on this submit page');
    }
    flairDone(ok);
  }

  /* --- strategies, in order of confidence --- */

  // 1. the exact selector for this subreddit's flair
  function bySelector() {
    if (!settings.flairSelector) return false;
    var n;
    try {
      n = document.querySelector(settings.flairSelector);
    } catch (e) {
      console.warn('[PMT] bad flair selector: ' + settings.flairSelector);
      settings.flairSelector = '';
      return false;
    }
    if (!n || !visible(n)) return false;
    click(n);
    return true;
  }

  // 2. a flair label whose text is the flair name
  function byLabelText() {
    var nodes = document.querySelectorAll('.linkflairlabel, [class*="flairlabel"]');
    for (var i = 0; i < nodes.length; i++) {
      if (norm(nodes[i].textContent) === target && visible(nodes[i])) {
        click(nodes[i]);
        return true;
      }
    }
    return false;
  }

  // 3. a plain <select> of flairs
  function bySelect() {
    var selects = document.querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) {
      for (var j = 0; j < selects[i].options.length; j++) {
        var opt = selects[i].options[j];
        if (norm(opt.textContent) !== target && norm(opt.value) !== target) continue;
        selects[i].value = opt.value;
        selects[i].dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // 4. anything flair-ish whose text is the flair name
  function byAnyText() {
    var scopes = document.querySelectorAll('[class*="flair"], [id*="flair"]');
    for (var i = 0; i < scopes.length; i++) {
      var nodes = scopes[i].querySelectorAll('a, li, span, label, div, button');
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (norm(n.textContent) !== target) continue;
        if (n.querySelector('a, li, span, label, div, button')) continue; // innermost only
        if (!visible(n)) continue;
        click(n);
        return true;
      }
    }
    return false;
  }

  function open() {
    var btn = document.querySelector(OPEN_SELECTOR);
    if (btn && visible(btn)) { btn.click(); return true; }
    var nodes = document.querySelectorAll('button, a, [class*="flair"]');
    for (var i = 0; i < nodes.length; i++) {
      var t = norm(nodes[i].textContent);
      if (t === 'flair' || t === 'add flair' || t === 'select flair' || t === 'choose a flair') {
        if (!visible(nodes[i])) continue;
        nodes[i].click();
        return true;
      }
    }
    return false;
  }

  // The dropdown needs its own apply/save click to commit the choice. Only the
  // configured selector is ever clicked, and never if it belongs to the post form.
  function apply() {
    if (!settings.flairApplySelector) return 'skipped';
    var btn;
    try {
      btn = document.querySelector(settings.flairApplySelector);
    } catch (e) {
      console.warn('[PMT] bad apply selector: ' + settings.flairApplySelector);
      return 'skipped';
    }
    if (!btn || !visible(btn)) return 'missing';
    var form = btn.closest('form');
    if (form && (form.id === 'newlink' ||
                 form.querySelector('input[name="title"], textarea[name="text"]'))) {
      console.warn('[PMT] refusing to click apply: it belongs to the post form');
      return 'refused';
    }
    btn.click();
    return 'clicked';
  }

  function selected(how) {
    setTimeout(function () {
      var r = apply();
      finish(true, how + (r === 'clicked' ? ' + apply' : ' (apply ' + r + ')'));
    }, 250);
  }

  function attempt() {
    if (done) return;
    if (!opened && open()) {
      opened = true;
      return setTimeout(attempt, 300); // let the picker render before looking in it
    }
    if (bySelector()) return selected('selector');
    if (byLabelText()) return selected('label text');
    if (bySelect()) return selected('select');
    if (byAnyText()) return selected('text match');
    if (Date.now() - started > TIMEOUT) return finish(false);
    setTimeout(attempt, 400);
  }

  // Resolves true once a flair has been picked (and applied, where there is an
  // apply button), false if nothing matched in time.
  function pickFlair() {
    return new Promise(function (resolve) {
      flairDone = resolve;
      chrome.storage.sync.get(
        { flairSelector: DEFAULT_SELECTOR, flairApplySelector: DEFAULT_APPLY },
        function (v) {
          if (v && typeof v.flairSelector === 'string') settings.flairSelector = v.flairSelector.trim();
          if (v && typeof v.flairApplySelector === 'string') settings.flairApplySelector = v.flairApplySelector.trim();
          started = Date.now();
          attempt();
        }
      );
    });
  }

  /* --- scheduled threads --- */

  // One line in the job's log. Fire-and-forget: a log line must never be what
  // holds a submit up.
  function trace(msg, data) {
    console.info('[PMT] scheduled submit: ' + msg, data === undefined ? '' : data);
    if (!jobId) return;
    chrome.runtime.sendMessage({ type: 'scheduledSubmitLog', jobId: jobId, msg: msg, data: data },
      function () { void chrome.runtime.lastError; });
  }

  // This tab opens in the background and Chrome freezes hidden tabs; a frozen
  // page runs nothing, flair clicks and submit included. Chrome leaves a page
  // alone while it holds a Web Lock, so a scheduled submit page holds one for
  // as long as it is open - through to posting, or for as long as it sits
  // waiting on a person. Navigating to the new thread lets it go.
  function keepAwake() {
    if (!navigator.locks || !navigator.locks.request) return;
    navigator.locks.request('pmt-submit-' + jobId, function () {
      return new Promise(function () {});
    }).catch(function () {});
  }

  // Where this page is, without the query (the title is in it).
  function pageInfo() {
    return {
      url: location.origin + location.pathname,
      hashKept: !!hash['pmt-job'],
      oldLayout: !!document.getElementById('newlink'),
      loggedIn: !!document.querySelector('body.loggedin')
    };
  }

  // What the flair step could see, for when it did not work.
  function flairScene() {
    var sel = null;
    try { sel = settings.flairSelector && document.querySelector(settings.flairSelector); } catch (e) { sel = null; }
    return {
      openButton: !!document.querySelector(OPEN_SELECTOR),
      openedPicker: opened,
      dropdown: !!document.getElementById('newlink-flair-dropdown'),
      labels: document.querySelectorAll('.linkflairlabel').length,
      selectorHit: !!sel,
      selectorVisible: !!(sel && visible(sel)),
      applyButton: !!document.querySelector(settings.flairApplySelector || DEFAULT_APPLY),
      preview: flairOnForm()
    };
  }

  function ask(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: 'no reply from the extension' });
      });
    });
  }

  function waitFor(find, ms) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function look() {
        var hit = find();
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return resolve(null);
        setTimeout(look, 300);
      })();
    });
  }

  function postForm() {
    var form = document.getElementById('newlink');
    if (!form) return null;
    var f = {
      form: form,
      title: form.querySelector('textarea[name="title"]'),
      text: form.querySelector('textarea[name="text"]'),
      sr: form.querySelector('input[name="sr"]'),
      submit: form.querySelector('button[name="submit"][type="submit"]')
    };
    return f.title && f.text && f.submit ? f : null;
  }

  function fill(field, value) {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // What the form will actually post with: the preview under "choose a flair".
  function flairOnForm() {
    var preview = document.querySelector('#flair-field .flair-preview');
    return norm(preview && preview.textContent);
  }

  function flairStuck() {
    var p = flairOnForm();
    return p === target || p.indexOf(target) >= 0;
  }

  // The form carries an empty .g-recaptcha slot for everyone; reddit only
  // renders a widget into it for accounts it wants to check.
  function captchaShown() {
    var frames = document.querySelectorAll('.g-recaptcha iframe, iframe[src*="recaptcha"][src*="bframe"]');
    return Array.prototype.some.call(frames, function (f) { return visible(f) && f.offsetHeight > 30; });
  }

  function visibleErrors(f) {
    var out = [];
    Array.prototype.forEach.call(f.form.querySelectorAll('.error'), function (e) {
      var t = e.textContent.replace(/\s+/g, ' ').trim();
      if (t && visible(e)) out.push(t);
    });
    return out;
  }

  var STOP_TOASTS = {
    ready: 'Scheduled thread is ready - review it and press submit.',
    held: 'Scheduled thread held: it still names a gambling brand - edit that out, then press submit.',
    captcha: 'reddit wants a captcha for this post - solve it and press submit.'
  };

  // `scene`: what the page looked like, for the job log
  function stop(reason, error, scene) {
    toast(STOP_TOASTS[reason] || 'Scheduled thread stopped: ' + error, reason === 'ready', true);
    console.warn('[PMT] scheduled submit stopped (' + reason + '): ' + error);
    if (scene) trace('stopping: ' + reason, scene);
    return ask({ type: 'scheduledSubmitResult', jobId: jobId, reason: reason, error: error });
  }

  // After the click reddit either navigates to the new thread - which ends this
  // script - or shows an error in the form. Errors already on screen before the
  // click are not reddit's answer to it.
  function watchOutcome(f, before) {
    var t0 = Date.now();
    (function poll() {
      var fresh = visibleErrors(f).filter(function (t) { return before.indexOf(t) < 0; });
      if (fresh.length) return stop('reddit-error', 'reddit said: ' + fresh.join(' / '));
      if (captchaShown()) return stop('captcha', 'reddit asked for a captcha on submit - solve it and press submit');
      if (Date.now() - t0 > 90000) return stop('timeout', 'reddit had not answered 90 seconds after submit');
      setTimeout(poll, 500);
    })();
  }

  // No form to fill: say which of the usual reasons it is.
  function noFormReason() {
    var info = pageInfo();
    if (info.oldLayout) return 'the submit form is missing its title, text or submit field';
    if (document.querySelector('shreddit-app, faceplate-app, shreddit-composer, #AppRouter-main-content')) {
      return 'this is reddit\'s new design, not the old submit form (' + info.url + ')';
    }
    if (/\/login/.test(location.pathname)) return 'reddit sent this tab to its login page';
    return 'no old-reddit submit form on ' + info.url;
  }

  function runScheduled(prefetched) {
    var got = prefetched ? Promise.resolve(prefetched)
      : ask({ type: 'scheduledJobForSubmit', jobId: jobId, page: pageInfo() });
    got.then(function (job) {
      if (!job.ok) {
        toast('Scheduled thread: ' + job.error, false, true);
        return;
      }
      jobId = job.id || jobId;
      keepAwake();
      trace('page loaded', pageInfo());
      if (job.clicked) {
        // the one go-ahead was spent on an earlier load of this page
        trace('submit was already clicked for this thread - not clicking again');
        toast('This scheduled thread was already submitted once - not submitting it again.', false, true);
        return;
      }
      wanted = job.flair;
      target = norm(wanted);
      return waitFor(postForm, 20000).then(function (f) {
        if (!f) return stop('no-form', noFormReason(), pageInfo());
        trace('form found', { subreddit: f.sr ? f.sr.value : null, textBoxVisible: visible(f.text) });
        if (f.sr && norm(f.sr.value) !== norm(job.subreddit)) {
          return stop('wrong-subreddit', 'the form would post to r/' + f.sr.value + ', not r/' + job.subreddit);
        }
        if (!visible(f.text)) {
          var textTab = f.form.querySelector('.text-button');
          if (textTab) textTab.click();
        }
        // every stop() below ends its branch - nothing after one may run on
        trace('picking the flair', { wanted: wanted });
        return pickFlair().then(function (picked) {
          if (!picked) return stop('flair', 'the "' + wanted + '" flair could not be selected', flairScene());
          trace('flair picked', { how: flairHow });
          return waitFor(flairStuck, 8000).then(function (stuck) {
            if (!stuck) {
              return stop('flair', 'the flair did not stick - the form shows "' + (flairOnForm() || 'none') + '"',
                          flairScene());
            }
            trace('flair is on the form', { preview: flairOnForm() });
            return fillAndSubmit(f, job);
          });
        });
      });
    });
  }


  function disableInboxReplies(form) {
    const checkbox = form.querySelector(
      'input[type="checkbox"][name="sendreplies"]'
    );

    if (!checkbox) return false;

    if (checkbox.checked) checkbox.click();

    return !checkbox.checked;
  }


  function fillAndSubmit(f, job) {
    if (!disableInboxReplies(f.form)) {
    return stop(
      'reply-setting',
      'Could not disable inbox replies'
    );
  }
    fill(f.title, job.title);
    fill(f.text, job.body);
    if (f.title.value !== job.title || f.text.value !== job.body) {
      return stop('changed', 'the title or body did not fill in as built',
                  { titleLength: f.title.value.length, bodyLength: f.text.value.length });
    }
    trace('title and body filled in', { titleLength: job.title.length, bodyLength: job.body.length });
    if (captchaShown()) return stop('captcha', 'reddit wants a captcha - solve it and press submit');
    if (job.holdReason) return stop('held', 'ready for review - ' + job.holdReason);
    if (!job.autoSubmit) return stop('ready', 'ready for review - press submit (auto-submit is off)');
    return ask({ type: 'scheduledSubmitClicking', jobId: jobId }).then(function (r) {
      if (!r.go) {
        trace('no go-ahead - already submitted or cancelled');
        toast('Not submitting - this scheduled thread was already submitted or cancelled.', false, true);
        return;
      }
      var before = visibleErrors(f);
      f.submit.click();
      trace('clicked submit', before.length ? { errorsAlreadyShowing: before } : undefined);
      toast('Submitting the scheduled thread…', true);
      watchOutcome(f, before);
    });
  }

  function begin() {
    if (jobId) return runScheduled();
    // No job id in the URL: a manual run, or a tab opened for a scheduled
    // thread whose hash was lost on the way here. The worker knows which tabs
    // it opened, so ask before treating it as manual.
    ask({ type: 'scheduledJobForSubmit', jobId: null, page: pageInfo() }).then(function (job) {
      if (job.ok) return runScheduled(job);
      if (!wanted) return;
      // the fallbacks in attempt() are written for old reddit's markup and have
      // no business clicking about in anything else
      if (!document.getElementById('newlink')) {
        console.info('[PMT] not the old reddit submit form - flair left alone');
        return;
      }
      
      waitFor(function () {
        return document.querySelector(
          '#newlink input[type="checkbox"][name="sendreplies"]'
        );
      }, 10000).then(function (checkbox) {
        if (checkbox && checkbox.checked) checkbox.click();
      });

      pickFlair();

    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(begin, 400); });
  } else {
    setTimeout(begin, 400);
  }
})();
