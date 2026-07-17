'use strict';

/**
 * Dual-mode data layer:
 *  - local mode  → the bundled Node server (server.js) persists to data/prospects.json
 *                  on disk and auto-commits. Detected by probing /api/prospects.
 *  - github mode → static hosting (no server). The browser reads/writes
 *                  data/prospects.json in a PRIVATE GitHub repo via the Contents
 *                  API; every action is a real commit ("outreach: {company} → {status}").
 *                  Config + fine-grained token live in this browser's localStorage.
 */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PRIORITY_ORDER = { High: 0, Medium: 1, Watch: 2 };
const PRIORITY_PILL = {
  High: { label: '★ START HERE', cls: 'pill-high' },
  Medium: { label: 'GOOD FIT', cls: 'pill-medium' },
  Watch: { label: 'CHECK FIRST', cls: 'pill-watch' },
};
const SENT_CHEERS = [
  'Sent! 🔥 Next one queued up.',
  'Boom — out the door. 🚀',
  'That’s the work. Keep rolling. 💪',
  'Another touch in the pipeline. 📬',
  'Volume wins — nice. ⚡',
];
const FOLLOW_UP_DAYS = 5;
const SECOND_FOLLOW_UP_DAYS = 12;
const INKHOLD_ORIGIN = 'https://inkhold-chi.vercel.app';
// First gallery frame per demo slug (paths that exist on the live InkHold deploy).
const DEMO_THUMBS = {
  'alleged-arts': '/clients/alleged-arts/1.jpg',
  'anchor-tattoo': '/clients/anchor-tattoo/1.jpg',
  'crow-and-pitcher': '/clients/crow-and-pitcher/1.jpg',
  'dark-age': '/clients/dark-age/1.jpg',
  'elevation-project': '/clients/elevation-project/1.jpg',
  'facet-and-form': '/clients/facet-and-form/1.jpg',
  'hidden-hand': '/clients/hidden-hand/1.jpg',
  'hurricane-violet': '/clients/hurricane-violet/1.jpg',
  'rabid-hands': '/clients/rabid-hands/1.jpg',
  'slave-to-the-needle': '/clients/slave-to-the-needle/1.jpg',
  'sorry-sorry': '/clients/sorry-sorry/1.jpg',
  'true-love': '/clients/true-love/1.jpg',
  'wren-cavanaugh': '/clients/wren-cavanaugh/1.jpg',
};

let prospects = [];
let activeTab = 'donow';
let mode = null; // 'local' | 'github'
let saving = false;
let queuePos = 0; // browsing position in the Do Now queue
let gate = { id: null, opened: false, confirmed: false }; // per-card verify gate
const FILTER_KEY = 'outreach.filter';
let filterCat = localStorage.getItem(FILTER_KEY) || 'All'; // segment/category filter, persisted
let chipScroll = 0;
const isSMB = (p) => String(p.id).startsWith('smb-');

// Filter groups: every game-industry prospect (startup or SMB studio) shares one
// chip; SMB records keep their category chip; non-gaming startups pool together.
function groupOf(p) {
  const c = p.category || '';
  if (/gam(e|ing)/i.test(c)) return 'Video game companies';
  if (c.startsWith('SMB')) return c;
  return 'Other startups';
}

// ---------- shared status logic (mirrors server.js) ----------

function applyStatus(p, status) {
  p.status = status;
  if (status === 'sent') p.sentAt = new Date().toISOString();
  else if (status === 'reply' && !p.sentAt) p.sentAt = new Date().toISOString();
  else if (status === 'todo') p.sentAt = null; // reset — back to a fresh lead
}

// ---------- local mode ----------

async function loadLocal() {
  const res = await fetch('/api/prospects', { cache: 'no-store' });
  if (!res.ok) throw new Error('failed to load prospects');
  prospects = await res.json();
  render();
}

// ---------- github mode ----------

const GH_KEY = 'outreach.gh';
const GH_DEFAULT_PATH = 'data/prospects.json';

