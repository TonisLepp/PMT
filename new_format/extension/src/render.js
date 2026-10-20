/*
 * render.js - the new post-match thread format.
 *
 * Built against new_format/SampleBody.md for post-match threads. Live match
 * discussion reuses the same blocks (event, teams, veto, finished-map stats)
 * and drops the finished-match-only sections: VRS, "advances to", highlights.
 * Whitespace is deliberate: reddit needs a trailing double space for a hard
 * line break, so the "  \n" literals and the bare "&nbsp;" spacer lines are
 * reproduced exactly as the sample has them.
 *
 * Three defects in that sample are deliberately NOT reproduced:
 *   - a stray "NaN" after Spirit's last infobox link
 *   - highlight titles keeping their parenthesised asides
 *   - the AWP marker, which is U+2295 and not the sample's U+1698F
 */

var ROLE_IGL = '♛';   // ♛
var ROLE_AWP = '⊕';   // ⊕
var FOOTER =           // Footer for the Post-Match Thread - Provides PMT links and encourages new members to join
  '**This thread was created by the Post-Match Team.**  \n' +
  '[**PMT Discord**](https://discord.gg/X6Pn2jbmJc) | ' + // PMT Discord invite link
  '[**PMT Creator**](https://postmatchteam.uk) | ' + // Could eventually be replaced by a link to download the extension once that is publicly and easily available - though it's possible we may also want to keep the extension more private
  '[**PMT Archive**](https://docs.google.com/spreadsheets/d/1k5TiV7VuDKLa41MfcDgP1XiBkPvAo_HInRmNlKKEIBM/edit?usp=sharing)  \n' + // Archive of previous match threads. Once password protection is added to main schedule, that should also be linked
  'The PMT is always looking for help! If you\'d want to help contribute, message u/Undercover-Cactus on Reddit, or join the Discord (encouraged but not required).  ';

var ROLE_SYMBOL = { igl: ROLE_IGL, awp: ROLE_AWP };

// A player can hold several roles at once, so every marker is rendered.
function roleMark(nick, roles, id) {
  var marks = rolesFor(roles, nick, id)
    .map(function (r) { return ROLE_SYMBOL[r]; })
    .filter(Boolean);
  return marks.length ? ' ' + marks.join(' ') : '';
}

function mean2(values) {
  if (!values.length) return '';
  var sum = values.reduce(function (a, b) { return a + b; }, 0);
  return (sum / values.length).toFixed(2);
}

/* ------------------------------------------------------------------ pieces */

