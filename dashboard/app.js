/* CoachKonnekt private dashboard.
   Pages (hash routes):  #/  overview   #/team/<slug>  team board   #/athlete/<id>  athlete page
   Data is protected by Supabase Row Level Security: only emails listed in the staff table can read it. */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://qecbwvgftefrgeqghokr.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_bJ2cXZMoK5esEOLOSzb0yw_ZcCCXehk';
  var INVITE_URL = 'https://coachkonnekt.com/connect/?invite=';
  var TZ = 'Europe/Istanbul';
  var HISTORY_DAYS = 35;

  var RESET_URL = 'https://coachkonnekt.com/dashboard/?reset=1';
  // Arriving from a password-reset email? (Read before Supabase tidies up the address bar.)
  var linkError = /error_code=([a-z_]+)/.exec(location.hash);
  var recovering = /type=recovery/.test(location.hash) || /[?&]reset=1/.test(location.search);

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true } });
  var app = document.getElementById('app');
  var nav = document.getElementById('nav');
  var who = document.getElementById('who');
  var state = { session: null, role: null, staffName: null, teams: [], athletes: [] };

  // ------------------------------------------------------------ helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fullName(a) { return ((a.first_name || '') + ' ' + (a.last_name || '')).trim() || 'Unnamed athlete'; }
  function zone(v) { return v == null ? 'none' : v >= 67 ? 'green' : v >= 34 ? 'yellow' : 'red'; }
  function zoneHex(v) { return { green: '#3ddc84', yellow: '#f5c542', red: '#ff4d5e', none: '#5b646b' }[zone(v)]; }
  function round(v, d) { if (v == null || isNaN(v)) return null; var m = Math.pow(10, d || 0); return Math.round(v * m) / m; }
  function avg(arr) { var x = arr.filter(function (v) { return v != null && !isNaN(v); }); return x.length ? x.reduce(function (s, v) { return s + v; }, 0) / x.length : null; }
  function hm(ms) { if (ms == null) return '–'; var m = Math.round(ms / 60000); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; }
  function dayKey(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }); } // YYYY-MM-DD
  function fmtDay(iso) { return new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); }
  function ago(iso) {
    if (!iso) return 'never';
    var h = (Date.now() - Date.parse(iso)) / 3600000;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min ago';
    if (h < 24) return Math.round(h) + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  function relDay(iso) {
    var k = dayKey(iso), today = dayKey(new Date().toISOString()), y = dayKey(new Date(Date.now() - 864e5).toISOString());
    return k === today ? 'today' : k === y ? 'yesterday' : fmtDay(iso);
  }
  function sinceISO(days) { return new Date(Date.now() - days * 864e5).toISOString(); }

  async function fetchAll(make) {
    var out = [], from = 0;
    for (;;) {
      var res = await make().range(from, from + 999);
      if (res.error) throw res.error;
      out = out.concat(res.data || []);
      if (!res.data || res.data.length < 1000) return out;
      from += 1000;
    }
  }
  function byAthlete(rows) { var m = {}; rows.forEach(function (r) { (m[r.athlete_id] = m[r.athlete_id] || []).push(r); }); return m; }

  // ------------------------------------------------------------ metrics
  // Everything the boards show for one athlete, from their recent rows.
  function summarize(a, rec, slp, cyc) {
    rec = (rec || []).filter(function (r) { return r.score_state === 'SCORED' && r.recovery_score != null; })
      .sort(function (x, y) { return Date.parse(y.created_at) - Date.parse(x.created_at); });
    slp = (slp || []).filter(function (s) { return !s.nap && s.total_sleep_milli != null; })
      .sort(function (x, y) { return Date.parse(y.end_time || y.start_time) - Date.parse(x.end_time || x.start_time); });
    cyc = (cyc || []).filter(function (c) { return c.end_time && c.strain != null; })
      .sort(function (x, y) { return Date.parse(y.start_time) - Date.parse(x.start_time); });
    var last = rec[0] || null;
    var base = avg(rec.slice(1, 8).map(function (r) { return r.hrv_rmssd_milli; }));
    var hrvDelta = last && base ? (last.hrv_rmssd_milli - base) / base : null;
    var s = {
      athlete: a,
      recovery: last ? round(last.recovery_score) : null,
      recoveryAt: last ? last.created_at : null,
      hrv: last ? round(last.hrv_rmssd_milli) : null,
      hrvDelta: hrvDelta,
      rhr: last ? round(last.resting_heart_rate) : null,
      sleepMs: slp[0] ? slp[0].total_sleep_milli : null,
      sleepPerf: slp[0] ? round(slp[0].sleep_performance_percentage) : null,
      strain: cyc[0] ? round(cyc[0].strain, 1) : null,
      spark: rec.slice(0, 7).reverse().map(function (r) { return r.recovery_score; }),
      flags: []
    };
    var name = fullName(a);
    if (!a.connected) s.flags.push({ kind: 'sync', t: name, m: 'Disconnected from WHOOP. Send them a new invite link to reconnect.' });
    else if (!a.last_sync_at || Date.now() - Date.parse(a.last_sync_at) > 36 * 3600000) s.flags.push({ kind: 'sync', t: name, m: 'Last synced ' + ago(a.last_sync_at) });
    if (s.recovery != null && s.recovery < 34) s.flags.push({ kind: 'red', t: name, m: 'Recovery ' + s.recovery + '% (' + relDay(s.recoveryAt) + '). Keep training light.' });
    if (hrvDelta != null && hrvDelta < -0.15) s.flags.push({ kind: 'hrv', t: name, m: 'HRV ' + Math.round(-hrvDelta * 100) + '% below their 7-day average' });
    if (s.sleepMs != null && s.sleepMs < 6.5 * 3600000) s.flags.push({ kind: 'sleep', t: name, m: 'Only ' + hm(s.sleepMs) + ' of sleep' });
    return s;
  }

  // ------------------------------------------------------------ charts (plain SVG)
  function spark(values) {
    if (!values.length) return '<span class="muted">–</span>';
    var w = 96, h = 28, n = values.length;
    var pts = values.map(function (v, i) { return [n === 1 ? w / 2 : i / (n - 1) * (w - 6) + 3, h - 3 - (v / 100) * (h - 6)]; });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var last = pts[pts.length - 1];
    return '<svg width="96" height="28" viewBox="0 0 96 28" aria-hidden="true"><path d="' + d + '" fill="none" stroke="' + zoneHex(values[n - 1]) + '" stroke-width="1.75" stroke-linejoin="round"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.5" fill="' + zoneHex(values[n - 1]) + '"/></svg>';
  }

  // Bars per day (0–100 recovery, coloured by zone), optional line on a second axis.
  function barChart(days, opts) {
    var W = 760, H = 240, L = 34, R = opts.line ? 40 : 10, T = 10, B = 26;
    var iw = W - L - R, ih = H - T - B, n = days.length, bw = iw / Math.max(n, 1);
    var maxBar = opts.barMax || 100;
    var lineVals = opts.line ? days.map(function (d) { return d.line; }).filter(function (v) { return v != null; }) : [];
    var lineMax = lineVals.length ? Math.max.apply(null, lineVals) * 1.15 : 1;
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label) + '">';
    [0, 0.5, 1].forEach(function (f) {
      var y = T + ih - f * ih;
      out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="#3a4248" stroke-dasharray="3 4"/>';
      out += '<text class="axis" x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + Math.round(f * maxBar) + (opts.barUnit || '') + '</text>';
      if (opts.line) out += '<text class="axis" x="' + (W - R + 6) + '" y="' + (y + 4) + '">' + Math.round(f * lineMax) + '</text>';
    });
    days.forEach(function (d, i) {
      if (d.bar == null) return;
      var h = Math.max(2, Math.min(1, d.bar / maxBar) * ih), x = L + i * bw + bw * 0.15;
      var col = opts.barColor || zoneHex(d.bar);
      out += '<rect x="' + x.toFixed(1) + '" y="' + (T + ih - h).toFixed(1) + '" width="' + (bw * 0.7).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + col + '"><title>' + esc(d.title) + '</title></rect>';
    });
    if (opts.line) {
      var p = [];
      days.forEach(function (d, i) { if (d.line != null) p.push([L + i * bw + bw / 2, T + ih - (d.line / lineMax) * ih]); });
      if (p.length > 1) out += '<path d="' + p.map(function (q, i) { return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(' ') + '" fill="none" stroke="' + opts.lineColor + '" stroke-width="2" stroke-dasharray="' + (opts.lineDash || '') + '"/>';
      p.forEach(function (q) { out += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="2.5" fill="' + opts.lineColor + '"/>'; });
    }
    var step = Math.ceil(n / 6);
    days.forEach(function (d, i) {
      if (i % step === 0 || i === n - 1) out += '<text class="axis" x="' + (L + i * bw + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(d.label) + '</text>';
    });
    return out + '</svg>';
  }
  function lastNDays(n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) { var iso = new Date(Date.now() - i * 864e5).toISOString(); out.push({ key: dayKey(iso), label: fmtDay(iso) }); }
    return out;
  }

  // ------------------------------------------------------------ auth
  async function boot() {
    var res = await sb.auth.getSession();
    state.session = res.data.session;
    sb.auth.onAuthStateChange(function (event, session) {
      var was = !!state.session; state.session = session;
      if (event === 'PASSWORD_RECOVERY') { recovering = true; route(); return; }
      if (was !== !!session) { state.role = null; route(); }
    });
    if (linkError) {
      recovering = false;
      history.replaceState(null, '', location.pathname);
      return renderLogin(linkError[1] === 'otp_expired' ? 'That reset link has expired or was already used. Request a new one below.' : 'That reset link did not work. Request a new one below.');
    }
    window.addEventListener('hashchange', route);
    route();
  }

  function renderLogin(msg) {
    nav.hidden = true; who.hidden = true;
    app.innerHTML =
      '<div class="login"><p class="kicker">Private</p><h1>Coach login</h1>' +
      '<p class="sub">For CoachKonnekt staff only.</p>' +
      '<form id="lf"><label>Email<input type="email" id="em" autocomplete="username" required></label>' +
      '<label>Password<input type="password" id="pw" autocomplete="current-password" required></label>' +
      '<button class="btn" id="go" type="submit">Log in</button>' +
      '<p class="err small" id="lerr" role="alert">' + esc(msg || '') + '</p>' +
      '<p class="small" style="margin:0"><a href="#" id="forgot" class="muted">Forgot your password?</a></p></form></div>';
    document.getElementById('forgot').addEventListener('click', function (e) { e.preventDefault(); renderForgot(document.getElementById('em').value.trim()); });
    document.getElementById('lf').addEventListener('submit', async function (e) {
      e.preventDefault();
      var b = document.getElementById('go'); b.disabled = true; b.textContent = 'Logging in…';
      var r = await sb.auth.signInWithPassword({ email: document.getElementById('em').value.trim(), password: document.getElementById('pw').value });
      if (r.error) { b.disabled = false; b.textContent = 'Log in'; document.getElementById('lerr').textContent = 'Wrong email or password.'; }
    });
  }

  function renderForgot(prefill) {
    nav.hidden = true; who.hidden = true;
    app.innerHTML =
      '<div class="login"><p class="kicker">Private</p><h1>Reset password</h1>' +
      '<p class="sub">Enter your staff email. We will send you a link to choose a new password.</p>' +
      '<form id="ff"><label>Email<input type="email" id="fem" autocomplete="username" required value="' + esc(prefill || '') + '"></label>' +
      '<button class="btn" id="fgo" type="submit">Send reset link</button>' +
      '<p class="small" id="fmsg" role="status"></p>' +
      '<p class="small" style="margin:0"><a href="#" id="back" class="muted">← Back to login</a></p></form></div>';
    document.getElementById('back').addEventListener('click', function (e) { e.preventDefault(); renderLogin(); });
    document.getElementById('ff').addEventListener('submit', async function (e) {
      e.preventDefault();
      var b = document.getElementById('fgo'), m = document.getElementById('fmsg');
      b.disabled = true; b.textContent = 'Sending…';
      var r = await sb.auth.resetPasswordForEmail(document.getElementById('fem').value.trim(), { redirectTo: RESET_URL });
      b.disabled = false; b.textContent = 'Send reset link';
      if (r.error && /rate|seconds/i.test(r.error.message)) { m.className = 'small err'; m.textContent = 'Too many requests. Please wait a minute and try again.'; return; }
      // Same answer whether or not the email has an account, so nobody can probe for staff emails.
      m.className = 'small z-green';
      m.textContent = 'If that email belongs to a staff account, a reset link is on its way. Check your inbox and spam folder.';
    });
  }

  async function ensureStaff() {
    if (state.role) return true;
    var r = await sb.rpc('staff_role');
    if (r.error || !r.data) {
      await sb.auth.signOut();
      renderLogin('This account does not have access to the dashboard.');
      return false;
    }
    state.role = r.data;
    var email = state.session.user.email;
    var st = await sb.from('staff').select('name').eq('email', email.toLowerCase()).maybeSingle();
    state.staffName = st.data && st.data.name;
    var t = await sb.from('teams').select('id,name,slug,sort').order('sort');
    if (t.error) throw t.error;
    state.teams = t.data;
    who.innerHTML = '<span class="email">' + esc(state.staffName || email) + '</span><span class="role">' + esc(state.role) + '</span><a class="linkbtn" href="#/account" style="text-decoration:none">Password</a><button class="linkbtn" id="out">Log out</button>';
    who.hidden = false;
    document.getElementById('out').onclick = function () { sb.auth.signOut(); };
    return true;
  }

  function renderNav(active) {
    nav.innerHTML = '<a href="#/" class="' + (active === 'home' ? 'on' : '') + '">Overview</a>' +
      state.teams.map(function (t) { return '<a href="#/team/' + esc(t.slug) + '" class="' + (active === t.slug ? 'on' : '') + '">' + esc(t.name) + '</a>'; }).join('');
    nav.hidden = false;
  }

  async function loadAthletes() {
    var r = await sb.from('athletes').select('id,first_name,last_name,email,team_id,connected,connected_at,last_sync_at,last_sync_error').order('first_name');
    if (r.error) throw r.error;
    state.athletes = r.data;
    return r.data;
  }

  async function loadHistory(ids, days, withWorkouts) {
    if (!ids.length) return { rec: {}, slp: {}, cyc: {}, wk: {} };
    var since = sinceISO(days);
    var jobs = [
      fetchAll(function () { return sb.from('recoveries').select('athlete_id,cycle_id,created_at,score_state,recovery_score,hrv_rmssd_milli,resting_heart_rate').in('athlete_id', ids).gte('created_at', since).order('created_at'); }),
      fetchAll(function () { return sb.from('sleeps').select('athlete_id,start_time,end_time,nap,score_state,sleep_performance_percentage,total_sleep_milli,total_in_bed_milli').in('athlete_id', ids).gte('start_time', since).order('start_time'); }),
      fetchAll(function () { return sb.from('cycles').select('athlete_id,start_time,end_time,score_state,strain').in('athlete_id', ids).gte('start_time', since).order('start_time'); })
    ];
    if (withWorkouts) jobs.push(fetchAll(function () { return sb.from('workouts').select('athlete_id,start_time,end_time,sport_name,score_state,strain,average_heart_rate,max_heart_rate').in('athlete_id', ids).gte('start_time', since).order('start_time', { ascending: false }); }));
    var res = await Promise.all(jobs);
    return { rec: byAthlete(res[0]), slp: byAthlete(res[1]), cyc: byAthlete(res[2]), wk: byAthlete(res[3] || []) };
  }

  // ------------------------------------------------------------ pages
  async function route() {
    if (!state.session) return renderLogin();
    try {
      if (recovering) return accountPage(true);
      if (!(await ensureStaff())) return;
      var h = location.hash.replace(/^#\/?/, '').split('/');
      if (h[0] === 'team' && h[1]) return await teamPage(h[1]);
      if (h[0] === 'athlete' && h[1]) return await athletePage(h[1], h[2], h[3] ? decodeURIComponent(h[3]) : '');
      if (h[0] === 'account') return accountPage();
      return await homePage();
    } catch (e) {
      console.error(e);
      app.innerHTML = '<div class="panel"><h2>Could not load data</h2><p class="err">' + esc(e.message || e) + '</p><p class="muted small">Refresh the page. If it keeps happening, check the Supabase setup.</p></div>';
    }
  }

  async function homePage() {
    renderNav('home');
    app.innerHTML = '<p class="loading">Loading teams…</p>';
    var athletes = await loadAthletes();
    var hist = await loadHistory(athletes.map(function (a) { return a.id; }), 10, false);
    var html = '<div class="head"><div><p class="kicker">Overview</p><h1>Hello' + (state.staffName ? ', ' + esc(state.staffName.split(' ')[0]) : '') + '</h1><p class="sub">Choose a team board.</p></div></div><div class="teamcards">';
    state.teams.forEach(function (t) {
      var list = athletes.filter(function (a) { return a.team_id === t.id; });
      var sums = list.map(function (a) { return summarize(a, hist.rec[a.id], hist.slp[a.id], hist.cyc[a.id]); });
      var rec = avg(sums.map(function (s) { return s.recovery; }));
      var flagged = sums.filter(function (s) { return s.flags.length; }).length;
      html += '<a class="panel teamcard" href="#/team/' + esc(t.slug) + '"><p class="kicker">Team board</p><h2>' + esc(t.name) + '</h2>' +
        '<div class="row"><span><b>' + list.length + '</b> <span class="muted">athletes</span></span>' +
        '<span class="z-' + zone(rec) + '"><span class="dot"></span><b>' + (rec == null ? '–' : Math.round(rec) + '%') + '</b> <span class="muted">avg recovery</span></span>' +
        '<span><b class="' + (flagged ? 'z-red' : '') + '">' + flagged + '</b> <span class="muted">need attention</span></span></div></a>';
    });
    html += '</div>';
    if (state.role === 'owner') html += ownerPanel(athletes);
    app.innerHTML = html;
    wireOwner();
    wireRemove();
  }

  // Owner only: every connected athlete, sync health, and moving athletes between teams.
  function ownerPanel(athletes) {
    var opts = function (sel) { return state.teams.map(function (t) { return '<option value="' + t.id + '"' + (t.id === sel ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join(''); };
    var rows = athletes.map(function (a) {
      return '<tr><td class="name"><a href="#/athlete/' + a.id + '">' + esc(fullName(a)) + '</a></td>' +
        '<td><select data-move="' + a.id + '" aria-label="Team for ' + esc(fullName(a)) + '">' + opts(a.team_id) + '</select></td>' +
        '<td>' + (a.connected ? '<span class="z-green"><span class="dot"></span>Connected</span>' : '<span class="z-red"><span class="dot"></span>Disconnected</span>') + '</td>' +
        '<td>' + esc(ago(a.last_sync_at)) + '</td><td class="small ' + (a.last_sync_error ? 'err' : 'muted') + '" style="white-space:normal;max-width:360px">' + esc(a.last_sync_error || 'OK') + '</td>' +
        '<td><button class="linkbtn danger" data-remove="' + a.id + '" data-name="' + esc(fullName(a)) + '">Remove</button></td></tr>';
    }).join('');
    return '<div style="margin-top:32px"><p class="kicker">Owner</p><h2>All athletes and sync status</h2><p class="sub small" style="margin-bottom:12px">Only you can see this section. Change a team to move an athlete between boards. Remove disconnects an athlete from WHOOP and deletes all their data.</p>' +
      '<div class="tablewrap"><table><thead><tr><th>Athlete</th><th>Team</th><th>WHOOP</th><th>Last sync</th><th>Sync message</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="muted">No athletes connected yet.</td></tr>') + '</tbody></table></div></div>';
  }
  function wireOwner() {
    app.querySelectorAll('select[data-move]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        sel.disabled = true;
        var r = await sb.from('athletes').update({ team_id: sel.value }).eq('id', sel.getAttribute('data-move'));
        sel.disabled = false;
        if (r.error) alertBox('Could not move athlete: ' + r.error.message); else route();
      });
    });
  }
  // Owner: revoke WHOOP access and delete all of an athlete's data (handled by the server function).
  function wireRemove() {
    app.querySelectorAll('button[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var name = btn.getAttribute('data-name');
        if (!confirm('Remove ' + name + '?\n\nThis disconnects CoachKonnekt from their WHOOP account and permanently deletes all their data here. They can rejoin later with a new invite link.')) return;
        btn.disabled = true; btn.textContent = 'Removing…';
        try {
          var r = await fetch(SUPABASE_URL + '/functions/v1/whoop/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.session.access_token },
            body: JSON.stringify({ athlete_id: btn.getAttribute('data-remove') })
          });
          var j = await r.json();
          if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
          await route();
          alertBox(name + ' was removed.' + (j.whoop_access_revoked ? ' WHOOP access revoked.' : ' WHOOP access was already disconnected.'), true);
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Remove';
          alertBox('Could not remove ' + name + ': ' + e.message);
        }
      });
    });
  }
  function alertBox(msg, ok) { var p = document.createElement('p'); p.className = ok ? 'z-green' : 'err'; p.setAttribute('role', 'status'); p.textContent = msg; app.prepend(p); }

  async function teamPage(slug) {
    var team = state.teams.filter(function (t) { return t.slug === slug; })[0];
    if (!team) { location.hash = '#/'; return; }
    renderNav(slug);
    app.innerHTML = '<p class="loading">Loading ' + esc(team.name) + '…</p>';
    var athletes = (await loadAthletes()).filter(function (a) { return a.team_id === team.id; });
    var hist = await loadHistory(athletes.map(function (a) { return a.id; }), HISTORY_DAYS, false);
    var sums = athletes.map(function (a) { return summarize(a, hist.rec[a.id], hist.slp[a.id], hist.cyc[a.id]); });

    var teamRec = avg(sums.map(function (s) { return s.recovery; }));
    var teamHrv = avg(sums.map(function (s) { return s.hrv; }));
    var teamSleep = avg(sums.map(function (s) { return s.sleepMs; }));
    var flags = [].concat.apply([], sums.map(function (s) { return s.flags.map(function (f) { f.id = s.athlete.id; return f; }); }));
    var attention = sums.filter(function (s) { return s.flags.length; }).length;

    // Team average recovery per day, last 28 days
    var days = lastNDays(28).map(function (d) {
      var vals = [];
      athletes.forEach(function (a) { (hist.rec[a.id] || []).forEach(function (r) { if (r.score_state === 'SCORED' && dayKey(r.created_at) === d.key) vals.push(r.recovery_score); }); });
      var v = avg(vals); return { label: d.label, bar: v == null ? null : Math.round(v), title: d.label + ': ' + (v == null ? 'no data' : Math.round(v) + '% (' + vals.length + ' athletes)') };
    });

    var html = '<div class="head"><div><p class="kicker">Team board · ' + esc(fmtDay(new Date().toISOString())) + '</p><h1>' + esc(team.name) + '</h1>' +
      '<p class="sub">' + athletes.length + ' athlete' + (athletes.length === 1 ? '' : 's') + ' · ' + sums.filter(function (s) { return s.recoveryAt && Date.now() - Date.parse(s.recoveryAt) < 30 * 3600000; }).length + ' with a recovery score today</p></div></div>';
    html += '<div class="grid4">' +
      tile('Team recovery', teamRec == null ? '–' : '<span class="z-' + zone(teamRec) + '">' + Math.round(teamRec) + '%</span>') +
      tile('Avg HRV', teamHrv == null ? '–' : Math.round(teamHrv) + '<small>ms</small>') +
      tile('Avg sleep', teamSleep == null ? '–' : hm(teamSleep)) +
      tile('Need attention', '<span class="' + (attention ? 'z-red' : '') + '">' + attention + '</span><small>athletes</small>') + '</div>';
    html += '<div class="grid2"><div class="panel chart"><h2>Team recovery · 28 days</h2><p class="sub small">Daily average of athletes with a score that day.</p>' +
      barChart(days, { label: 'Team average recovery per day' }) + '</div>' +
      '<div class="panel"><h2>Flags <span class="muted small">(' + flags.length + ')</span></h2>' + flagList(flags) + '</div></div>';
    html += athleteTable(sums);
    html += '<div class="panel invite" style="margin-top:16px"><h2>Invite an athlete to ' + esc(team.name) + '</h2>' +
      '<p class="sub small">Each invite link is for one athlete. It works once and expires after 2 days.</p>' +
      '<form id="invForm" class="linkrow"><input id="invName" maxlength="80" placeholder="Athlete name, e.g. Mert Demir" aria-label="Athlete name" required style="flex:1;min-width:220px">' +
      '<button class="btn" id="invGo" type="submit">Create invite link</button></form>' +
      '<div id="invNew" hidden></div>' +
      '<div id="invList"><p class="muted small">Loading invites…</p></div></div>';
    app.innerHTML = html;
    wireTable(sums);
    wireInvites(team);
  }

  // ------------------------------------------------------------ one-time invites
  function copyText(text, btn) {
    var done = function () { if (btn) { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy link'; }, 1500); } };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { prompt('Copy this link:', text); });
    else prompt('Copy this link:', text);
  }
  function inviteStatus(i) {
    if (i.cancelled_at) return ['Cancelled', 'muted'];
    if (i.used_at) return ['Used ' + fmtDay(i.used_at), 'z-green'];
    var left = Date.parse(i.expires_at) - Date.now();
    if (left <= 0) return ['Expired', 'muted'];
    var h = Math.floor(left / 3600000);
    return ['Pending · expires in ' + (h >= 1 ? h + ' h' : Math.max(1, Math.round(left / 60000)) + ' min'), 'z-yellow'];
  }
  async function loadInvites(team) {
    var box = document.getElementById('invList'); if (!box) return;
    var r = await sb.from('invites').select('id,token,athlete_name,created_by,created_at,expires_at,used_at,cancelled_at')
      .eq('team_id', team.id).order('created_at', { ascending: false }).limit(30);
    if (r.error) { box.innerHTML = '<p class="err small">Could not load invites: ' + esc(r.error.message) + '</p>'; return; }
    if (!r.data.length) { box.innerHTML = '<p class="muted small" style="margin:0">No invites yet.</p>'; return; }
    box.innerHTML = '<div class="tablewrap" style="margin-top:6px"><table style="min-width:640px"><thead><tr><th>Athlete</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>' +
      r.data.map(function (i) {
        var st = inviteStatus(i), pending = st[1] === 'z-yellow';
        return '<tr><td><b>' + esc(i.athlete_name) + '</b></td>' +
          '<td class="small muted">' + esc(fmtDay(i.created_at)) + ' ' + esc(fmtTime(i.created_at)) + (i.created_by ? ' · ' + esc(i.created_by.split('@')[0]) : '') + '</td>' +
          '<td class="small ' + st[1] + '">' + esc(st[0]) + '</td>' +
          '<td style="text-align:right">' + (pending ? '<button class="linkbtn" data-copy="' + esc(INVITE_URL + i.token) + '">Copy link</button> <button class="linkbtn danger" data-cancel="' + i.id + '" data-name="' + esc(i.athlete_name) + '">Cancel</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    box.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { copyText(b.getAttribute('data-copy'), b); }; });
    box.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.onclick = async function () {
        if (!confirm('Cancel the invite for ' + b.getAttribute('data-name') + '? The link will stop working.')) return;
        b.disabled = true;
        var u = await sb.from('invites').update({ cancelled_at: new Date().toISOString() }).eq('id', b.getAttribute('data-cancel'));
        if (u.error) { b.disabled = false; alertBox('Could not cancel invite: ' + u.error.message); return; }
        loadInvites(team);
      };
    });
  }
  function wireInvites(team) {
    var form = document.getElementById('invForm'); if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var name = document.getElementById('invName').value.trim(); if (!name) return;
      var btn = document.getElementById('invGo'); btn.disabled = true; btn.textContent = 'Creating…';
      var r = await sb.from('invites').insert({ team_id: team.id, athlete_name: name }).select('token,expires_at').single();
      btn.disabled = false; btn.textContent = 'Create invite link';
      var out = document.getElementById('invNew');
      if (r.error) { out.hidden = false; out.innerHTML = '<p class="err small">Could not create invite: ' + esc(r.error.message) + '</p>'; return; }
      var link = INVITE_URL + r.data.token;
      out.hidden = false;
      out.innerHTML = '<p class="small z-green" style="margin:12px 0 6px">Invite link for ' + esc(name) + ' is ready. Send it to them only; it expires ' + esc(fmtDay(r.data.expires_at)) + ' at ' + esc(fmtTime(r.data.expires_at)) + '.</p>' +
        '<div class="linkrow"><code>' + esc(link) + '</code><button class="btn ghost" id="invCopy" type="button">Copy link</button></div>';
      document.getElementById('invCopy').onclick = function () { copyText(link, this); };
      document.getElementById('invName').value = '';
      loadInvites(team);
    });
    loadInvites(team);
  }

  function tile(label, val) { return '<div class="panel tile"><div class="label">' + label + '</div><div class="val">' + val + '</div></div>'; }
  function flagList(flags) {
    if (!flags.length) return '<p class="muted">No flags. Everyone looks ready.</p>';
    var ic = { red: ['!', '#ff4d5e'], hrv: ['↓', '#f5c542'], sleep: ['z', '#9b8cff'], sync: ['×', '#a3acb2'] };
    return '<ul class="flags">' + flags.map(function (f) {
      var c = ic[f.kind];
      return '<li><span class="ic" style="background:' + c[1] + '">' + c[0] + '</span><div><b><a href="#/athlete/' + f.id + '">' + esc(f.t) + '</a></b><span>' + esc(f.m) + '</span></div></li>';
    }).join('') + '</ul>';
  }

  var sortState = { key: 'recovery', dir: 1 };
  function athleteTable(sums) {
    if (!sums.length) return '<div class="panel"><p class="muted" style="margin:0">No athletes on this board yet. Create an invite link below.</p></div>';
    var cols = [['name', 'Athlete'], ['recovery', 'Recovery'], ['hrv', 'HRV vs 7d'], ['rhr', 'RHR'], ['sleep', 'Sleep'], ['strain', 'Yday strain'], [null, '7-day recovery'], ['sync', 'Last sync']];
    return '<div class="tablewrap"><table><thead><tr>' + cols.map(function (c) {
      return '<th>' + (c[0] ? '<button data-sort="' + c[0] + '">' + c[1] + (sortState.key === c[0] ? (sortState.dir > 0 ? ' ↑' : ' ↓') : '') + '</button>' : c[1]) + '</th>';
    }).join('') + '</tr></thead><tbody id="tb"></tbody></table></div>';
  }
  function wireTable(sums) {
    var tb = document.getElementById('tb'); if (!tb) return;
    var val = {
      name: function (s) { return fullName(s.athlete).toLowerCase(); }, recovery: function (s) { return s.recovery; }, hrv: function (s) { return s.hrvDelta; },
      rhr: function (s) { return s.rhr; }, sleep: function (s) { return s.sleepMs; }, strain: function (s) { return s.strain; }, sync: function (s) { return s.athlete.last_sync_at ? -Date.parse(s.athlete.last_sync_at) : null; }
    };
    function draw() {
      var f = val[sortState.key];
      var rows = sums.slice().sort(function (a, b) {
        var x = f(a), y = f(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * sortState.dir;
      });
      tb.innerHTML = rows.map(function (s) {
        var a = s.athlete, d = s.hrvDelta;
        return '<tr class="click' + (a.connected ? '' : ' off') + '" data-id="' + a.id + '"><td class="name"><a href="#/athlete/' + a.id + '">' + esc(fullName(a)) + '</a></td>' +
          '<td class="num z-' + zone(s.recovery) + '"><span class="dot"></span><b>' + (s.recovery == null ? '–' : s.recovery + '%') + '</b> <span class="muted small">' + (s.recoveryAt ? relDay(s.recoveryAt) : '') + '</span></td>' +
          '<td class="num">' + (s.hrv == null ? '–' : s.hrv + ' ms') + (d == null ? '' : ' <span class="small ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '▲' : '▼') + Math.abs(Math.round(d * 100)) + '%</span>') + '</td>' +
          '<td class="num">' + (s.rhr == null ? '–' : s.rhr + ' bpm') + '</td>' +
          '<td class="num">' + hm(s.sleepMs) + (s.sleepPerf == null ? '' : ' <span class="muted small">' + s.sleepPerf + '%</span>') + '</td>' +
          '<td class="num strain">' + (s.strain == null ? '–' : s.strain.toFixed(1)) + '</td>' +
          '<td>' + spark(s.spark) + '</td>' +
          '<td class="small ' + (a.connected ? 'muted' : 'err') + '">' + (a.connected ? esc(ago(a.last_sync_at)) : 'Disconnected') + '</td></tr>';
      }).join('');
      app.querySelectorAll('th button').forEach(function (b) {
        var k = b.getAttribute('data-sort'), label = b.textContent.replace(/ [↑↓]$/, '');
        b.textContent = label + (sortState.key === k ? (sortState.dir > 0 ? ' ↑' : ' ↓') : '');
      });
    }
    app.querySelectorAll('th button').forEach(function (b) {
      b.onclick = function () { var k = b.getAttribute('data-sort'); sortState = { key: k, dir: sortState.key === k ? -sortState.dir : 1 }; draw(); };
    });
    tb.onclick = function (e) { var tr = e.target.closest('tr[data-id]'); if (tr && e.target.tagName !== 'A') location.hash = '#/athlete/' + tr.getAttribute('data-id'); };
    draw();
  }

  // ------------------------------------------------------------ athlete page
  // Route: #/athlete/<id>/<YYYY-MM-DD>/<view>   view: overview | recovery | sleep | strain | workout:<workoutId>
  var athleteCache = {};
  var chartRange = 14;
  var DAY_HISTORY = 90;

  async function loadAthleteData(id) {
    var c = athleteCache[id];
    if (c && Date.now() - c.at < 60000) return c.data;
    var since = sinceISO(DAY_HISTORY + 2);
    var res = await Promise.all([
      fetchAll(function () { return sb.from('recoveries').select('cycle_id,sleep_id,created_at,score_state,recovery_score,hrv_rmssd_milli,resting_heart_rate,spo2_percentage,skin_temp_celsius').eq('athlete_id', id).gte('created_at', since).order('created_at'); }),
      fetchAll(function () { return sb.from('sleeps').select('id,cycle_id,start_time,end_time,nap,score_state,sleep_performance_percentage,sleep_efficiency_percentage,respiratory_rate,total_sleep_milli,total_in_bed_milli,total_awake_milli,raw').eq('athlete_id', id).gte('start_time', since).order('start_time'); }),
      fetchAll(function () { return sb.from('cycles').select('id,start_time,end_time,score_state,strain,kilojoule,average_heart_rate,max_heart_rate').eq('athlete_id', id).gte('start_time', since).order('start_time'); }),
      fetchAll(function () { return sb.from('workouts').select('id,start_time,end_time,sport_name,score_state,strain,average_heart_rate,max_heart_rate,kilojoule,raw').eq('athlete_id', id).gte('start_time', since).order('start_time'); })
    ]);
    var data = { rec: res[0], slp: res[1], cyc: res[2], wk: res[3] };
    athleteCache[id] = { at: Date.now(), data: data };
    return data;
  }

  // Everything WHOOP recorded for one calendar day (Istanbul time).
  function dayData(d, key) {
    var rec = d.rec.filter(function (r) { return r.score_state === 'SCORED' && dayKey(r.created_at) === key; }).pop() || null;
    var sleeps = d.slp.filter(function (s) { return s.end_time && dayKey(s.end_time) === key; });
    var main = sleeps.filter(function (s) { return !s.nap; }).sort(function (a, b) { return (b.total_sleep_milli || 0) - (a.total_sleep_milli || 0); })[0] || null;
    var naps = sleeps.filter(function (s) { return s.nap; });
    var cycId = rec && rec.cycle_id != null ? rec.cycle_id : (main && main.cycle_id != null ? main.cycle_id : null);
    var cyc = (cycId != null && d.cyc.filter(function (c) { return c.id === cycId; })[0]) ||
      d.cyc.filter(function (c) { return dayKey(c.start_time) === key || (c.end_time && dayKey(c.end_time) === key); }).pop() || null;
    // Like WHOOP, a workout belongs to the day (cycle) it happened in, which runs from one sleep
    // to the next. A workout at 00:30 before going to bed counts towards the previous day.
    var wk = cyc
      ? d.wk.filter(function (w) { return inCycle(w, cyc); })
      : d.wk.filter(function (w) { return dayKey(w.start_time) === key && !d.cyc.some(function (c) { return inCycle(w, c); }); });
    return { key: key, rec: rec, sleep: main, naps: naps, cyc: cyc, wk: wk };
  }
  function inCycle(w, c) {
    var t = Date.parse(w.start_time);
    return t >= Date.parse(c.start_time) && (!c.end_time || t < Date.parse(c.end_time));
  }

  // Average of a value over the 30 days before `key` (WHOOP's "vs last 30 days").
  function avg30(d, key, pick) {
    var vals = [];
    for (var i = 1; i <= 30; i++) {
      var k = shiftKey(key, -i), dd = dayData(d, k), v = pick(dd);
      if (v != null && !isNaN(v)) vals.push(v);
    }
    return avg(vals);
  }
  function shiftKey(key, n) { var t = Date.parse(key + 'T12:00:00Z') + n * 864e5; return new Date(t).toISOString().slice(0, 10); }
  function keyLabel(key, opts) { return new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, opts)); }
  function todayKey() { return dayKey(new Date().toISOString()); }
  function kcal(kj) { return kj == null ? null : Math.round(kj / 4.184); }
  function clock(iso) { return iso ? fmtTime(iso) : '–'; }
  function hmClock(ms) { if (ms == null) return '–'; var m = Math.round(ms / 60000); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); }
  function sportName(w) { return (w.sport_name || 'Activity').replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  // A WHOOP-style ring: value / max, coloured arc.
  function ring(value, max, color, text, sub, label, view, active) {
    var r = 52, c = 2 * Math.PI * r, f = value == null ? 0 : Math.max(0, Math.min(1, value / max));
    return '<a class="ring' + (active ? ' on' : '') + '" href="' + view + '" aria-label="' + esc(label + ': ' + text + sub) + '">' +
      '<svg viewBox="0 0 128 128" aria-hidden="true"><circle cx="64" cy="64" r="' + r + '" fill="none" stroke="#3a4248" stroke-width="10"/>' +
      '<circle cx="64" cy="64" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + (f * c).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 64 64)"/>' +
      '<text x="64" y="72" text-anchor="middle" class="ring-val">' + esc(text) + '<tspan class="ring-unit">' + esc(sub) + '</tspan></text></svg>' +
      '<span class="ring-label">' + esc(label) + ' ›</span></a>';
  }

  // One metric row with the 30-day comparison, like WHOOP's detail screens.
  function metricRow(label, val, unit, base, better, fmt) {
    fmt = fmt || function (v) { return String(round(v, 1)); };
    var arrow = '', cls = 'muted';
    if (val != null && base != null && Math.abs(val - base) > Math.abs(base) * 0.005) {
      var up = val > base;
      arrow = up ? '▲' : '▼';
      cls = better === 0 ? 'muted' : ((up && better > 0) || (!up && better < 0)) ? 'up' : 'down';
    }
    return '<div class="mrow"><span class="mlabel">' + esc(label) + '</span><span class="mval"><b>' + (val == null ? '–' : esc(fmt(val))) + '</b>' +
      (unit && val != null ? '<small> ' + esc(unit) + '</small>' : '') + ' <span class="arrow ' + cls + '">' + arrow + '</span>' +
      '<em>' + (base == null ? '' : esc(fmt(base)) + (unit ? ' ' + esc(unit) : '')) + '</em></span></div>';
  }

  async function athletePage(id, key, view) {
    app.innerHTML = '<p class="loading">Loading athlete…</p>';
    var athletes = state.athletes.length ? state.athletes : await loadAthletes();
    var a = athletes.filter(function (x) { return x.id === id; })[0];
    if (!a) { athletes = await loadAthletes(); a = athletes.filter(function (x) { return x.id === id; })[0]; }
    if (!a) { renderNav(''); app.innerHTML = '<div class="panel"><h2>Athlete not found</h2><p><a href="#/">Back to overview</a></p></div>'; return; }
    var team = state.teams.filter(function (t) { return t.id === a.team_id; })[0];
    renderNav(team ? team.slug : '');
    var d = await loadAthleteData(id);

    var today = todayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) {
      // Start on the latest day that has a recovery or sleep, else today.
      var last = d.rec.filter(function (r) { return r.score_state === 'SCORED'; }).pop();
      key = last ? dayKey(last.created_at) : today;
    }
    if (key > today) key = today;
    var minKey = shiftKey(today, -DAY_HISTORY);
    if (key < minKey) key = minKey;
    view = view || 'overview';
    var base = '#/athlete/' + id + '/';
    var dd = dayData(d, key);
    var s = summarize(a, d.rec.filter(function (r) { return dayKey(r.created_at) <= today; }), d.slp, d.cyc);

    var html = '<p class="small"><a href="#/team/' + (team ? esc(team.slug) : '') + '" class="muted">← ' + esc(team ? team.name : 'Overview') + '</a></p>' +
      '<div class="head"><div><p class="kicker">' + esc(team ? team.name : 'No team') + ' · ' + (a.connected ? 'WHOOP synced ' + esc(ago(a.last_sync_at)) : 'Disconnected') + '</p><h1>' + esc(fullName(a)) + '</h1></div></div>';
    if (s.flags.length) html += '<div class="panel" style="margin-bottom:16px"><h2>Flags</h2>' + flagList(s.flags.map(function (f) { f.id = a.id; return f; })) + '</div>';

    // ---- day navigator
    var prev = shiftKey(key, -1), next = shiftKey(key, 1);
    html += '<div class="daynav panel">' +
      (key > minKey ? '<a class="navbtn" href="' + base + prev + '/' + view.split(':')[0].replace('workout', 'overview') + '" aria-label="Previous day">‹</a>' : '<span class="navbtn off">‹</span>') +
      '<label class="daypick"><span>' + esc(key === today ? 'Today' : keyLabel(key, { weekday: 'short' })) + ', ' + esc(keyLabel(key, { day: 'numeric', month: 'short', year: 'numeric' })) + '</span>' +
      '<input type="date" id="dayInput" value="' + key + '" min="' + minKey + '" max="' + today + '" aria-label="Choose a date"></label>' +
      (key < today ? '<a class="navbtn" href="' + base + next + '/' + view.split(':')[0].replace('workout', 'overview') + '" aria-label="Next day">›</a>' : '<span class="navbtn off">›</span>') +
      (key !== today ? '<a class="linkbtn" style="text-decoration:none;margin-left:6px" href="' + base + today + '/overview">Today</a>' : '') +
      '</div>';

    // ---- rings
    var slp = dd.sleep, rec = dd.rec, cyc = dd.cyc;
    var sleepPerf = slp ? round(slp.sleep_performance_percentage) : null;
    var recScore = rec ? round(rec.recovery_score) : null;
    var strain = cyc && cyc.strain != null ? round(cyc.strain, 1) : null;
    html += '<div class="rings">' +
      ring(sleepPerf, 100, '#8fa6c0', sleepPerf == null ? '–' : String(sleepPerf), sleepPerf == null ? '' : '%', 'Sleep', base + key + '/sleep', view === 'sleep') +
      ring(recScore, 100, zoneHex(recScore), recScore == null ? '–' : String(recScore), recScore == null ? '' : '%', 'Recovery', base + key + '/recovery', view === 'recovery') +
      ring(strain, 21, '#3aa0ff', strain == null ? '–' : strain.toFixed(1), '', 'Strain', base + key + '/strain', view === 'strain') +
      '</div>';

    // ---- activities of the day
    var acts = [];
    if (slp) acts.push({ kind: 'sleep', href: base + key + '/sleep', chip: hmClock(slp.total_sleep_milli), title: 'Sleep', start: slp.start_time, end: slp.end_time, cls: 'chip-sleep' });
    dd.naps.forEach(function (n) { acts.push({ kind: 'nap', href: base + key + '/sleep', chip: hmClock(n.total_sleep_milli), title: 'Nap', start: n.start_time, end: n.end_time, cls: 'chip-sleep' }); });
    dd.wk.forEach(function (w) { acts.push({ kind: 'workout', href: base + key + '/workout:' + w.id, chip: w.strain == null ? '–' : round(w.strain, 1).toFixed(1), title: sportName(w), start: w.start_time, end: w.end_time, cls: 'chip-strain', on: view === 'workout:' + w.id }); });
    acts.sort(function (x, y) { return Date.parse(x.start) - Date.parse(y.start); });
    var detail = dayDetail(d, dd, view, base);
    html += '<div class="daygrid"><div class="panel"><h2>Activities</h2>' + (acts.length ? '<div class="acts">' + acts.map(function (x) {
      return '<a class="act' + (x.on ? ' on' : '') + '" href="' + x.href + '"><span class="chip ' + x.cls + '">' + esc(x.chip) + '</span><b>' + esc(x.title) + '</b><span class="times">' + esc(clock(x.start)) + '<br>' + esc(clock(x.end)) + '</span></a>';
    }).join('') + '</div>' : '<p class="muted">Nothing recorded on this day.</p>') + '</div>' +
      '<div class="panel detail">' + detail + '</div></div>';

    // ---- trend charts
    html += '<div class="trendhead"><h2>Trends</h2><div class="seg">' + [7, 14, 30].map(function (n) {
      return '<button type="button" data-range="' + n + '" class="' + (chartRange === n ? 'on' : '') + '">' + n + ' days</button>';
    }).join('') + '</div></div><p class="sub small" style="margin:-4px 0 12px">Tap a bar or dot to open that day.</p>' + trendCharts(d, key, base);

    app.innerHTML = html;
    var inp = document.getElementById('dayInput');
    inp.addEventListener('change', function () { if (inp.value) location.hash = base + inp.value + '/overview'; });
    app.querySelectorAll('[data-range]').forEach(function (b) {
      b.onclick = function () { chartRange = Number(b.getAttribute('data-range')); athletePage(id, key, view); };
    });
    app.querySelectorAll('.tscroll').forEach(function (el) {
      var mark = el.querySelector('.sel');
      el.scrollLeft = mark ? Math.max(0, mark.getBoundingClientRect().left - el.getBoundingClientRect().left - el.clientWidth / 2) : el.scrollWidth;
    });
  }

  // ---- detail panel for the chosen view
  function dayDetail(d, dd, view, base) {
    var key = dd.key, rec = dd.rec, slp = dd.sleep, cyc = dd.cyc;
    var cmp = '<p class="cmp">' + esc(keyLabel(key, { weekday: 'short', day: 'numeric', month: 'short' })) + ' <span>vs. last 30 days</span></p>';
    if (view === 'recovery') {
      if (!rec) return '<h2>Recovery</h2><p class="muted">No recovery score for this day.</p>';
      var rr = slp ? slp.respiratory_rate : null;
      return '<h2>Recovery <b class="big z-' + zone(rec.recovery_score) + '">' + round(rec.recovery_score) + '%</b></h2>' + cmp +
        metricRow('Heart rate variability', rec.hrv_rmssd_milli, 'ms', avg30(d, key, function (x) { return x.rec && x.rec.hrv_rmssd_milli; }), 1, function (v) { return String(Math.round(v)); }) +
        metricRow('Resting heart rate', rec.resting_heart_rate, 'bpm', avg30(d, key, function (x) { return x.rec && x.rec.resting_heart_rate; }), -1, function (v) { return String(Math.round(v)); }) +
        metricRow('Respiratory rate', rr, 'rpm', avg30(d, key, function (x) { return x.sleep && x.sleep.respiratory_rate; }), 0) +
        metricRow('Sleep performance', slp ? slp.sleep_performance_percentage : null, '%', avg30(d, key, function (x) { return x.sleep && x.sleep.sleep_performance_percentage; }), 1, function (v) { return String(Math.round(v)); }) +
        (rec.spo2_percentage != null ? metricRow('Blood oxygen', rec.spo2_percentage, '%', avg30(d, key, function (x) { return x.rec && x.rec.spo2_percentage; }), 1) : '') +
        (rec.skin_temp_celsius != null ? metricRow('Skin temperature', rec.skin_temp_celsius, '°C', avg30(d, key, function (x) { return x.rec && x.rec.skin_temp_celsius; }), 0) : '');
    }
    if (view === 'sleep') {
      if (!slp) return '<h2>Sleep</h2><p class="muted">No sleep recorded for this day.</p>';
      var sc = (slp.raw && slp.raw.score) || {}, st = sc.stage_summary || {}, need = sc.sleep_needed || {};
      var needMs = need.baseline_milli != null ? (need.baseline_milli || 0) + (need.need_from_sleep_debt_milli || 0) + (need.need_from_recent_strain_milli || 0) + (need.need_from_recent_nap_milli || 0) : null;
      var light = st.total_light_sleep_time_milli, deep = st.total_slow_wave_sleep_time_milli, rem = st.total_rem_sleep_time_milli, awake = st.total_awake_time_milli;
      var tot = (light || 0) + (deep || 0) + (rem || 0) + (awake || 0);
      var bar = tot ? '<div class="stagebar" aria-hidden="true">' + [[awake, '#a3acb2'], [light, '#8fa6c0'], [deep, '#6c63ff'], [rem, '#c084fc']].map(function (p) { return '<i style="flex:' + (p[0] || 0) + ';background:' + p[1] + '"></i>'; }).join('') + '</div>' : '';
      var hoursFmt = function (v) { return hmClock(v); };
      return '<h2>Sleep <b class="big">' + hmClock(slp.total_sleep_milli) + '</b><small class="muted"> hours</small></h2>' +
        '<p class="muted small" style="margin:0 0 8px">' + esc(clock(slp.start_time)) + ' – ' + esc(clock(slp.end_time)) + ' · performance ' + (slp.sleep_performance_percentage == null ? '–' : Math.round(slp.sleep_performance_percentage) + '%') + '</p>' + bar +
        '<div class="legend"><span><i style="background:#a3acb2"></i>Awake</span><span><i style="background:#8fa6c0"></i>Light</span><span><i style="background:#6c63ff"></i>Deep (SWS)</span><span><i style="background:#c084fc"></i>REM</span></div>' + cmp +
        metricRow('Hours of sleep', slp.total_sleep_milli, '', avg30(d, key, function (x) { return x.sleep && x.sleep.total_sleep_milli; }), 1, hoursFmt) +
        (needMs != null ? metricRow('Sleep needed', needMs, '', avg30(d, key, function (x) { var n = x.sleep && x.sleep.raw && x.sleep.raw.score && x.sleep.raw.score.sleep_needed; return n && n.baseline_milli != null ? n.baseline_milli + (n.need_from_sleep_debt_milli || 0) + (n.need_from_recent_strain_milli || 0) + (n.need_from_recent_nap_milli || 0) : null; }), 0, hoursFmt) : '') +
        metricRow('Time in bed', slp.total_in_bed_milli, '', avg30(d, key, function (x) { return x.sleep && x.sleep.total_in_bed_milli; }), 0, hoursFmt) +
        metricRow('Awake', awake, '', avg30(d, key, function (x) { return x.sleep && x.sleep.raw && x.sleep.raw.score && x.sleep.raw.score.stage_summary && x.sleep.raw.score.stage_summary.total_awake_time_milli; }), -1, hoursFmt) +
        metricRow('Light sleep', light, '', avg30(d, key, function (x) { return x.sleep && x.sleep.raw && x.sleep.raw.score && x.sleep.raw.score.stage_summary && x.sleep.raw.score.stage_summary.total_light_sleep_time_milli; }), 0, hoursFmt) +
        metricRow('Deep sleep (SWS)', deep, '', avg30(d, key, function (x) { return x.sleep && x.sleep.raw && x.sleep.raw.score && x.sleep.raw.score.stage_summary && x.sleep.raw.score.stage_summary.total_slow_wave_sleep_time_milli; }), 1, hoursFmt) +
        metricRow('REM sleep', rem, '', avg30(d, key, function (x) { return x.sleep && x.sleep.raw && x.sleep.raw.score && x.sleep.raw.score.stage_summary && x.sleep.raw.score.stage_summary.total_rem_sleep_time_milli; }), 1, hoursFmt) +
        metricRow('Sleep efficiency', slp.sleep_efficiency_percentage, '%', avg30(d, key, function (x) { return x.sleep && x.sleep.sleep_efficiency_percentage; }), 1, function (v) { return String(Math.round(v)); }) +
        (sc.sleep_consistency_percentage != null ? metricRow('Sleep consistency', sc.sleep_consistency_percentage, '%', avg30(d, key, function (x) { return x.sleep && x.sleep.raw && x.sleep.raw.score && x.sleep.raw.score.sleep_consistency_percentage; }), 1, function (v) { return String(Math.round(v)); }) : '') +
        metricRow('Respiratory rate', slp.respiratory_rate, 'rpm', avg30(d, key, function (x) { return x.sleep && x.sleep.respiratory_rate; }), 0) +
        (st.disturbance_count != null ? metricRow('Disturbances', st.disturbance_count, '', avg30(d, key, function (x) { return x.sleep && x.sleep.raw && x.sleep.raw.score && x.sleep.raw.score.stage_summary && x.sleep.raw.score.stage_summary.disturbance_count; }), -1, function (v) { return String(Math.round(v)); }) : '');
    }
    if (view === 'strain') {
      if (!cyc || cyc.strain == null) return '<h2>Strain</h2><p class="muted">No strain recorded for this day.</p>';
      var z = [0, 0, 0, 0, 0, 0], hasZ = false;
      dd.wk.forEach(function (w) {
        var zd = w.raw && w.raw.score && w.raw.score.zone_durations; if (!zd) return; hasZ = true;
        ['zone_zero_milli', 'zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli'].forEach(function (k, i) { z[i] += zd[k] || 0; });
      });
      var zonesAvg = function (lo, hi) { return avg30(d, key, function (x) { var t = 0, any = false; x.wk.forEach(function (w) { var zd = w.raw && w.raw.score && w.raw.score.zone_durations; if (!zd) return; any = true; ['zone_zero_milli', 'zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli'].slice(lo, hi + 1).forEach(function (k) { t += zd[k] || 0; }); }); return any ? t : null; }); };
      return '<h2>Strain <b class="big" style="color:#3aa0ff">' + round(cyc.strain, 1).toFixed(1) + '</b></h2>' +
        '<p class="muted small" style="margin:0 0 8px">' + strainWords(cyc.strain) + '</p>' + cmp +
        metricRow('Day strain', cyc.strain, '', avg30(d, key, function (x) { return x.cyc && x.cyc.strain; }), 0) +
        (hasZ ? metricRow('Heart rate zones 1–3', z[1] + z[2] + z[3], '', zonesAvg(1, 3), 0, hmClock) + metricRow('Heart rate zones 4–5', z[4] + z[5], '', zonesAvg(4, 5), 0, hmClock) : '') +
        metricRow('Average heart rate', cyc.average_heart_rate, 'bpm', avg30(d, key, function (x) { return x.cyc && x.cyc.average_heart_rate; }), 0, function (v) { return String(Math.round(v)); }) +
        metricRow('Max heart rate', cyc.max_heart_rate, 'bpm', avg30(d, key, function (x) { return x.cyc && x.cyc.max_heart_rate; }), 0, function (v) { return String(Math.round(v)); }) +
        metricRow('Calories', kcal(cyc.kilojoule), 'kcal', avg30(d, key, function (x) { return x.cyc && kcal(x.cyc.kilojoule); }), 0, function (v) { return Math.round(v).toLocaleString('en-GB'); }) +
        metricRow('Workouts', dd.wk.length, '', avg30(d, key, function (x) { return x.cyc ? x.wk.length : null; }), 0, function (v) { return String(round(v, 1)); });
    }
    if (view.indexOf('workout:') === 0) {
      var w = dd.wk.filter(function (x) { return String(x.id) === view.slice(8); })[0];
      if (!w) return '<h2>Workout</h2><p class="muted">Workout not found on this day.</p>';
      var sc2 = (w.raw && w.raw.score) || {}, zd = sc2.zone_durations;
      var dur = w.end_time ? Date.parse(w.end_time) - Date.parse(w.start_time) : null;
      var same = function (pick) { var vals = d.wk.filter(function (x) { return x.sport_name === w.sport_name && x.id !== w.id && Date.parse(x.start_time) < Date.parse(w.start_time) && Date.parse(w.start_time) - Date.parse(x.start_time) < 30 * 864e5; }).map(pick); return avg(vals); };
      var zoneBars = '';
      if (zd) {
        var zs = ['zone_zero_milli', 'zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli'].map(function (k) { return zd[k] || 0; });
        var mx = Math.max.apply(null, zs) || 1, zc = ['#5b646b', '#8fa6c0', '#3aa0ff', '#3ddc84', '#f5c542', '#ff4d5e'];
        zoneBars = '<div class="zones">' + zs.map(function (v, i) { return '<div class="zrow"><span>Zone ' + i + '</span><div><i style="width:' + Math.round(v / mx * 100) + '%;background:' + zc[i] + '"></i></div><b>' + hmClock(v) + '</b></div>'; }).reverse().join('') + '</div>';
      }
      return '<h2>' + esc(sportName(w)) + ' <b class="big" style="color:#3aa0ff">' + (w.strain == null ? '–' : round(w.strain, 1).toFixed(1)) + '</b></h2>' +
        '<p class="muted small" style="margin:0 0 8px">' + esc(clock(w.start_time)) + ' – ' + esc(clock(w.end_time)) + ' · ' + hm(dur) + '</p>' +
        '<p class="cmp">This workout <span>vs. the same activity in the last 30 days</span></p>' +
        metricRow('Strain', w.strain, '', same(function (x) { return x.strain; }), 0) +
        metricRow('Duration', dur, '', same(function (x) { return x.end_time ? Date.parse(x.end_time) - Date.parse(x.start_time) : null; }), 0, hmClock) +
        metricRow('Average heart rate', w.average_heart_rate, 'bpm', same(function (x) { return x.average_heart_rate; }), 0, function (v) { return String(Math.round(v)); }) +
        metricRow('Max heart rate', w.max_heart_rate, 'bpm', same(function (x) { return x.max_heart_rate; }), 0, function (v) { return String(Math.round(v)); }) +
        metricRow('Calories', kcal(w.kilojoule), 'kcal', same(function (x) { return kcal(x.kilojoule); }), 0, function (v) { return String(Math.round(v)); }) +
        (sc2.distance_meter != null ? metricRow('Distance', sc2.distance_meter / 1000, 'km', same(function (x) { return x.raw && x.raw.score && x.raw.score.distance_meter != null ? x.raw.score.distance_meter / 1000 : null; }), 0, function (v) { return v.toFixed(2); }) : '') +
        (sc2.altitude_gain_meter != null ? metricRow('Elevation gain', sc2.altitude_gain_meter, 'm', same(function (x) { return x.raw && x.raw.score && x.raw.score.altitude_gain_meter; }), 0, function (v) { return String(Math.round(v)); }) : '') +
        (zoneBars ? '<h3 class="subh">Heart rate zones</h3>' + zoneBars : '');
    }
    // overview
    var lines = [];
    lines.push(['Recovery', rec ? '<span class="z-' + zone(rec.recovery_score) + '">' + round(rec.recovery_score) + '%</span>' : '–', 'recovery']);
    lines.push(['HRV', rec ? Math.round(rec.hrv_rmssd_milli) + ' ms' : '–', 'recovery']);
    lines.push(['Resting HR', rec ? Math.round(rec.resting_heart_rate) + ' bpm' : '–', 'recovery']);
    lines.push(['Sleep', slp ? hmClock(slp.total_sleep_milli) + (slp.sleep_performance_percentage != null ? ' · ' + Math.round(slp.sleep_performance_percentage) + '%' : '') : '–', 'sleep']);
    lines.push(['Strain', cyc && cyc.strain != null ? round(cyc.strain, 1).toFixed(1) : '–', 'strain']);
    lines.push(['Calories', cyc && cyc.kilojoule != null ? kcal(cyc.kilojoule).toLocaleString('en-GB') + ' kcal' : '–', 'strain']);
    return '<h2>Day summary</h2><p class="muted small" style="margin:0 0 6px">Tap Sleep, Recovery, Strain or an activity for details.</p>' +
      lines.map(function (l) { return '<a class="mrow link" href="' + base + key + '/' + l[2] + '"><span class="mlabel">' + l[0] + '</span><span class="mval"><b>' + l[1] + '</b> <span class="muted">›</span></span></a>'; }).join('');
  }
  function strainWords(v) {
    if (v == null) return '';
    if (v < 10) return 'Light strain (0–9.9): minimal cardiovascular load.';
    if (v < 14) return 'Moderate strain (10–13.9): significant but not straining load.';
    if (v < 18) return 'High strain (14–17.9): increased load that builds fitness.';
    return 'All-out strain (18–21): very high load, recovery will be needed.';
  }

  // ---- full-width trend charts with values and dates
  function trendCharts(d, selKey, base) {
    var today = todayKey(), keys = [];
    for (var i = chartRange - 1; i >= 0; i--) keys.push(shiftKey(today, -i));
    var days = keys.map(function (k) { return dayData(d, k); });
    var series = [
      { title: 'Recovery', unit: '%', type: 'bar', max: 100, val: function (x) { return x.rec ? Math.round(x.rec.recovery_score) : null; }, color: function (v) { return zoneHex(v); }, fmt: function (v) { return v + '%'; }, view: 'recovery' },
      { title: 'Day strain', unit: '0–21', type: 'bar', max: 21, val: function (x) { return x.cyc && x.cyc.strain != null ? round(x.cyc.strain, 1) : null; }, color: function () { return '#3aa0ff'; }, fmt: function (v) { return v.toFixed(1); }, view: 'strain' },
      { title: 'Heart rate variability', unit: 'ms', type: 'line', val: function (x) { return x.rec ? Math.round(x.rec.hrv_rmssd_milli) : null; }, color: function () { return '#ffffff'; }, fmt: String, view: 'recovery' },
      { title: 'Resting heart rate', unit: 'bpm', type: 'line', val: function (x) { return x.rec ? Math.round(x.rec.resting_heart_rate) : null; }, color: function () { return '#ff8a80'; }, fmt: String, view: 'recovery' },
      { title: 'Sleep', unit: 'hours', type: 'bar', val: function (x) { return x.sleep && x.sleep.total_sleep_milli != null ? x.sleep.total_sleep_milli : null; }, color: function () { return '#8fa6c0'; }, fmt: hmClock, view: 'sleep', maxFrom: function (vals) { return Math.max(10 * 3600000, Math.max.apply(null, vals) * 1.1); } }
    ];
    return series.map(function (s) { return trendChart(s, days, selKey, base); }).join('');
  }

  function trendChart(s, days, selKey, base) {
    var n = days.length, L = 8, R = 8, T = 26, B = 40, H = 200;
    var avail = Math.max(320, (app.clientWidth || 1100) - 70);
    var slot = Math.max(56, Math.floor((avail - L - R) / n));
    var W = Math.max(n * slot + L + R, 320), ih = H - T - B;
    var vals = days.map(function (x) { return s.val(x); });
    var present = vals.filter(function (v) { return v != null; });
    var lo = 0, hi = s.max || 1;
    if (s.maxFrom && present.length) hi = s.maxFrom(present);
    if (s.type === 'line' && present.length) {
      var mn = Math.min.apply(null, present), mxv = Math.max.apply(null, present), pad = Math.max(3, (mxv - mn) * 0.25);
      lo = Math.max(0, mn - pad); hi = mxv + pad;
    }
    var y = function (v) { return T + ih - (v - lo) / (hi - lo || 1) * ih; };
    var cx = function (i) { return L + i * slot + slot / 2; };
    var out = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(s.title + ' per day') + '">';
    out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '" stroke="#3a4248"/>';
    days.forEach(function (x, i) {
      var isSel = x.key === selKey, href = base + x.key + '/' + s.view;
      out += '<a href="' + href + '"' + (isSel ? ' class="sel"' : '') + '>';
      out += '<rect x="' + (L + i * slot + 2) + '" y="2" width="' + (slot - 4) + '" height="' + (H - 4) + '" rx="8" fill="' + (isSel ? 'rgba(255,255,255,.07)' : 'transparent') + '"/>';
      var v = vals[i];
      if (s.type === 'bar' && v != null) {
        var top = y(Math.min(v, hi)), bw = slot * 0.56;
        out += '<rect x="' + (cx(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(2, T + ih - top).toFixed(1) + '" rx="3" fill="' + s.color(v) + '"/>';
        out += '<text class="tv" x="' + cx(i) + '" y="' + (top - 7).toFixed(1) + '" text-anchor="middle">' + esc(s.fmt(v)) + '</text>';
      }
      var dow = keyLabel(x.key, { weekday: 'short' }), dm = keyLabel(x.key, { day: 'numeric', month: 'short' });
      out += '<text class="td' + (isSel ? ' on' : '') + '" x="' + cx(i) + '" y="' + (H - 22) + '" text-anchor="middle">' + esc(dow) + '</text>';
      out += '<text class="td' + (isSel ? ' on' : '') + '" x="' + cx(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(dm) + '</text>';
      out += '</a>';
    });
    if (s.type === 'line') {
      var pts = []; vals.forEach(function (v, i) { if (v != null) pts.push([cx(i), y(v), v]); });
      if (pts.length > 1) out += '<path d="' + pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + '" fill="none" stroke="' + s.color() + '" stroke-width="2" stroke-linejoin="round" opacity=".85" pointer-events="none"/>';
      pts.forEach(function (p) {
        out += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="4" fill="' + s.color() + '" pointer-events="none"/>';
        out += '<text class="tv" x="' + p[0].toFixed(1) + '" y="' + (p[1] - 10).toFixed(1) + '" text-anchor="middle" pointer-events="none">' + esc(s.fmt(p[2])) + '</text>';
      });
    }
    out += '</svg>';
    var latest = null; for (var i = vals.length - 1; i >= 0; i--) if (vals[i] != null) { latest = vals[i]; break; }
    var mean = avg(present);
    return '<div class="panel tchart"><div class="thead"><h3>' + esc(s.title) + ' <span class="muted small">(' + esc(s.unit) + ')</span></h3>' +
      '<span class="muted small">' + (mean == null ? 'No data' : 'Average ' + esc(s.fmt(s.type === 'bar' && s.max === 100 ? Math.round(mean) : (s.max === 21 ? round(mean, 1) : Math.round(mean))))) + '</span></div>' +
      '<div class="tscroll">' + out + '</div></div>';
  }

  // Change your own password while logged in.
  // Change password: from the header button, or after following a reset email (fromReset).
  function accountPage(fromReset) {
    if (fromReset) { nav.hidden = true; who.hidden = true; } else renderNav('');
    app.innerHTML = '<div class="login" style="margin-top:2vh"><p class="kicker">' + (fromReset ? 'Reset password' : 'Account') + '</p>' +
      '<h1>' + (fromReset ? 'Choose a new password' : 'Change password') + '</h1>' +
      '<p class="sub">' + esc(state.session.user.email) + '</p>' +
      '<form id="pf"><label>New password<input type="password" id="p1" autocomplete="new-password" minlength="8" required></label>' +
      '<label>Repeat new password<input type="password" id="p2" autocomplete="new-password" minlength="8" required></label>' +
      '<button class="btn" id="ps" type="submit">Save new password</button>' +
      '<p class="small" id="pmsg" role="status"></p><p class="muted small" style="margin:0">At least 8 characters.</p></form></div>';
    document.getElementById('pf').addEventListener('submit', async function (e) {
      e.preventDefault();
      var a = document.getElementById('p1').value, b = document.getElementById('p2').value, m = document.getElementById('pmsg'), btn = document.getElementById('ps');
      if (a !== b) { m.className = 'small err'; m.textContent = 'The two passwords do not match.'; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      var r = await sb.auth.updateUser({ password: a });
      btn.disabled = false; btn.textContent = 'Save new password';
      if (r.error) { m.className = 'small err'; m.textContent = 'Could not change password: ' + r.error.message; return; }
      document.getElementById('pf').reset();
      m.className = 'small z-green';
      if (fromReset) {
        recovering = false;
        history.replaceState(null, '', location.pathname + '#/');
        m.innerHTML = 'Password saved. <a href="#/" id="cont">Continue to the dashboard →</a>';
        document.getElementById('cont').addEventListener('click', function (ev) { ev.preventDefault(); route(); });
      } else {
        m.textContent = 'Password changed. Use it next time you log in.';
      }
    });
  }

  boot().catch(function (e) { console.error(e); app.innerHTML = '<p class="err">Could not start: ' + esc(e.message || e) + '</p>'; });
})();