const gh = {
  sha: null,
  get cfg() {
    try { return JSON.parse(localStorage.getItem(GH_KEY)); } catch { return null; }
  },
  url(cfg) {
    const path = (cfg.path || GH_DEFAULT_PATH).split('/').map(encodeURIComponent).join('/');
    return `${cfg.api || 'https://api.github.com'}/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`;
  },
  headers(cfg) {
    return { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  },
  async load() {
    const cfg = this.cfg;
    const res = await fetch(this.url(cfg), { headers: this.headers(cfg), cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
    const json = await res.json();
    this.sha = json.sha;
    return JSON.parse(b64ToUtf8(json.content));
  },
  async save(list, message) {
    const cfg = this.cfg;
    const res = await fetch(this.url(cfg), {
      method: 'PUT',
      headers: { ...this.headers(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, branch: cfg.branch, sha: this.sha, content: utf8ToB64(JSON.stringify(list, null, 2) + '\n') }),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
    this.sha = (await res.json()).content.sha;
  },
};

function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- saving (both modes) ----------

async function setStatus(id, status) {
  if (saving) return false;
  saving = true;
  try {
    if (mode === 'local') {
      const res = await fetch('/api/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      await loadLocal();
      return true;
    }
    // github mode: mutate, then PUT the whole file as one commit
    const p = prospects.find((x) => x.id === id);
    if (!p) return false;
    applyStatus(p, status);
    const message = `outreach: ${p.company} → ${status}`;
    try {
      await gh.save(prospects, message);
    } catch (err) {
      if (err.status !== 409) throw err;
      // the repo moved on (e.g. a push from the desk) — refresh, re-apply, retry once
      prospects = await gh.load();
      const fresh = prospects.find((x) => x.id === id);
      if (fresh) applyStatus(fresh, status);
      await gh.save(prospects, message);
    }
    render();
    return true;
  } catch (err) {
    console.error(err);
    if (mode === 'github') {
      toast('⚠️ Couldn’t save to GitHub — check connection & token.');
      try { prospects = await gh.load(); } catch { /* keep what we have */ }
      render();
    } else {
      toast('⚠️ Couldn’t save — is `npm start` still running?');
    }
    return false;
  } finally {
    saving = false;
  }
}

// ---------- helpers ----------

// Roadmap hook: LinkedIn-connections import will set warmAdjacent / tags.
const isWarm = (p) => p.warmAdjacent === true || (Array.isArray(p.tags) && p.tags.includes('warm-adjacent'));

function queueList() {
  return prospects
    .filter((p) => p.status === 'todo' || p.status === 'later')
    .sort((a, b) =>
      (isWarm(b) - isWarm(a)) ||
      ((a.status === 'later') - (b.status === 'later')) ||
      (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) ||
      (isSMB(a) - isSMB(b))); // within a tier, the original startup list outranks SMB records
}

const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
const daysLabel = (d) => (d === 0 ? 'sent today' : d === 1 ? 'sent yesterday' : `sent ${d} days ago`);

const linkedinURL = (p) => 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(p.linkedinSearch);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* leave ok false */ }
    ta.remove();
    return ok;
  }
}

// ---------- feedback ----------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

function celebrate() {
  const emoji = ['🎉', '⭐', '🥳', '💥', '🚀', '✨'];
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = emoji[(Math.random() * emoji.length) | 0];
    s.style.left = Math.random() * 100 + 'vw';
    s.style.fontSize = 16 + Math.random() * 22 + 'px';
    s.style.animationDelay = Math.random() * 0.35 + 's';
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1800);
  }
}

// ---------- render ----------

function render() {
  if (filterCat !== 'All' && !prospects.some((p) => groupOf(p) === filterCat)) filterCat = 'All';
  const scope = filterCat === 'All' ? prospects : prospects.filter((p) => groupOf(p) === filterCat);
  const sentOnly = scope.filter((p) => p.status === 'sent');
  const wins = scope.filter((p) => p.status === 'reply');
  const touched = sentOnly.length + wins.length; // a reply was sent too
  const queue = queueList().filter((p) => filterCat === 'All' || groupOf(p) === filterCat);

  $('#stat-sent').textContent = touched;
  $('#stat-replies').textContent = wins.length;
  $('#stat-togo').textContent = queue.length;
  $('#bar-fill').style.width = scope.length ? (touched / scope.length) * 100 + '%' : '0%';
  $('#count-donow').textContent = queue.length || '';
  $('#count-sent').textContent = sentOnly.length || '';
  $('#count-wins').textContent = wins.length || '';

  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));

  const view = $('#view');
  if (activeTab === 'donow') renderDoNow(view, queue);
  else if (activeTab === 'sent') renderSent(view, sentOnly);
  else renderWins(view, wins, touched);

  const activeId = activeTab === 'donow' && queue.length
    ? queue[Math.max(0, Math.min(queuePos, queue.length - 1))].id
    : null;
  renderDemoRails(activeId);
}