function makeCtx(d, extra) {
  extra = extra || {};
  var ctx = {
    lp: extra.lp || [null, null],
    lpEventUrl: extra.lpEventUrl || '',
    streams: extra.streams || [],
    next: extra.next || null,
    setting: extra.setting || null,
    overtimes: extra.overtimes || {},
    highlights: extra.highlights || null,
    flagLink: function (code) { return flagLink(code); },
    anchor: function (i) { return teamAnchor(d.teams[i].name, d.teams[i].flag, extra.logoOverrides); },
    teamTag: function (i) {
      return '[' + flagEmoji(d.teams[i].flag) + '](' +
        teamAnchor(d.teams[i].name, d.teams[i].flag, extra.logoOverrides) + ')';
    },
    // the header and team blocks use Liquipedia's full name; the tables use HLTV's short one
    lpName: function (i) { return (ctx.lp[i] && ctx.lp[i].name) || d.teams[i].name; }
  };
  return ctx;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function formatUtc(ms) {
  if (!ms) return '';
  var t = new Date(ms);
  if (isNaN(t.getTime())) return '';
  return pad2(t.getUTCHours()) + ':' + pad2(t.getUTCMinutes()) + ' UTC';
}

function headerBlock(d, ctx) {
  var t1 = d.teams[0], t2 = d.teams[1];
  var lines = [
    '#' + ctx.lpName(0) + ' ' + ctx.teamTag(0) + ' ' +
    '[' + t1.score + '-' + t2.score + '](' + d.matchUrl + ') ' +
    ctx.teamTag(1) + ' ' + ctx.lpName(1) + '  ',
    ''
  ];
  d.maps.forEach(function (m) {
    lines.push(m.played
      ? '**' + m.name + ':** ' + m.score[0] + '-' + m.score[1] + '  '
      : '**~~' + m.name + '~~**  ');
  });
  return lines.join('\n');
}

function formatOpponents(list) {
  return (list || []).map(function (o) {
    if (typeof o === 'string') return o;
    return (o.tag ? o.tag + ' ' : '') + o.name;
  }).join(' or ');
}

function resultLine(tag, name, verb, dest, opponents) {
  var face = formatOpponents(opponents);
  return '**' + tag + ' ' + name + ' ' + verb + ' ' + dest +
    (face ? ' and will face ' + face : '') + '**  ';
}

// "MOUZ advance to Upper Final and will face Legacy or Team Falcons"
function advanceLine(d, ctx) {
  var next = ctx.next;
  if (!next) return '';
  var wi = d.teams[0].won ? 0 : 1;
  var li = 1 - wi;
  var lines = [];
  if (next.advance && next.advance.round) {
    lines.push(resultLine(ctx.teamTag(wi), ctx.lpName(wi), 'advance to',
      next.advance.round, next.advance.opponents));
  }
  if (next.drop && next.drop.dest) {
    lines.push(resultLine(ctx.teamTag(li), ctx.lpName(li), 'drop to',
      next.drop.dest, next.drop.opponents));
  }
  return lines.join('\n\n');
}

function vrsBlock(d, ctx) {
  if (!d.vrs) return '';
  var lines = [
    '### Predicted VRS Impact  ',
    '  ',
    'Team | Rank | Diff | Total  ',
    ':--|:--:|:--:|:--:  '
  ];
  d.vrs.forEach(function (row, i) {
    var diff = (row.diff >= 0 ? '+' : '') + row.diff + ' pts';
    lines.push(ctx.teamTag(i) + ' **' + d.teams[i].name + '** | ' +
      row.beforeRank + ' → ' + row.afterRank + ' | ' + diff + ' | ' + row.total + ' pts |  ');
  });
  lines.push('  ');
  lines.push('^Note: ^VRS ^officially ^updates ^once ^per ^month. ^This ^is ^simply ^a ^prediction ' +
    '^that ^might ^not ^take ^into ^account ^all ^factors ^that ^go ^into ^VRS ^calculations.');
  return lines.join('\n');
}

function eventBlock(d, ctx) {
  var bits = ['**' + d.event.name + '**'];
  if (ctx.setting && ctx.setting.place) {
    var venue = [d.prize, d.format.venue].filter(Boolean).join(' ');
    bits.push(ctx.flagLink(ctx.setting.flag) + ' ' + ctx.setting.place +
      (venue ? ' (' + venue + ')' : ''));
  }
  if (ctx.lpEventUrl) bits.push('[Liquipedia](' + ctx.lpEventUrl + ')');
  if (d.event.url) bits.push('[HLTV](' + d.event.url + ')');

  var out = ['### Event Information', '', bits.join(' | ') + ' '];
  if (ctx.streams && ctx.streams.length) {
    out.push('');
    out.push('**Streams** | ' + ctx.streams.map(function (s) {
      return '[' + s.label + '](' + s.url + ')';
    }).join(' | ') + '  ');
  }
  return out.join('\n');
}

function teamBlock(d, ctx, i) {
  var lp = ctx.lp[i];
  var bits = [ctx.teamTag(i) + ' **' + ctx.lpName(i) + '**'];
  if (lp && lp.url) bits.push('[Liquipedia](' + lp.url + ')');
  bits.push('[HLTV](' + (d.teams[i].urlPlain || d.teams[i].url) + ')');
  if (lp) lp.links.forEach(function (l) { bits.push('[' + l.label + '](' + l.url + ')'); });

  var lines = [bits.join(' | ') + '  '];
  var people = function (list) {
    return list.map(function (p) {
      return ctx.flagLink(p.flag) + ' ' + p.nick + roleMark(p.nick, d.roles, p.id);
    }).join(' | ');
  };
  if (lp && lp.roster.length) lines.push('**Roster**: ' + people(lp.roster) + '  ');
  if (lp && lp.coaches.length) lines.push('**Coach**: ' + people(lp.coaches) + '  ');
  if (lp && lp.benched.length) lines.push('**Subs/Benched**: ' + people(lp.benched) + '  ');
  return lines.join('\n');
}

function teamInfoBlock(d, ctx) {
  return ['### Team Information', '',
    teamBlock(d, ctx, 0), '  ', '',
    teamBlock(d, ctx, 1), '',
    '^Note: ^Above ^rosters ^do ^not ^reflect ^temporary ^subs ^and ^may ^be ^out ^of ^date ' +
    '^if ^recent ^changes ^were ^made'
  ].join('\n');
}

function vetoBlock(d, ctx) {
  if (!d.veto.length) return '';
  var lines = [
    '###Map Vetoes', '',
    '|[' + d.teams[0].name + '](' + ctx.anchor(0) + ')|**MAP**|[' + d.teams[1].name + '](' + ctx.anchor(1) + ')|',
    '|:--:|:--:|:--:|'
  ];
  d.veto.forEach(function (v) {
    var mark = v.action === 'removed' ? '**X**' : v.action === 'picked' ? '**✔**' : '';
    var map = v.map.toLowerCase();
    lines.push('|' + (v.side === 0 ? mark : '') +
      '|[' + map + '](#map-' + map + ')|' +
      (v.side === 1 ? mark : '') + '|');
  });
  return lines.join('\n');
}

function statsTable(groups, d, ctx) {
  var lines = [
    '|**Team**|**K-D**|**ADR**|**Swing**|**Rating**|',
    '|:--|--:|--:|--:|--:|--:|'
  ];
  groups.forEach(function (g, i) {
    var avg = mean2(g.players.map(function (p) { return parseFloat(p.rating) || 0; }));
    lines.push('|&nbsp;&nbsp;' + ctx.teamTag(i) + ' **' + d.teams[i].name + '**||||' + avg + '|');
    g.players.forEach(function (p) {
      lines.push('|' + ctx.flagLink(p.flag) + ' ' + p.nick + roleMark(p.nick, d.roles, p.id) +
        '|' + p.kd + '|' + p.adr + '|' + p.swing + '|' + p.rating + '|');
    });
  });
  return lines.join('\n');
}

// Same shape as the match-stats table, but the numbers are HLTV's last-3-months
// highlighted stats (Rating / KPR / DPR / KAST / ADR / Round Swing) for the
// five actually playing, stand-ins included.
function lineupTable(d, ctx) {
  var groups = d.lineups || [];
  if (!groups.some(function (g) { return g && g.length; })) return '';
  var lines = [
    '|**Team**|**KPR**|**DPR**|**KAST**|**ADR**|**Swing**|**Rating**|',
    '|:--|--:|--:|--:|--:|--:|--:|--:|'
  ];
  groups.forEach(function (g, i) {
    if (!g || !g.length || !d.teams[i]) return;
    var rated = g.map(function (p) { return parseFloat(p.rating); }).filter(function (n) {
      return !isNaN(n);
    });
    var avg = mean2(rated);
    lines.push('|&nbsp;&nbsp;' + ctx.teamTag(i) + ' **' + d.teams[i].name + '**||||||' + avg + '|');
    g.forEach(function (p) {
      lines.push('|' + ctx.flagLink(p.flag) + ' ' + p.nick + roleMark(p.nick, d.roles, p.id) +
        '|' + (p.kpr || '') + '|' + (p.dpr || '') + '|' + (p.kast || '') +
        '|' + (p.adr || '') + '|' + (p.swing || '') + '|' + (p.rating || '') + '|');
    });
  });
  return lines.join('\n');
}

function lineupBlock(d, ctx) {
  var table = lineupTable(d, ctx);
  if (!table) return '';
  return [
    '### Lineups',
    '',
    table,
    '',
    '^Last ^3 ^months ^on ^HLTV. ^This ^is ^who ^is ^playing ^this ^match, ^including ^stand-ins.'
  ].join('\n');
}

// |Team|T|CT|OT1^CT:T|Total|  - one OT column per overtime played, its header
// naming the sides that team held across the two overtime halves.
function mapScoreTable(m, d, ctx) {
  var t1 = [], t2 = [];
  m.halves.forEach(function (h, i) { (i % 2 === 0 ? t1 : t2).push(h); });
  var side = function (arr, i, fallback) { return (arr[i] && arr[i].side) || fallback; };
  var rounds = function (arr, i) { return arr[i] ? arr[i].rounds : 0; };

  var ots = ctx.overtimes[m.mapstatsId] || [];
  var otCols = ots.map(function (ot, n) {
    var per = [0, 1].map(function (k) {
      var row = ot[k];
      return {
        sides: row.halves.map(function (h) { return h.side; }).join(':'),
        score: row.halves.map(function (h) { return h.rounds; }).join(':')
      };
    });
    return { n: n + 1, t1: per[0], t2: per[1] };
  });

  var head = '|Team|' + side(t1, 0, 'CT') + '|' + side(t1, 1, 'T') + '|' +
    otCols.map(function (o) { return 'OT' + o.n + '^' + o.t1.sides + '|'; }).join('') + 'Total|';
  var dash = '|:--|' + new Array(otCols.length + 3).join(':--:|') + ':--:|';
  var row1 = '|' + ctx.teamTag(0) + ' **' + d.teams[0].name + '**|' + rounds(t1, 0) + '|' + rounds(t1, 1) + '|' +
    otCols.map(function (o) { return o.t1.score + '|'; }).join('') + '**' + m.score[0] + '**|';
  var mid = '||**' + side(t2, 0, 'T') + '**|**' + side(t2, 1, 'CT') + '**|' +
    otCols.map(function (o) { return '**OT' + o.n + '^' + o.t2.sides + '**|'; }).join('');
  var row2 = '|' + ctx.teamTag(1) + ' **' + d.teams[1].name + '**|' + rounds(t2, 0) + '|' + rounds(t2, 1) + '|' +
    otCols.map(function (o) { return o.t2.score + '|'; }).join('') + '**' + m.score[1] + '**|';

  return [head, dash, row1, mid, row2].join('\n');
}

function mapBlock(m, index, d, ctx) {
  var out = ['###MAP ' + (index + 1) + ': ' + m.name, '', '&nbsp;', '', mapScoreTable(m, d, ctx)];
  var groups = d.statsByMap[m.mapstatsId];
  if (groups) {
    out.push('', '&nbsp;', '', statsTable(groups, d, ctx));
  }
  out.push('', '###[' + m.name + ' Detailed Stats](' + m.statsUrl + ')');
  return out.join('\n');
}

function highlightsBlock(d, ctx) {
  var list = (ctx.highlights && ctx.highlights.length) ? ctx.highlights : d.highlights;
  if (!list || !list.length) return '';
  return ['#Highlights', ''].concat(list.map(function (h) {
    var url = h.url + (h.url.indexOf('?') < 0 ? '?tt_content=channel_name&tt_medium=embed' : '');
    return '[' + h.title + '](' + url + ')  ';
  })).join('\n');
}

/* ---------------------------------------------------------------- assembly */

function buildTitle(d) {
  var stage = d.format.stage;
  return d.teams[0].name + ' vs ' + d.teams[1].name + ' / ' + d.event.name +
    (stage ? ' - ' + stage : '') + ' / Post-Match Discussion';
}

function buildLiveTitle(d) {
  var stage = d.format.stage;
  return d.teams[0].name + ' vs ' + d.teams[1].name + ' / ' + d.event.name +
    (stage ? ' - ' + stage : '') + ' / Live Match Discussion';
}

function liveHeaderBlock(d, ctx) {
  var series = seriesFromMaps(d.maps);
  var scoreBit = (series[0] + series[1] > 0)
    ? series[0] + '-' + series[1]
    : 'vs';
  var lines = [
    '#' + ctx.lpName(0) + ' ' + ctx.teamTag(0) + ' ' +
    '[' + scoreBit + '](' + d.matchUrl + ') ' +
    ctx.teamTag(1) + ' ' + ctx.lpName(1) + '  ',
    ''
  ];
  var allTba = d.maps.length && d.maps.every(function (m) {
    return m.status === 'tba' || /^tba$/i.test(m.name);
  });
  if (allTba) {
    lines.push('**Maps:** TBA  ');
  } else {
    d.maps.forEach(function (m) {
      if (m.status === 'tba' || /^tba$/i.test(m.name)) lines.push('**TBA**  ');
      else if (m.status === 'finished') {
        lines.push('**' + m.name + ':** ' + m.score[0] + '-' + m.score[1] + '  ');
      } else if (m.status === 'live') {
        lines.push('**' + m.name + ':** LIVE  ');
      } else {
        lines.push('**' + m.name + '**  ');
      }
    });
  }
  return lines.join('\n');
}

function liveStatusBlock(d) {
  var lines = [];
  if (d.format && d.format.bestOf) lines.push('**' + d.format.bestOf + '**  ');
  if (d.live && d.live.isLive) lines.push('**LIVE**  ');
  else if (d.live && d.live.unix) {
    var when = formatUtc(d.live.unix);
    if (when) lines.push('**Starts:** ' + when + '  ');
  }
  var stakes = ((d.format && d.format.outcomeSentences) || []).filter(Boolean).join(' ');
  if (stakes) lines.push('**' + stakes + '**  ');
  return lines.join('\n');
}

function liveVetoBlock(d, ctx) {
  var veto = vetoBlock(d, ctx);
  if (veto) return veto;
  return '###Map Vetoes\n\nThe vetoes for this match are not yet available.';
}

function buildBody(d, extra) {
  extra = extra || {};
  var ctx = makeCtx(d, extra);

  var parts = [];
  parts.push(headerBlock(d, ctx) + '\n&nbsp;\n');

  var adv = advanceLine(d, ctx);
  if (adv) parts.push(adv + '\n\n&nbsp;\n');
  parts.push('-----');

  var vrs = vrsBlock(d, ctx);
  if (vrs) parts.push(vrs + '\n\n&nbsp;\n\n---\n');

  parts.push(eventBlock(d, ctx) + '\n\n&nbsp;\n\n---  \n');
  parts.push(teamInfoBlock(d, ctx) + '\n\n&nbsp;\n\n-----\n');

  var lineup = lineupBlock(d, ctx);
  if (lineup) parts.push(lineup + '\n\n&nbsp;\n\n-----\n');

  var veto = vetoBlock(d, ctx);
  if (veto) parts.push(veto + '\n\n&nbsp;\n\n\n---\n');

  if (d.statsAll) {
    parts.push('###Full Match Stats\n\n' + statsTable(d.statsAll, d, ctx) +
      '\n\n###[HLTV Match Page](' + d.matchUrl + ')\n\n\n&nbsp;\n\n---\n\n&nbsp;\n');
  }

  var played = d.maps.filter(function (m) { return m.played && m.mapstatsId; });
  played.forEach(function (m, i) {
    parts.push(mapBlock(m, i, d, ctx) + '\n\n\n&nbsp;\n\n---\n' +
      (i < played.length - 1 ? '\n&nbsp;\n' : ''));
  });

  var hl = highlightsBlock(d, ctx);
  if (hl) parts.push(hl + '\n\n---\n');

  parts.push(FOOTER);
  return parts.join('\n') + '\n';
}

function buildLiveBody(d, extra) {
  extra = extra || {};
  var ctx = makeCtx(d, extra);

  var parts = [];
  parts.push(liveHeaderBlock(d, ctx) + '\n&nbsp;\n');

  var status = liveStatusBlock(d);
  if (status) parts.push(status + '\n\n&nbsp;\n');
  parts.push('-----');

  parts.push(eventBlock(d, ctx) + '\n\n&nbsp;\n\n---  \n');
  parts.push(teamInfoBlock(d, ctx) + '\n\n&nbsp;\n\n-----\n');

  var lineup = lineupBlock(d, ctx);
  if (lineup) parts.push(lineup + '\n\n&nbsp;\n\n-----\n');

  parts.push(liveVetoBlock(d, ctx) + '\n\n&nbsp;\n\n\n---\n');

  if (d.statsAll) {
    parts.push('###Match Stats So Far\n\n' + statsTable(d.statsAll, d, ctx) +
      '\n\n###[HLTV Match Page](' + d.matchUrl + ')\n\n\n&nbsp;\n\n---\n\n&nbsp;\n');
  }

  var finished = d.maps.filter(function (m) { return m.status === 'finished'; });
  finished.forEach(function (m, n) {
    var i = d.maps.indexOf(m);
    parts.push(mapBlock(m, i < 0 ? n : i, d, ctx) + '\n\n\n&nbsp;\n\n---\n' +
      (n < finished.length - 1 ? '\n&nbsp;\n' : ''));
  });

  parts.push(FOOTER);
  return parts.join('\n') + '\n';
}

function buildThread(d, extra) {
  extra = extra || {};
  if (extra.kind === 'live') {
    return { title: buildLiveTitle(d), body: buildLiveBody(d, extra) };
  }
  return { title: buildTitle(d), body: buildBody(d, extra) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildTitle: buildTitle, buildBody: buildBody, buildThread: buildThread,
    buildLiveTitle: buildLiveTitle, buildLiveBody: buildLiveBody, mean2: mean2
  };
}
