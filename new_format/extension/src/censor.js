/*
 * censor.js - gambling brands kept out of the thread.
 *
 * r/GlobalOffensive's automatic filters remove a post that names a gambling
 * brand, and several teams carry one: sponsored in (Betclic Apogee, BC.Game,
 * BET-M 33) or owned outright (BetBoom Team, PARIVISION - the PARI
 * bookmaker's - 1win, SportsBetExpert). So does the odd event (Stake Ranked).
 *
 * The replacements are what these teams are already called wherever betting
 * brands are not allowed: the Esports World Cup runs PVISION and BB Team,
 * Liquipedia itself lists 1win as "1w Team" and BET-M 33 as "33", and
 * SportsBetExpert is SBE to everyone. Checked by hand against the Valve
 * ranking's top 150 (the 25 August and 2 October 2026 snapshots): those seven
 * are the only gambling-branded teams in it.
 *
 * The name is the visible part; the links are the rest.
 *   - A team's own social links are dropped when they carry the brand
 *     (twitter.com/BCGameEsports, betclicapogee.gg). The ones that do not - a
 *     FACEIT id, a YouTube channel id, team33_official - stay.
 *   - HLTV finds a page by its id and ignores the slug - /matches, /team,
 *     /events and /stats/matches/mapstatsid all redirect <id>/<anything> to the
 *     right page - so a branded slug is rewritten by the same rules.
 *   - Liquipedia addresses a page by its name, so a branded link is replaced by
 *     the page's id (index.php?curid=<id>), which opens the same article.
 *   - A subreddit flair anchor carrying the brand (#betboom-logo) is not used;
 *     the team gets its country flag, like any team without a flair.
 *
 * Whatever slips past is caught at the end: the finished title and body are
 * scanned (gamblingTermsIn) and anything found is named in the run log and the
 * panel, and a scheduled thread is held for review instead of auto-posted.
 */

// Rewrites, applied in order - longer forms before the brand on its own. They
// run on names only (teams, events, stages, stream labels, highlight titles),
// never on free text.
var GAMBLING_NAME_RULES = [
  [/\bBetclic\s+Apogee\b/gi, 'Apogee'],        // Liquipedia "Betclic Apogee Esports" -> Apogee Esports
  [/\bBetclic\b/gi, 'Apogee'],                 // HLTV "Betclic"
  [/\bBC\s?\.?\s?Game\b/gi, 'BCG'],            // "BC.Game Esports" -> BCG Esports; slug "bcgame"
  [/\bBET[-\s]?M\s+33\b/gi, '33'],             // Liquipedia's old "BET-M 33"
  [/\bBET[-\s]?M\b/gi, '33'],                  // HLTV "BET-M"
  [/\bPARIVISION\b/gi, 'VISION'],             // as at the Esports World Cup
  [/\bBetBoom\b/gi, 'BB'],                     // "BetBoom Team" -> BB Team (EWC); HLTV "BETBOOM" -> BB
  [/\b1win\b/gi, '1W'],                        // Liquipedia: "1w Team"
  [/\bSportsBetExpert\b/gi, 'SBE'],
  // event sponsors
  [/\bStake\s+Ranked\b/gi, 'StarLadder Ranked'],   // StarLadder's series, billed "StarLadder Stake Ranked"
  [/\bStake\s+Pulse\b/gi, 'BME Pulse'],            // Black Molly Entertainment's Stake Pulse Beat series
  [/\bThunderpick\b/gi, 'TP'],                     // Thunderpick World Championship
  [/\bParimatch\b/gi, 'PM']                        // Parimatch League
];

// Every brand the scan and the link filter know - the ones above plus the
// betting and skin-gambling names that sponsor Counter-Strike. Short or
// ordinary-looking words carry boundaries, so "mistakes", "paris" and
// "alphabet-m" do not count; the long distinctive ones match anywhere, which
// is what catches BCGameEsports or betclicapogee.gg.
var GAMBLING_TERMS =
  /bc\s?[.\-]?\s?game|betboom|parivision|betclic|sportsbetexpert|thunderpick|parimatch|1xbet|betway|winline|betera|fonbet|melbet|mostbet|bet365|roobet|rainbet|gamdom|csgoroll|csgoempire|hellcase|key-?drop|skin\.?club|duelbits|(?<![a-z0-9])(?:1win|onewin|stake|pari|gg\.?bet|pinnacle|bet[-\s]?m)(?![a-z])/gi;

function censorName(text) {
  var out = String(text == null ? '' : text);
  GAMBLING_NAME_RULES.forEach(function (rule) { out = out.replace(rule[0], rule[1]); });
  return out;
}

// Every distinct brand left in `text`, as written there.
function gamblingTermsIn(text) {
  var found = [];
  String(text || '').replace(GAMBLING_TERMS, function (m) {
    if (found.indexOf(m) < 0) found.push(m);
    return m;
  });
  return found;
}

function hasGamblingTerm(text) {
  return gamblingTermsIn(text).length > 0;
}

// A social or stream link that names a brand anywhere - host, handle, path.
function isGamblingLink(url) {
  return hasGamblingTerm(url);
}

// An HLTV slug ("bcgame-vs-faze-stake-ranked-episode-4") put through the name
// rules with its hyphens read as spaces, then put back the way HLTV writes one.
function censorSlug(slug) {
  var censored = censorName(String(slug).replace(/-/g, ' '));
  return censored.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

// HLTV: same page, rewritten slug. Liquipedia: the page's id when it is known
// (`liquipediaId`). Anything else is returned as it is - a social or stream
// link that names a brand is dropped by isGamblingLink, not rewritten.
function censorUrl(url, liquipediaId) {
  if (!url || !hasGamblingTerm(url)) return url;
  var u;
  try { u = new URL(url); } catch (e) { return url; }
  if (/(^|\.)hltv\.org$/i.test(u.hostname)) {
    u.pathname = u.pathname.split('/').map(function (seg) {
      return !seg || /^\d+$/.test(seg) || !hasGamblingTerm(seg) ? seg : censorSlug(seg);
    }).join('/');
    return u.toString();
  }
  if (/(^|\.)liquipedia\.net$/i.test(u.hostname) && liquipediaId) {
    var wiki = (u.pathname.split('/')[1] || 'counterstrike');
    return 'https://liquipedia.net/' + wiki + '/index.php?curid=' + liquipediaId;
  }
  return url;
}

// The page id MediaWiki puts in every page's config block - what a
// Liquipedia link can use instead of the page's (branded) name.
function liquipediaArticleId(doc) {
  if (!doc) return '';
  var scripts = doc.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) {
    var m = /"wgArticleId":\s*(\d+)/.exec(scripts[i].textContent || '');
    if (m && m[1] !== '0') return m[1];
  }
  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    censorName: censorName, gamblingTermsIn: gamblingTermsIn, hasGamblingTerm: hasGamblingTerm,
    isGamblingLink: isGamblingLink, censorSlug: censorSlug, censorUrl: censorUrl,
    liquipediaArticleId: liquipediaArticleId, GAMBLING_NAME_RULES: GAMBLING_NAME_RULES
  };
}