function demoSlug(p) {
  const m = String(p.demoUrl || '').match(/\/a\/([^/?#]+)/);
  return m ? m[1] : null;
}

function demoProspects() {
  return prospects
    .filter((p) => p.demoUrl)
    .slice()
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
      || String(a.company).localeCompare(String(b.company)));
}

function demoTileHTML(p, activeId) {
  const slug = demoSlug(p);
  const thumb = slug && DEMO_THUMBS[slug] ? INKHOLD_ORIGIN + DEMO_THUMBS[slug] : '';
  const initial = String(p.company || '?').trim().charAt(0).toUpperCase();
  const pri = p.priority === 'High' ? 'Start here' : (p.priority === 'Medium' ? 'Good fit' : 'Watch');
  const media = thumb
    ? `<span class="demo-tile-media"><img src="${esc(thumb)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none';var f=this.nextElementSibling;if(f)f.hidden=false"><div class="demo-tile-fallback" hidden>${esc(initial)}</div></span>`
    : `<div class="demo-tile-fallback">${esc(initial)}</div>`;
  return `<a class="demo-tile${p.id === activeId ? ' active' : ''}" href="${esc(p.demoUrl)}" target="_blank" rel="noopener" data-id="${esc(p.id)}" title="Open ${esc(p.company)} demo">
    ${media}
    <span class="demo-tile-meta">
      <span class="demo-tile-name">${esc(p.company)}</span>
      <span class="demo-tile-sub">${esc(pri)} · open demo ↗</span>
    </span>
  </a>`;
}

function renderDemoRails(activeId) {
  const left = $('#demo-left');
  const right = $('#demo-right');
  if (!left || !right) return;
  const demos = demoProspects();
  if (!demos.length) {
    left.hidden = true;
    right.hidden = true;
    left.innerHTML = '';
    right.innerHTML = '';
    return;
  }
  const highs = demos.filter((p) => p.priority === 'High');
  const rest = demos.filter((p) => p.priority !== 'High');
  // Prefer High on the left; overflow High into right if needed so both rails stay useful.
  let leftList = highs;
  let rightList = rest;
  if (!leftList.length) {
    const mid = Math.ceil(demos.length / 2);
    leftList = demos.slice(0, mid);
    rightList = demos.slice(mid);
  } else if (!rightList.length) {
    const mid = Math.ceil(leftList.length / 2);
    rightList = leftList.slice(mid);
    leftList = leftList.slice(0, mid);
  }
  left.hidden = false;
  right.hidden = false;
  left.innerHTML = `<div class="demo-rail-title">InkHold · start here</div>${leftList.map((p) => demoTileHTML(p, activeId)).join('')}`;
  right.innerHTML = `<div class="demo-rail-title">InkHold · more demos</div>${rightList.map((p) => demoTileHTML(p, activeId)).join('')}`;
  const jump = (e) => {
    const a = e.target.closest('.demo-tile');
    if (!a) return;
    // Cmd/Ctrl-click keeps normal new-tab behavior only; plain click also jumps the queue.
    if (e.metaKey || e.ctrlKey) return;
    const id = a.dataset.id;
    const tattooQueue = queueList().filter((p) => groupOf(p) === 'SMB · Tattoo');
    const idx = tattooQueue.findIndex((p) => p.id === id);
    if (idx < 0) return;
    e.preventDefault();
    filterCat = 'SMB · Tattoo';
    localStorage.setItem(FILTER_KEY, filterCat);
    activeTab = 'donow';
    queuePos = idx;
    gate = { id: null, opened: false, confirmed: false };
    window.open(a.href, '_blank', 'noopener');
    render();
  };
  left.onclick = jump;
  right.onclick = jump;
}

function chipsHTML() {
  const remaining = queueList();
  const counts = {};
  for (const p of remaining) { const g = groupOf(p); counts[g] = (counts[g] || 0) + 1; }
  const cats = [...new Set(prospects.map(groupOf))];
  const chip = (label, count, active) =>
    `<button class="chip${active ? ' active' : ''}" data-cat="${esc(label)}">${esc(label)}<span class="chip-n">${count}</span></button>`;
  return `<div class="chips" id="chips">${chip('All', remaining.length, filterCat === 'All')}${cats.map((c) => chip(c, counts[c] || 0, filterCat === c)).join('')}</div>`;
}

function wireChips() {
  const el = $('#chips');
  if (!el) return;
  el.scrollLeft = chipScroll;
  el.onscroll = () => { chipScroll = el.scrollLeft; };
  el.onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    filterCat = b.dataset.cat;
    localStorage.setItem(FILTER_KEY, filterCat);
    queuePos = 0;
    render();
  };
}

function renderDoNow(view, queue) {
  if (!queue.length) {
    view.innerHTML = chipsHTML() + `<div class="empty"><div class="big">🏁</div><h2>All caught up${filterCat === 'All' ? '' : ' in ' + esc(filterCat)}!</h2>
      <p>Every prospect here has been worked. Check <strong>Sent</strong> for due follow-ups,
      pick another group above, or add fresh prospects to <code>data/prospects.json</code>.</p></div>`;
    wireChips();
    return;
  }
  queuePos = Math.max(0, Math.min(queuePos, queue.length - 1));
  const p = queue[queuePos];
  const smb = isSMB(p);
  const gateUrl = smb ? (p.website || p.sourceUrl) : p.sourceUrl;
  if (gate.id !== p.id) gate = { id: p.id, opened: !gateUrl, confirmed: false };
  const pill = PRIORITY_PILL[p.priority] || PRIORITY_PILL.Watch;
  const medium = p.sourceConfidence === 'medium';
  const header = chipsHTML() + `
    <div class="queue-nav">
      <button class="nav-btn" id="btn-prev"${queuePos === 0 ? ' disabled' : ''}>‹ Prev</button>
      <span class="queue-hint">${queuePos + 1} of ${queue.length}</span>
      <button class="nav-btn" id="btn-next"${queuePos >= queue.length - 1 ? ' disabled' : ''}>Next ›</button>
    </div>
    <article class="card">
      <div class="card-top">
        <span class="pill ${pill.cls}">${pill.label}</span>
        ${isWarm(p) ? '<span class="pill pill-warm">🤝 WARM-ADJACENT</span>' : ''}
        ${p.status === 'later' ? '<span class="pill pill-snooze">😴 SNOOZED</span>' : ''}
        <span class="cat">${esc(p.category)}</span>
      </div>
      <h2>${esc(p.company)}</h2>
      <p class="signal">⚡ <strong>Why now:</strong> ${esc(p.signal)}</p>
      ${p.sourceUrl ? `<p class="source${medium ? ' source-medium' : ''}">Source: <a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">${esc(p.sourceName || 'article')} ↗</a>${medium ? ' <span class="source-warn">double-check this one</span>' : ''}</p>` : ''}
      ${p.demoUrl ? `<p class="source">InkHold demo: <a href="${esc(p.demoUrl)}" target="_blank" rel="noopener">${esc(p.demoUrl.replace(/^https?:\/\//, ''))} ↗</a></p>` : ''}
      ${p.flag ? `<p class="flag">⚠️ ${esc(p.flag)}</p>` : ''}`;

  const wireNav = () => {
    wireChips();
    $('#btn-prev').onclick = () => { queuePos--; render(); };
    $('#btn-next').onclick = () => { queuePos++; render(); };
  };

  // Step 1: the sanity check. The message stays hidden until the source has
  // been opened and confirmed.
  if (!gate.confirmed) {
    view.innerHTML = header + `
      <div class="verify-box${medium ? ' verify-medium' : ''}">
        <div class="verify-title">Before you send</div>
        <p class="verify-text">${esc(p.verify || 'Open the source and confirm the signal still holds before you send anything.')}</p>
        <button class="btn" id="btn-opensource">${smb ? '🔍 Open their site' : '🔍 Open source & check'}</button>
        ${p.demoUrl ? `<button class="btn" id="btn-opendemo">🎨 Open InkHold demo</button>` : ''}
        ${smb && p.sourceUrl ? `<p class="found-link"><a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">where I found them ↗</a></p>` : ''}
        <button class="btn btn-primary" id="btn-looksright"${gate.opened ? '' : ' disabled'}>✓ Looks right</button>
        <button class="btn" id="btn-stale">✗ Signal's stale, skip it</button>
        ${gate.opened ? '' : `<p class="verify-hint">${smb ? 'Open their site first, then confirm it.' : 'Open the source first, then confirm it.'}</p>`}
      </div>
    </article>`;
    wireNav();
    $('#btn-opensource').onclick = () => {
      if (gateUrl) window.open(gateUrl, '_blank');
      gate.opened = true;
      render();
    };
    if (p.demoUrl) {
      $('#btn-opendemo').onclick = () => {
        window.open(p.demoUrl, '_blank');
        gate.opened = true;
        render();
      };
    }
    $('#btn-looksright').onclick = () => {
      if (!gate.opened) { toast('Open the source first 🔍'); return; }
      gate.confirmed = true;
      render();
    };
    $('#btn-stale').onclick = async () => {
      if (await setStatus(p.id, 'later')) toast('Skipped. It comes back when the signal is fresh again.');
    };
    return;
  }

  // Step 2: the checked card. Two-part copy, then the usual actions.
  view.innerHTML = header + `
      <p class="contact">✉️ <strong>Message:</strong> ${esc(p.contactName)}</p>
      <div class="msg-label">${smb ? 'Short version (contact form / LinkedIn invite)' : 'Connect note · send with the LinkedIn invite'}</div>
      <div class="message">${esc(p.connectNote)}</div>
      <button class="btn" id="btn-copynote">${smb ? '📋 Copy short' : '📋 Copy note'}</button>
      <div class="msg-label">${smb ? 'Full message (email)' : 'Opener · send after they accept'}</div>
      <div class="message">${esc(p.opener)}</div>
      <button class="btn" id="btn-copyopener">${smb ? '📋 Copy full' : '📋 Copy opener'}</button>
      ${smb && p.website ? '<button class="btn" id="btn-site">🌐 Their site</button>' : ''}
      ${p.demoUrl ? '<button class="btn" id="btn-demo">🎨 InkHold demo</button>' : ''}
      <button class="btn" id="btn-linkedin">🔗 Find them on LinkedIn</button>
      <button class="btn btn-primary" id="btn-sent">✅ Sent it — next!</button>
      <div class="btn-row">
        <button class="btn" id="btn-reply">⭐ They replied!</button>
        <button class="btn" id="btn-later">😴 Later</button>
      </div>
    </article>`;
  wireNav();
  const wireCopy = (sel, text, label, done) => {
    $(sel).onclick = async () => {
      if (await copyText(text)) {
        $(sel).textContent = '✅ Copied!';
        toast(done);
        setTimeout(() => { const b = $(sel); if (b) b.textContent = label; }, 1600);
      } else {
        toast('⚠️ Copy failed. Select the text manually.');
      }
    };
  };
  wireCopy('#btn-copynote', p.connectNote, smb ? '📋 Copy short' : '📋 Copy note', smb ? 'Short version copied.' : 'Note copied. Send it with the invite.');
  wireCopy('#btn-copyopener', p.opener, smb ? '📋 Copy full' : '📋 Copy opener', smb ? 'Full message copied.' : 'Opener copied. Send it once they accept.');
  if (smb && p.website) $('#btn-site').onclick = () => window.open(p.website, '_blank');
  if (p.demoUrl) $('#btn-demo').onclick = () => window.open(p.demoUrl, '_blank');
  $('#btn-linkedin').onclick = () => window.open(linkedinURL(p), '_blank');
  $('#btn-sent').onclick = async () => {
    if (await setStatus(p.id, 'sent')) toast(SENT_CHEERS[(Math.random() * SENT_CHEERS.length) | 0]);
  };
  $('#btn-reply').onclick = async () => {
    if (await setStatus(p.id, 'reply')) { celebrate(); toast('🎉 A reply! Go book that call!'); }
  };
  $('#btn-later').onclick = async () => {
    if (await setStatus(p.id, 'later')) toast('😴 Snoozed. It comes back around.');
  };
}

const filterNote = () => (filterCat === 'All' ? '' : `<p class="filter-note">Showing ${esc(filterCat)} only. Switch groups on the Do Now tab.</p>`);

function renderSent(view, sentOnly) {
  if (!sentOnly.length) {
    view.innerHTML = filterNote() + `<div class="empty"><div class="big">📭</div><h2>Nothing sent yet</h2>
      <p>Head to <strong>Do Now</strong> and fire off the first one.</p></div>`;
    return;
  }
  const rows = [...sentOnly].sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));
  view.innerHTML = filterNote() + rows.map((p) => {
    const d = p.sentAt ? daysSince(p.sentAt) : 0;
    const due = d >= FOLLOW_UP_DAYS;
    const badge = due ? `<span class="badge">⏰ ${d >= SECOND_FOLLOW_UP_DAYS ? '2nd follow-up' : 'Follow up'}</span>` : '';
    return `
    <article class="row" data-id="${esc(p.id)}">
      <div class="row-head"><strong>${esc(p.company)}</strong><span class="days">${daysLabel(d)}</span>${badge}</div>
      <div class="row-sub">${esc(p.contactName)}</div>
      <div class="row-actions">
        ${due ? '<button class="btn" data-act="followup">📋 Copy follow-up</button>' : ''}
        <button class="btn" data-act="reply">⭐ Replied!</button>
        <button class="btn" data-act="linkedin">🔗 Open profile</button>
        <button class="btn" data-act="reset">↩️ Reset</button>
      </div>
    </article>`;
  }).join('');

  view.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const p = prospects.find((x) => x.id === btn.closest('.row').dataset.id);
      if (!p) return;
      if (btn.dataset.act === 'followup') {
        if (!p.followUp) { toast('⚠️ No follow-up text on this record.'); return; }
        if (await copyText(p.followUp)) toast('Follow-up copied. Most replies happen here 📈');
        else toast('⚠️ Copy failed.');
      } else if (btn.dataset.act === 'reply') {
        if (await setStatus(p.id, 'reply')) { celebrate(); toast('🎉 A reply! Go book that call!'); }
      } else if (btn.dataset.act === 'reset') {
        if (await setStatus(p.id, 'todo')) toast('↩️ Back in the queue as fresh.');
      } else {
        window.open(linkedinURL(p), '_blank');
      }
    };
  });
}

function renderWins(view, wins, touched) {
  if (!wins.length) {
    view.innerHTML = filterNote() + `<div class="empty"><div class="big">🌱</div><h2>No replies yet</h2>
      <p>Normal — most replies come on the day-5 and day-12 follow-ups. Keep the volume up.</p></div>`;
    return;
  }
  const rate = touched ? Math.round((wins.length / touched) * 100) : 0;
  view.innerHTML = filterNote() + `
    <div class="wins-head">🎉 <strong>${wins.length} ${wins.length === 1 ? 'reply' : 'replies'}</strong> · ${rate}% reply rate — <strong>book the call!</strong></div>
    ${wins.map((p) => `
    <article class="row" data-id="${esc(p.id)}">
      <div class="row-head"><strong>${esc(p.company)}</strong><span class="days">${esc(p.priority)}</span></div>
      <div class="row-sub">${esc(p.contactName)} · ${esc(p.category)}</div>
      <div class="row-actions">
        <button class="btn" data-act="linkedin">🔗 Open LinkedIn</button>
        <button class="btn" data-act="reset">↩️ Reset</button>
      </div>
    </article>`).join('')}`;
  view.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const p = prospects.find((x) => x.id === btn.closest('.row').dataset.id);
      if (!p) return;
      if (btn.dataset.act === 'reset') {
        if (await setStatus(p.id, 'todo')) toast('↩️ Back in the queue as fresh.');
      } else {
        window.open(linkedinURL(p), '_blank');
      }
    };
  });
}

// ---------- connect screen (github mode) ----------

function renderConnect(errMsg) {
  const cfg = gh.cfg || {};
  const left = $('#demo-left');
  const right = $('#demo-right');
  if (left) { left.hidden = true; left.innerHTML = ''; }
  if (right) { right.hidden = true; right.innerHTML = ''; }
  $('#view').innerHTML = `
    <article class="card">
      <h2>🔐 Connect to GitHub</h2>
      <p class="contact">This page holds no data. It reads and writes <code>${esc(cfg.path || GH_DEFAULT_PATH)}</code> in your
        <strong>private</strong> repo — every action becomes a commit. The token is saved in this browser only.</p>
      ${errMsg ? `<p class="flag">⚠️ ${esc(errMsg)}</p>` : ''}
      <label class="field">Repo <input id="gh-repo" autocomplete="off" spellcheck="false" placeholder="yourname/tonys-outreach" value="${esc(cfg.owner ? `${cfg.owner}/${cfg.repo}` : '')}"></label>
      <label class="field">Fine-grained token <input id="gh-token" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(cfg.token || '')}"></label>
      <label class="field">Branch <input id="gh-branch" autocomplete="off" spellcheck="false" value="${esc(cfg.branch || 'main')}"></label>
      <button class="btn btn-primary" id="gh-connect">Connect</button>
      ${cfg.token ? '<button class="btn" id="gh-forget">Forget token on this device</button>' : ''}
      <details class="help">
        <summary>How to make the token (2 min)</summary>
        <ol>
          <li>GitHub → Settings → Developer settings → <strong>Fine-grained tokens</strong> → Generate new token.</li>
          <li>Repository access: <strong>Only select repositories</strong> → your outreach repo.</li>
          <li>Permissions → Repository → <strong>Contents: Read and write</strong>. Nothing else.</li>
          <li>Set a long expiration, generate, and paste the <code>github_pat_…</code> here.</li>
        </ol>
      </details>
    </article>`;

  $('#gh-connect').onclick = async () => {
    const [owner, repo] = $('#gh-repo').value.trim().replace(/^https:\/\/github\.com\//, '').split('/');
    const token = $('#gh-token').value.trim();
    const branch = $('#gh-branch').value.trim() || 'main';
    if (!owner || !repo || !token) { toast('⚠️ Repo (owner/name) and token are both needed.'); return; }
    localStorage.setItem(GH_KEY, JSON.stringify({ ...(gh.cfg || {}), owner, repo, branch, token, path: cfg.path || GH_DEFAULT_PATH }));
    $('#gh-connect').textContent = 'Connecting…';
    await loadFromGitHub();
  };
  const forget = $('#gh-forget');
  if (forget) forget.onclick = () => {
    localStorage.removeItem(GH_KEY);
    prospects = [];
    toast('Token cleared on this device.');
    renderConnect();
  };
}

async function loadFromGitHub() {
  $('#view').innerHTML = '<div class="empty"><div class="big">⏳</div><p>Loading from GitHub…</p></div>';
  try {
    prospects = await gh.load();
    render();
  } catch (err) {
    console.error(err);
    renderConnect(
      err.status === 401 || err.status === 403 ? 'Token rejected — check it has “Contents: Read and write” on that repo (and hasn’t expired).'
        : err.status === 404 ? `Not found — check the repo name and branch, and that ${(gh.cfg && gh.cfg.path) || GH_DEFAULT_PATH} exists there.`
          : 'Couldn’t reach GitHub — check your connection.');
  }
}

// ---------- tabs & boot ----------

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  activeTab = b.dataset.tab;
  render();
});

$('#conn').onclick = () => renderConnect();

// laptop-friendly: arrow keys browse the Do Now queue
document.addEventListener('keydown', (e) => {
  if (activeTab !== 'donow' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { queuePos--; render(); }
  else if (e.key === 'ArrowRight') { queuePos++; render(); }
});

async function boot() {
  try {
    const r = await fetch('/api/prospects', { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
      mode = 'local';
      prospects = await r.json();
      render();
      return;
    }
  } catch { /* no local server — we're on static hosting */ }
  mode = 'github';
  $('#conn').hidden = false;
  if (!gh.cfg) renderConnect();
  else await loadFromGitHub();
}

boot().catch(() => {
  $('#view').innerHTML = `<div class="empty"><div class="big">🔌</div><h2>Can’t load prospects</h2>
    <p>Local: is <code>npm start</code> running? (If you hand-edited <code>data/prospects.json</code>, check it’s still valid JSON.)</p></div>`;
});
