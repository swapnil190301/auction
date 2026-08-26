'use strict';
/**
 * Cricket Auction — client app.
 *
 * Every screen is the same page (`/`) driven by query-string params:
 *   /                                        -> landing
 *   /?screen=create                          -> create-room wizard
 *   /?screen=join&roomId=XXXX                -> enter PIN / watch as spectator
 *   /?roomId=XXXX&screen=host                -> auctioneer console (needs host session)
 *   /?roomId=XXXX&screen=team                -> team console (needs team session)
 *   /?roomId=XXXX&screen=view                -> read-only spectator dashboard
 *   /?screen=signup / /?screen=login         -> player account auth
 *   /?roomId=XXXX&screen=register            -> self-register as a player for this room
 *   /?roomId=XXXX&screen=player              -> a registered player's own status dashboard
 *
 * "Session" = { role, token, teamId?, teamName? } saved in localStorage per
 * roomId after a successful Room ID + PIN check. No room data is ever
 * hardcoded client-side — everything rendered comes from /api/presets (form
 * defaults only) or from the room's own state fetched/streamed from the server.
 *
 * A player "account" is a separate, room-independent identity (see the
 * ACCOUNT STORAGE section below): a player signs up once, and every future
 * registration reuses that saved profile (name/age/role/photo). Auction-only
 * values — tier, base price, sale price, team — are never set by the player;
 * only the host controls those, either immediately (auto mode) or via
 * approve/reject (approval mode).
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  /** Tiers are a fixed enum server-side (auctionConfig.tiers) — only each tier's price is configurable per room. */
  const TIERS = ['A', 'B', 'C'];
  /** Playing roles are a fixed enum server-side (auctionConfig.roles). */
  const PLAYING_ROLES = ['Batter', 'Bowler', 'All-rounder'];
  const RETAIN_ROLES = ['Owner', 'Captain', 'Icon'];

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  const TEAM_COLOR_CYCLE = [
    { base: '#ff9f1c', soft: 'rgba(255,159,28,.19)', border: 'rgba(255,159,28,.52)', text: '#2c1b00' },
    { base: '#ef4444', soft: 'rgba(239,68,68,.18)', border: 'rgba(239,68,68,.5)', text: '#2a0303' },
    { base: '#9ca3af', soft: 'rgba(156,163,175,.2)', border: 'rgba(156,163,175,.52)', text: '#111827' },
    { base: '#1f4ba5', soft: 'rgba(31,75,165,.2)', border: 'rgba(31,75,165,.52)', text: '#ecf3ff' },
    { base: '#facc15', soft: 'rgba(250,204,21,.22)', border: 'rgba(250,204,21,.55)', text: '#2b2400' },
    { base: '#3b82f6', soft: 'rgba(59,130,246,.2)', border: 'rgba(59,130,246,.52)', text: '#eaf3ff' },
    { base: '#a855f7', soft: 'rgba(168,85,247,.2)', border: 'rgba(168,85,247,.52)', text: '#f3e8ff' },
    { base: '#14b8a6', soft: 'rgba(20,184,166,.2)', border: 'rgba(20,184,166,.52)', text: '#e6fffb' },
  ];

  function teamPaletteByIndex(idx) {
    return TEAM_COLOR_CYCLE[idx % TEAM_COLOR_CYCLE.length];
  }

  function teamPaletteVarsByIndex(idx) {
    const c = teamPaletteByIndex(idx);
    return `--team-color:${c.base};--team-color-soft:${c.soft};--team-color-border:${c.border};--team-color-text:${c.text};`;
  }

  // ---------------------------------------------------------------------
  // URL helpers — the whole app is one page; screens are query params.
  // ---------------------------------------------------------------------
  function getParams() {
    return new URLSearchParams(location.search);
  }

  function navigate(params, { replace = false } = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') qs.set(k, v);
    });
    const url = `${location.pathname}${qs.toString() ? `?${qs.toString()}` : ''}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    boot();
  }

  window.addEventListener('popstate', () => boot());

  // ---------------------------------------------------------------------
  // Session storage — per-room role/token, kept client-side only.
  // ---------------------------------------------------------------------
  const SESSION_PREFIX = 'auctionSession:';

  function sessionKey(roomId) {
    return `${SESSION_PREFIX}${roomId}`;
  }

  function loadSession(roomId) {
    try {
      const raw = localStorage.getItem(sessionKey(roomId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSession(roomId, session) {
    try {
      localStorage.setItem(sessionKey(roomId), JSON.stringify({ ...session, roomId, savedAt: Date.now() }));
    } catch {
      /* ignore quota errors */
    }
  }

  function clearSession(roomId) {
    try {
      localStorage.removeItem(sessionKey(roomId));
    } catch {
      /* ignore */
    }
  }

  function listRecentRooms() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(SESSION_PREFIX)) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key));
        if (data && data.roomId) out.push(data);
      } catch {
        /* skip corrupt entry */
      }
    }
    return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  // ---------------------------------------------------------------------
  // Player account storage — one identity, reused across every room. Separate
  // from the per-room "session" above: this never expires on its own and
  // isn't tied to any single roomId.
  // ---------------------------------------------------------------------
  const ACCOUNT_KEY = 'playerAccount';

  function loadAccount() {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveAccount(token, account) {
    try {
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ token, account }));
    } catch {
      /* ignore quota errors */
    }
  }

  function clearAccount() {
    try {
      localStorage.removeItem(ACCOUNT_KEY);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------
  // API client
  // ---------------------------------------------------------------------
  async function apiGet(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  }

  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  }

  function copyToClipboard(text, btnEl) {
    const done = () => {
      if (!btnEl) return;
      const original = btnEl.textContent;
      btnEl.textContent = 'Copied!';
      btnEl.classList.add('copied');
      setTimeout(() => {
        btnEl.textContent = original;
        btnEl.classList.remove('copied');
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
      done();
    }
  }

  // ---------------------------------------------------------------------
  // App-wide mutable runtime (reset per screen)
  // ---------------------------------------------------------------------
  const app = {
    screen: 'landing',
    roomId: '',
    session: null,
    state: null,
    ws: null,
    wsReconnectTimer: null,
    presetsCache: null,
    createDraft: null,
    pollTimer: null,
  };

  function teardownPoll() {
    if (app.pollTimer) clearInterval(app.pollTimer);
    app.pollTimer = null;
  }

  function setTopActions(html) {
    const el = $('#topActions');
    if (el) el.innerHTML = html || '';
  }

  function setSubtitle(text) {
    const el = $('#viewSubtitle');
    if (el) el.textContent = text || '';
  }

  function mount(html) {
    $('#mainArea').innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------
  function boot() {
    teardownWs();
    teardownPoll();
    const params = getParams();
    const roomId = (params.get('roomId') || '').trim().toUpperCase();
    const screen = (params.get('screen') || (roomId ? 'join' : 'landing')).toLowerCase();
    app.roomId = roomId;
    app.screen = screen;

    if (screen === 'create') return renderCreateRoom();
    if (screen === 'created') return renderRoomCreated(app.createDraft);
    if (roomId && (screen === 'host' || screen === 'team')) return enterRoom(roomId, screen);
    if (roomId && screen === 'view') return enterSpectator(roomId);
    if (screen === 'signup') return renderAuthForm('signup');
    if (screen === 'login') return renderAuthForm('login');
    if (screen === 'register') return renderRegister(roomId);
    if (roomId && screen === 'player') return enterPlayerDashboard(roomId);
    if (roomId || screen === 'join') return renderJoin(roomId);
    return renderLanding();
  }

  // ---------------------------------------------------------------------
  // Landing screen
  // ---------------------------------------------------------------------
  function renderLanding() {
    setSubtitle('Run a live player auction with your friends, streamed to every device.');
    const account = loadAccount();
    setTopActions(
      account
        ? `<span class="badge">Playing as ${escapeHtml(account.account.profile.name)}</span> <button class="btn ghost" type="button" data-act="account-logout">Log out</button>`
        : `<button class="btn ghost" type="button" data-act="go-login">Player log in</button>`
    );
    const recent = listRecentRooms();
    const recentHtml = recent.length
      ? `
        <div class="recent-rooms">
          <p class="tiny muted" style="margin:0 0 2px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">Rooms on this device</p>
          ${recent.map((r) => `
            <div class="recent-room-row">
              <div>
                <strong>${escapeHtml(r.roomId)}</strong>
                <span class="muted tiny">${r.role === 'host' ? 'Auctioneer' : `Team${r.teamName ? ` — ${escapeHtml(r.teamName)}` : ''}`}</span>
              </div>
              <button class="btn ghost" type="button" data-act="open-recent" data-room="${escapeHtml(r.roomId)}" data-role="${r.role}">Open</button>
            </div>
          `).join('')}
        </div>`
      : '';

    mount(`
      <div class="center-page">
        <div class="hero-lockup">
          <h2>Run your cricket auction, live, anywhere</h2>
          <p>Create a room, share the Room ID and PIN with your teams, and everyone bids from their own phone while the host runs the show — all screens update instantly.</p>
        </div>
        <div class="entry-cards">
          <div class="entry-card" data-act="go-create">
            <div class="entry-card__icon">🏗️</div>
            <h3>Create a room</h3>
            <p>Set up teams, purse, tiers and your player list, then get a Room ID and PINs to share.</p>
            <button class="btn primary block" type="button" data-act="go-create">Create a room</button>
          </div>
          <div class="entry-card" data-act="go-join">
            <div class="entry-card__icon">🔑</div>
            <h3>Join a room</h3>
            <p>Have a Room ID and PIN? Enter them to bid as your team, run the auction, or just watch.</p>
            <button class="btn ghost block" type="button" data-act="go-join">Join with Room ID + PIN</button>
          </div>
          <div class="entry-card" data-act="go-register">
            <div class="entry-card__icon">🏏</div>
            <h3>Register to be auctioned</h3>
            <p>Set up your player profile once (name, age, role, photo), then enter it into any room with a Room ID and Player PIN.</p>
            <button class="btn ghost block" type="button" data-act="go-register">Register as a player</button>
          </div>
        </div>
        ${recentHtml}
      </div>
    `);
  }

  // ---------------------------------------------------------------------
  // Join screen
  // ---------------------------------------------------------------------
  function renderJoin(prefillRoomId, errorMsg) {
    setSubtitle('Join a room');
    setTopActions('');
    mount(`
      <div class="center-page">
        <div class="panel form-card">
          <h2>Join a room</h2>
          <p class="panel-sub">Ask the auctioneer for the Room ID and your PIN.</p>
          ${errorMsg ? `<div class="notice bad" style="margin-bottom:14px;">${escapeHtml(errorMsg)}</div>` : ''}
          <form id="joinForm" class="stack">
            <div class="field">
              <label for="joinRoomId">Room ID</label>
              <input class="input" id="joinRoomId" name="roomId" placeholder="e.g. K3F9QZ" autocomplete="off" value="${escapeHtml(prefillRoomId || '')}" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700;" required>
            </div>
            <div class="field">
              <label for="joinPin">PIN</label>
              <input class="input" id="joinPin" name="pin" placeholder="Host or team PIN" inputmode="numeric" autocomplete="off">
              <p class="field-hint">Enter your team's PIN to bid, or the host PIN to run the auction. Registering to <em>be</em> auctioned uses a different PIN — see below.</p>
            </div>
            <div class="btns" style="margin-top:4px;">
              <button class="btn primary" type="submit">Join</button>
              <button class="btn ghost" type="button" data-act="watch-only">Watch without a PIN</button>
            </div>
          </form>
          <div class="hr"></div>
          <p class="tiny muted" style="margin:0;">Trying to sign up <strong>as a player</strong> to be auctioned, not to bid? <a href="#" data-act="go-register-from-join">Register as a player instead</a>.</p>
        </div>
      </div>
    `);

    $('#joinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const roomId = $('#joinRoomId').value.trim().toUpperCase();
      const pin = $('#joinPin').value.trim();
      if (!roomId) return renderJoin(roomId, 'Enter a Room ID.');
      if (!pin) return renderJoin(roomId, 'Enter your PIN, or use "Watch without a PIN".');
      const { ok, data } = await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/join`, { pin });
      if (!ok) return renderJoin(roomId, data.error || 'Could not join that room.');
      saveSession(roomId, { role: data.role, token: data.token, teamId: data.teamId, teamName: data.teamName });
      navigate({ roomId, screen: data.role === 'host' ? 'host' : 'team' });
    });

  }

  // ---------------------------------------------------------------------
  // Player account — sign up / log in, and the "register for this room" flow.
  // ---------------------------------------------------------------------

  /** Downscales an image file to a small square-ish JPEG data URL so profile photos stay light. */
  function fileToProfilePhoto(file, maxDim = 320) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a readable image.'));
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function renderAuthForm(mode, errorMsg) {
    const isSignup = mode === 'signup';
    setSubtitle(isSignup ? 'Create your player profile' : 'Player log in');
    setTopActions('');
    mount(`
      <div class="center-page">
        <div class="panel form-card">
          <h2>${isSignup ? 'Create your player profile' : 'Log in'}</h2>
          <p class="panel-sub">${isSignup ? 'One profile, reused every time you register for an auction.' : 'Welcome back — log in to reuse your saved profile.'}</p>
          ${errorMsg ? `<div class="notice bad" style="margin-bottom:14px;">${escapeHtml(errorMsg)}</div>` : ''}
          <form id="authForm" class="stack">
            ${isSignup ? `
            <div class="field">
              <label for="authName">Your name</label>
              <input class="input" id="authName" required>
            </div>
            <div class="grid-2">
              <div class="field">
                <label for="authAge">Age</label>
                <input class="input" id="authAge" type="number" min="1" max="100">
              </div>
              <div class="field">
                <label for="authRole">Primary playing role</label>
                <select class="select" id="authRole">
                  <option value="">Not sure yet</option>
                  <option>Batter</option>
                  <option>Bowler</option>
                  <option>All-rounder</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label for="authPhoto">Profile photo (optional)</label>
              <input class="input" id="authPhoto" type="file" accept="image/*">
            </div>
            ` : ''}
            <div class="field">
              <label for="authUsername">Username</label>
              <input class="input" id="authUsername" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="authPassword">Password</label>
              <input class="input" id="authPassword" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required>
            </div>
            <div class="btns" style="margin-top:4px;">
              <button class="btn primary" type="submit">${isSignup ? 'Create profile' : 'Log in'}</button>
            </div>
          </form>
          <div class="hr"></div>
          <p class="tiny muted" style="margin:0;">
            ${isSignup ? 'Already have a profile? ' : "Don't have a profile yet? "}
            <a href="#" data-act="${isSignup ? 'go-login' : 'go-signup'}">${isSignup ? 'Log in' : 'Create one'}</a>
          </p>
        </div>
      </div>
    `);

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const username = $('#authUsername').value.trim();
        const password = $('#authPassword').value;
        let result;
        if (isSignup) {
          let photo = '';
          const fileInput = $('#authPhoto');
          const file = fileInput && fileInput.files && fileInput.files[0];
          if (file) {
            try {
              photo = await fileToProfilePhoto(file);
            } catch (err) {
              submitBtn.disabled = false;
              return renderAuthForm(mode, err.message);
            }
          }
          result = await apiPost('/api/accounts/signup', {
            username,
            password,
            name: $('#authName').value.trim(),
            age: $('#authAge').value ? Number($('#authAge').value) : null,
            role: $('#authRole').value,
            photo,
          });
        } else {
          result = await apiPost('/api/accounts/login', { username, password });
        }
        if (!result.ok) {
          submitBtn.disabled = false;
          return renderAuthForm(mode, result.data.error || 'Something went wrong.');
        }
        saveAccount(result.data.token, result.data.account);
        if (app._cameFromRegisterFlow) {
          navigate({ roomId: app._pendingRegisterRoomId || '', screen: 'register' });
        } else {
          navigate({});
        }
      } catch {
        submitBtn.disabled = false;
        renderAuthForm(mode, 'Could not reach the server.');
      }
    });
  }

  /**
   * A player's playing role (and age) can vary per tournament — this room's
   * entry doesn't have to match whatever is saved on their account. Renders
   * editable fields pre-filled from the account, defaulting to "keep as-is".
   */
  function roleAgeFieldsHtml(profile) {
    return `
      <div class="grid-2">
        <div class="field">
          <label for="regAge">Age for this room</label>
          <input class="input" id="regAge" type="number" min="1" max="100" value="${profile.age || ''}">
        </div>
        <div class="field">
          <label for="regRole">Role for this room</label>
          <select class="select" id="regRole">
            <option value="" ${!profile.role ? 'selected' : ''}>Not sure yet</option>
            <option ${profile.role === 'Batter' ? 'selected' : ''}>Batter</option>
            <option ${profile.role === 'Bowler' ? 'selected' : ''}>Bowler</option>
            <option ${profile.role === 'All-rounder' ? 'selected' : ''}>All-rounder</option>
          </select>
        </div>
      </div>
      <p class="field-hint">Playing different tournaments as different things? Change these just for this room — your saved profile won't change.</p>`;
  }

  function renderRegister(roomId) {
    const account = loadAccount();
    if (!account) {
      app._pendingRegisterRoomId = roomId;
      app._cameFromRegisterFlow = true;
      return renderAuthForm('signup');
    }

    setSubtitle(roomId ? `Register as a player — Room ${roomId}` : 'Register as a player');
    setTopActions(`<span class="badge">Playing as ${escapeHtml(account.account.profile.name)}</span> <button class="btn ghost" type="button" data-act="account-logout">Not you? Log out</button>`);

    mount(`
      <div class="center-page">
        <div class="panel form-card">
          <h2>Register to be auctioned</h2>
          <p class="panel-sub">Your saved profile will be sent to the host for this room. Base price, tier, and team are all decided by the host — not by you.</p>
          <div class="row" style="gap:14px;align-items:center;margin-bottom:16px;">
            ${account.account.profile.photo ? `<img src="${escapeHtml(account.account.profile.photo)}" alt="" style="width:64px;height:64px;border-radius:14px;object-fit:cover;border:1px solid var(--border);">` : ''}
            <div>
              <strong>${escapeHtml(account.account.profile.name)}</strong>
            </div>
          </div>
          <form id="registerForm" class="stack">
            <div class="field">
              <label for="regRoomId">Room ID</label>
              <input class="input" id="regRoomId" value="${escapeHtml(roomId)}" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700;" required>
            </div>
            <div class="field">
              <label for="regPin">Player PIN</label>
              <input class="input" id="regPin" inputmode="numeric" placeholder="Ask the host for this room's Player PIN" required>
            </div>
            ${roleAgeFieldsHtml(account.account.profile)}
            <div id="registerError"></div>
            <div class="btns" style="margin-top:4px;">
              <button class="btn primary" type="submit">Register</button>
            </div>
          </form>
        </div>
      </div>
    `);

    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const rid = $('#regRoomId').value.trim().toUpperCase();
      const pin = $('#regPin').value.trim();
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const { ok, data } = await apiPost(`/api/rooms/${encodeURIComponent(rid)}/register-player`, {
        accountToken: account.token,
        pin,
        role: $('#regRole').value,
        age: $('#regAge').value ? Number($('#regAge').value) : undefined,
      });
      submitBtn.disabled = false;
      if (!ok) {
        $('#registerError').innerHTML = `<div class="notice bad">${escapeHtml(data.error || 'Could not register.')}</div>`;
        return;
      }
      navigate({ roomId: rid, screen: 'player' });
    });
  }

  // ---------------------------------------------------------------------
  // Player dashboard — a registered player's own live status.
  // ---------------------------------------------------------------------
  async function enterPlayerDashboard(roomId) {
    const account = loadAccount();
    if (!account) {
      app._pendingRegisterRoomId = roomId;
      app._cameFromRegisterFlow = true;
      return renderAuthForm('signup');
    }
    const { ok: infoOk, data: infoData } = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/info`);
    if (!infoOk) return renderJoin(roomId, 'That room no longer exists.');

    const { ok, data } = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/my-status?accountToken=${encodeURIComponent(account.token)}`);
    if (!ok) {
      clearAccount();
      return renderAuthForm('login', 'Please log in again.');
    }

    if (data.status === 'not_registered' || data.status === 'rejected') {
      return renderPlayerAwaitingOrRejected(roomId, infoData.info, account, data.status);
    }

    if (data.status === 'pending') {
      renderPlayerPending(roomId, infoData.info, account);
      app.pollTimer = setInterval(async () => {
        const poll = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/my-status?accountToken=${encodeURIComponent(account.token)}`);
        if (poll.ok && poll.data.status !== 'pending') {
          teardownPoll();
          enterPlayerDashboard(roomId);
        }
      }, 4000);
      return;
    }

    // status === 'in_pool': live from here on via the normal room state stream.
    const stateRes = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/state`);
    if (!stateRes.ok) return renderJoin(roomId, 'Could not load the auction state.');
    app.state = stateRes.data.state;
    renderPlayerLive(roomId, infoData.info, account);
    connectWs(roomId, (state) => {
      app.state = state;
      renderPlayerLive(roomId, infoData.info, account);
    });
  }

  function renderPlayerAwaitingOrRejected(roomId, roomInfo, account, status) {
    setSubtitle(`Register — ${roomInfo.name} (Room ${roomId})`);
    setTopActions(`<button class="btn ghost" type="button" data-act="leave-room">Leave</button>`);
    mount(`
      <div class="center-page">
        <div class="panel form-card">
          ${status === 'rejected'
            ? `<div class="notice warn" style="margin-bottom:14px;">The host declined your last registration for this room. You're welcome to try again — maybe check with them first.</div>`
            : ''}
          <h2>Register for "${escapeHtml(roomInfo.name)}"</h2>
          <p class="panel-sub">Enter this room's Player PIN to enter the pool as ${escapeHtml(account.account.profile.name)}.</p>
          <form id="registerForm" class="stack">
            <div class="field">
              <label for="regPin">Player PIN</label>
              <input class="input" id="regPin" inputmode="numeric" required>
            </div>
            ${roleAgeFieldsHtml(account.account.profile)}
            <div id="registerError"></div>
            <button class="btn primary" type="submit">Register</button>
          </form>
        </div>
      </div>
    `);
    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = $('#regPin').value.trim();
      const { ok, data } = await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/register-player`, {
        accountToken: account.token,
        pin,
        role: $('#regRole').value,
        age: $('#regAge').value ? Number($('#regAge').value) : undefined,
      });
      if (!ok) {
        $('#registerError').innerHTML = `<div class="notice bad">${escapeHtml(data.error || 'Could not register.')}</div>`;
        return;
      }
      enterPlayerDashboard(roomId);
    });
  }

  function renderPlayerPending(roomId, roomInfo, account) {
    setSubtitle(`Waiting for approval — ${roomInfo.name} (Room ${roomId})`);
    setTopActions(`<button class="btn ghost" type="button" data-act="leave-room">Leave</button>`);
    mount(`
      <div class="center-page">
        <div class="panel form-card" style="text-align:center;">
          ${account.account.profile.photo ? `<img src="${escapeHtml(account.account.profile.photo)}" alt="" style="width:88px;height:88px;border-radius:18px;object-fit:cover;border:1px solid var(--border);margin-bottom:14px;">` : ''}
          <h2>You're in the queue for approval</h2>
          <p class="panel-sub" style="margin:0 auto;">The host for "${escapeHtml(roomInfo.name)}" needs to approve your registration before you're on the block. This page updates automatically.</p>
        </div>
      </div>
    `);
  }

  function renderPlayerLive(roomId, roomInfo, account) {
    const state = app.state;
    const me = state.players.find((p) => p.accountId === account.account.id);
    setSubtitle(`Your status — ${roomInfo.name} (Room ${roomId})`);
    setTopActions(`<button class="btn ghost" type="button" data-act="leave-room">Leave</button>`);

    if (!me) {
      mount(`<div class="center-page"><div class="panel form-card"><h2>Not found in this room</h2><p class="panel-sub">Your registration may have been removed by a room reset. You can register again from the landing page.</p></div></div>`);
      return;
    }

    const p = currentPlayer(state);
    const isOnTheBlock = p && p.id === me.id;
    let statusBlock;
    if (me.status === 'sold') {
      statusBlock = `<div class="notice" style="text-align:center;font-size:16px;">🎉 Sold to <strong>${escapeHtml(me.soldTo)}</strong> for <strong>${me.soldPrice}</strong></div>`;
    } else if (me.status === 'unsold') {
      statusBlock = `<div class="notice warn" style="text-align:center;">Went unsold this round — you may come back up later if the host runs a second pass.</div>`;
    } else if (isOnTheBlock) {
      statusBlock = `<div class="notice" style="text-align:center;font-size:16px;">🔥 You're on the block right now! Current bid: <strong>${state.highestBid || p.basePrice}</strong></div>`;
    } else {
      const posInQueue = state.queue.indexOf(me.id);
      statusBlock = `<div class="notice" style="text-align:center;">Waiting in the queue${posInQueue >= 0 ? ` — position ${posInQueue + 1} of ${state.queue.length}` : ''}.</div>`;
    }

    mount(`
      <div class="center-page">
        <div class="panel form-card" style="text-align:center;">
          ${me.image ? `<img src="${escapeHtml(me.image)}" alt="" style="width:96px;height:96px;border-radius:18px;object-fit:cover;border:1px solid var(--border);margin-bottom:14px;">` : ''}
          <h2 style="margin-bottom:4px;">${escapeHtml(me.name)}</h2>
          <p class="panel-sub" style="margin:0 auto 16px;">Tier ${escapeHtml(me.tier || '—')} · Base price ${me.basePrice} · ${escapeHtml(roomInfo.name)}</p>
          ${statusBlock}
        </div>
      </div>
    `);
  }

  // ---------------------------------------------------------------------
  // Create-room wizard
  // ---------------------------------------------------------------------
  async function fetchPresets() {
    if (app.presetsCache) return app.presetsCache;
    const { ok, data } = await apiGet('/api/presets');
    app.presetsCache = ok ? data : null;
    return app.presetsCache;
  }

  async function renderCreateRoom() {
    setSubtitle('Create a room');
    setTopActions('');
    mount(`<div class="center-page"><div class="panel form-card"><p class="muted">Loading form…</p></div></div>`);
    const presets = (await fetchPresets()) || {
      defaultConfig: { purse: 10000, basePrices: { A: 500, B: 400, C: 300 }, increments: { A: 50, B: 50, C: 50 }, teamSize: 10 },
      suggestedTeamNames: ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6'],
      roleCuts: { owner: 500, captain: 1000, icon: 1000 },
      sampleNamesFallback: [],
      bundledCsv: null,
    };

    const draft = {
      name: '',
      teamNames: presets.suggestedTeamNames.slice(0, 6),
      purse: presets.defaultConfig.purse,
      teamSize: presets.defaultConfig.teamSize,
      basePrices: { ...presets.defaultConfig.basePrices },
      increments: { ...presets.defaultConfig.increments },
      roleCuts: { ...presets.roleCuts },
      playersMode: 'list',
      csvText: '',
      listNames: [],
      hostPin: '',
      playerRegistrationMode: 'approval',
    };

    renderCreateForm(draft, presets);
  }

  function teamRowsHtml(teamNames) {
    return teamNames
      .map(
        (name, i) => `
      <div class="team-row">
        <input class="input" data-team-name-idx="${i}" value="${escapeHtml(name)}" placeholder="Team ${i + 1}">
        <button class="btn ghost" type="button" data-act="remove-team" data-idx="${i}" ${teamNames.length <= 2 ? 'disabled' : ''}>Remove</button>
      </div>`
      )
      .join('');
  }

  function renderCreateForm(draft, presets) {
    const tierRow = (label, key) => `
      <div class="grid-3">
        ${['A', 'B', 'C'].map((t) => `
          <div class="field">
            <label>${escapeHtml(label)} — Tier ${t}</label>
            <input class="input" type="number" min="0" data-${key}="${t}" value="${draft[key][t]}">
          </div>
        `).join('')}
      </div>`;

    mount(`
      <div class="center-page">
        <div class="panel form-card">
          <h2>Create a room</h2>
          <p class="panel-sub">Set up teams and players once — you'll get a Room ID and PINs to share with everyone.</p>

          <form id="createForm">
            <div class="form-section">
              <h3>Room basics</h3>
              <div class="field" style="margin-top:10px;">
                <label for="roomName">Room name</label>
                <input class="input" id="roomName" value="${escapeHtml(draft.name)}" placeholder="e.g. Friday Night Auction">
              </div>
              <div class="grid-2" style="margin-top:10px;">
                <div class="field">
                  <label for="hostPin">Host PIN (optional)</label>
                  <input class="input" id="hostPin" inputmode="numeric" placeholder="Leave blank to auto-generate" value="${escapeHtml(draft.hostPin)}">
                </div>
                <div class="field">
                  <label for="teamSize">Squad size per team</label>
                  <input class="input" id="teamSize" type="number" min="1" value="${draft.teamSize}">
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="space-between">
                <h3>Teams</h3>
                <div class="team-count-controls">
                  <button class="btn ghost" type="button" id="teamMinus">−</button>
                  <span class="count" id="teamCount">${draft.teamNames.length}</span>
                  <button class="btn ghost" type="button" id="teamPlus">+</button>
                </div>
              </div>
              <div id="teamRows">${teamRowsHtml(draft.teamNames)}</div>
              <p class="field-hint" style="margin-top:8px;">Each team gets its own auto-generated PIN after you create the room.</p>
            </div>

            <div class="form-section">
              <h3>Purse &amp; pricing</h3>
              <div class="field" style="margin-top:10px;max-width:260px;">
                <label for="teamPurse">Starting purse per team</label>
                <input class="input" id="teamPurse" type="number" min="0" value="${draft.purse}">
              </div>
              <div style="margin-top:14px;">${tierRow('Base price', 'basePrices')}</div>
              <div style="margin-top:14px;">${tierRow('Bid increment', 'increments')}</div>
              <details style="margin-top:14px;">
                <summary class="muted tiny" style="cursor:pointer;">Advanced: purse deducted for pre-assigned owner/captain/icon (only used if your CSV has those rows)</summary>
                <div class="grid-3" style="margin-top:10px;">
                  <div class="field"><label>Owner cut</label><input class="input" type="number" min="0" data-rolecut="owner" value="${draft.roleCuts.owner}"></div>
                  <div class="field"><label>Captain cut</label><input class="input" type="number" min="0" data-rolecut="captain" value="${draft.roleCuts.captain}"></div>
                  <div class="field"><label>Icon cut</label><input class="input" type="number" min="0" data-rolecut="icon" value="${draft.roleCuts.icon}"></div>
                </div>
              </details>
            </div>

            <div class="form-section">
              <h3>Players</h3>
              <div class="tab-row" style="margin-top:10px;">
                <button class="tab-btn ${draft.playersMode === 'list' ? 'active' : ''}" type="button" data-act="players-tab" data-mode="list">Quick list</button>
                <button class="tab-btn ${draft.playersMode === 'csv' ? 'active' : ''}" type="button" data-act="players-tab" data-mode="csv">Upload / paste CSV</button>
              </div>
              <div id="playersPane"></div>
            </div>

            <div class="form-section">
              <h3>Player self-registration</h3>
              <p class="field-hint" style="margin-top:10px;">Anyone with this room's <strong>Player PIN</strong> can submit their own profile (name, age, role, photo) to be added to the pool — no CSV needed for them. You'll get a Player PIN to share, separate from the host and team PINs. Tier, base price and everything else stays entirely in your control.</p>
              <div class="field" style="margin-top:10px;max-width:360px;">
                <label for="regMode">When someone registers</label>
                <select class="select" id="regMode">
                  <option value="approval" ${draft.playerRegistrationMode === 'approval' ? 'selected' : ''}>Hold for my approval (recommended)</option>
                  <option value="auto" ${draft.playerRegistrationMode === 'auto' ? 'selected' : ''}>Add them straight to the queue</option>
                </select>
              </div>
            </div>

            <div id="createError"></div>
            <div class="btns" style="margin-top:20px;">
              <button class="btn primary" type="submit">Create room</button>
              <button class="btn ghost" type="button" data-act="go-landing">Cancel</button>
            </div>
          </form>
        </div>
      </div>
    `);

    renderPlayersPane(draft, presets);
    wireCreateForm(draft, presets);
  }

  function renderPlayersPane(draft, presets) {
    const pane = $('#playersPane');
    if (!pane) return;
    if (draft.playersMode === 'csv') {
      pane.innerHTML = `
        <p class="field-hint">Columns: <code>name,role,tier,team</code> — role is Batter / Bowler / All-rounder, or Owner / Captain / Icon for a pre-assigned squad member (team = letter A, B, C… or the team's name).</p>
        <div class="row" style="margin:8px 0;">
          <label class="btn ghost" for="csvFile" style="margin:0;">Upload .csv file</label>
          <input type="file" id="csvFile" accept=".csv,text/csv" class="hidden">
          ${presets.bundledCsv ? `<button class="btn ghost" type="button" id="loadBundledCsv">Load ${escapeHtml(presets.bundledCsv.filename)}</button>` : ''}
        </div>
        <textarea class="textarea" id="csvText" rows="10" placeholder="name,role,tier,team">${escapeHtml(draft.csvText)}</textarea>
      `;
      const fileInput = $('#csvFile');
      fileInput && fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          draft.csvText = String(reader.result || '');
          $('#csvText').value = draft.csvText;
        };
        reader.readAsText(file);
      });
      const bundledBtn = $('#loadBundledCsv');
      bundledBtn && bundledBtn.addEventListener('click', () => {
        draft.csvText = presets.bundledCsv.text;
        $('#csvText').value = draft.csvText;
      });
      $('#csvText').addEventListener('input', (e) => { draft.csvText = e.target.value; });
    } else {
      pane.innerHTML = `
        <p class="field-hint">One player name per line. Tiers and roles are assigned automatically in rotation (A/B/C, Batter/Bowler/All-rounder) — edit them later from the host console.</p>
        ${presets.sampleNamesFallback && presets.sampleNamesFallback.length ? `<div class="row" style="margin-bottom:8px;"><button class="btn ghost" type="button" id="fillSampleNames">Fill with sample names</button></div>` : ''}
        <textarea class="textarea" id="listText" rows="10" placeholder="Player One&#10;Player Two&#10;Player Three">${escapeHtml((draft.listNames || []).join('\n'))}</textarea>
      `;
      $('#listText').addEventListener('input', (e) => {
        draft.listNames = e.target.value.split('\n');
      });
      const fillBtn = $('#fillSampleNames');
      fillBtn && fillBtn.addEventListener('click', () => {
        draft.listNames = presets.sampleNamesFallback.slice();
        $('#listText').value = draft.listNames.join('\n');
      });
    }
  }

  function wireCreateForm(draft, presets) {
    $('#teamRows').addEventListener('input', (e) => {
      const idx = e.target.getAttribute('data-team-name-idx');
      if (idx == null) return;
      draft.teamNames[Number(idx)] = e.target.value;
    });
    $('#teamRows').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="remove-team"]');
      if (!btn) return;
      const idx = Number(btn.getAttribute('data-idx'));
      if (draft.teamNames.length <= 2) return;
      draft.teamNames.splice(idx, 1);
      $('#teamRows').innerHTML = teamRowsHtml(draft.teamNames);
      $('#teamCount').textContent = draft.teamNames.length;
    });
    $('#teamPlus').addEventListener('click', () => {
      if (draft.teamNames.length >= 24) return;
      const n = draft.teamNames.length;
      draft.teamNames.push(presets.suggestedTeamNames[n] || `Team ${n + 1}`);
      $('#teamRows').innerHTML = teamRowsHtml(draft.teamNames);
      $('#teamCount').textContent = draft.teamNames.length;
    });
    $('#teamMinus').addEventListener('click', () => {
      if (draft.teamNames.length <= 2) return;
      draft.teamNames.pop();
      $('#teamRows').innerHTML = teamRowsHtml(draft.teamNames);
      $('#teamCount').textContent = draft.teamNames.length;
    });

    document.querySelectorAll('[data-act="players-tab"]').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        draft.playersMode = tabBtn.getAttribute('data-mode');
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === tabBtn));
        renderPlayersPane(draft, presets);
      });
    });
    const cancelBtn = document.querySelector('#createForm [data-act="go-landing"]');
    cancelBtn && cancelBtn.addEventListener('click', () => navigate({}));

    document.querySelectorAll('[data-basePrices]').forEach((el) => {
      el.addEventListener('input', () => { draft.basePrices[el.getAttribute('data-basePrices')] = Number(el.value); });
    });
    document.querySelectorAll('[data-increments]').forEach((el) => {
      el.addEventListener('input', () => { draft.increments[el.getAttribute('data-increments')] = Number(el.value); });
    });
    document.querySelectorAll('[data-rolecut]').forEach((el) => {
      el.addEventListener('input', () => { draft.roleCuts[el.getAttribute('data-rolecut')] = Number(el.value); });
    });

    $('#createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      draft.name = $('#roomName').value;
      draft.hostPin = $('#hostPin').value.trim();
      draft.teamSize = Number($('#teamSize').value);
      draft.purse = Number($('#teamPurse').value);
      draft.playerRegistrationMode = $('#regMode').value;

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';

      const body = {
        name: draft.name,
        teamNames: draft.teamNames,
        purse: draft.purse,
        teamSize: draft.teamSize,
        basePrices: draft.basePrices,
        increments: draft.increments,
        roleCuts: draft.roleCuts,
        playersMode: draft.playersMode,
        csvText: draft.csvText,
        listNames: draft.listNames,
        hostPin: draft.hostPin || undefined,
        playerRegistrationMode: draft.playerRegistrationMode,
      };
      const { ok, data } = await apiPost('/api/rooms', body);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create room';
      if (!ok) {
        $('#createError').innerHTML = `<div class="notice bad" style="margin-top:14px;">${escapeHtml(data.error || 'Could not create the room.')}</div>`;
        return;
      }
      saveSession(data.roomId, { role: 'host', token: data.hostToken });
      app.createDraft = data;
      navigate({ screen: 'created' });
    });
  }

  function renderRoomCreated(data) {
    if (!data) return renderLanding();
    setSubtitle('Room created');
    setTopActions('');
    const origin = location.origin;
    const viewLink = `${origin}/?roomId=${data.roomId}&screen=view`;
    const registerLink = `${origin}/?roomId=${data.roomId}&screen=register`;
    mount(`
      <div class="center-page">
        <div class="panel form-card">
          <h2>🎉 "${escapeHtml(data.name)}" is live</h2>
          <p class="panel-sub">Share the Room ID and each PIN with the right people. You can always re-open this list from "Share room" in the host console.</p>

          <div class="stack" style="align-items:center;margin:18px 0;">
            <p class="tiny muted" style="margin:0;text-transform:uppercase;letter-spacing:.1em;font-weight:700;">Room ID</p>
            <div class="room-id-chip">${escapeHtml(data.roomId)}</div>
          </div>

          <div class="copy-row" style="justify-content:center;margin-bottom:22px;">
            <button class="copy-btn" type="button" data-act="copy" data-copy="${escapeHtml(data.roomId)}">Copy Room ID</button>
            <button class="copy-btn" type="button" data-act="copy" data-copy="${escapeHtml(viewLink)}">Copy spectator link</button>
          </div>

          <div class="hr"></div>
          <div class="space-between">
            <strong>Host PIN</strong>
            <span class="pin-chip">${escapeHtml(data.hostPin)}</span>
          </div>
          <p class="field-hint">Only share this with whoever is running the auction.</p>

          <div class="hr"></div>
          <div class="space-between">
            <strong>Player PIN</strong>
            <span class="pin-chip">${escapeHtml(data.playerPin)}</span>
          </div>
          <p class="field-hint">Share this (or the <button class="copy-btn" type="button" data-act="copy" data-copy="${escapeHtml(registerLink)}" style="vertical-align:baseline;">registration link</button>) with anyone who wants to put themselves up for auction.</p>

          <div class="hr"></div>
          <strong>Team PINs</strong>
          <div class="table-wrap" style="max-height:340px;margin-top:10px;">
            <table class="share-table">
              <thead><tr><th>Team</th><th>PIN</th><th></th></tr></thead>
              <tbody>
                ${data.teams.map((t) => `
                  <tr>
                    <td>${escapeHtml(t.name)}</td>
                    <td class="pin-col">${escapeHtml(t.pin)}</td>
                    <td><button class="copy-btn" type="button" data-act="copy" data-copy="Room ${data.roomId} — PIN ${t.pin} (${escapeHtml(t.name)})">Copy</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="btns" style="margin-top:24px;">
            <button class="btn primary" type="button" data-act="enter-host">Continue to host console</button>
          </div>
        </div>
      </div>
    `);
  }

  // ---------------------------------------------------------------------
  // Room runtime shared by host / team screens (needs a valid session)
  // ---------------------------------------------------------------------
  function teardownWs() {
    if (app.wsReconnectTimer) clearTimeout(app.wsReconnectTimer);
    if (app.ws) {
      try { app.ws.onclose = null; app.ws.close(); } catch { /* ignore */ }
    }
    app.ws = null;
  }

  function wsUrl(roomId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws?roomId=${encodeURIComponent(roomId)}`;
  }

  function connectWs(roomId, onState) {
    try {
      app.ws = new WebSocket(wsUrl(roomId));
    } catch {
      app.wsReconnectTimer = setTimeout(() => connectWs(roomId, onState), 2000);
      return;
    }
    app.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state' && msg.state) onState(msg.state);
      } catch { /* ignore malformed frame */ }
    };
    app.ws.onclose = () => {
      app.wsReconnectTimer = setTimeout(() => connectWs(roomId, onState), 2000);
    };
    app.ws.onerror = () => { try { app.ws.close(); } catch { /* ignore */ } };
  }

  async function enterRoom(roomId, screen) {
    const session = loadSession(roomId);
    if (!session || !session.token || (screen === 'host' && session.role !== 'host') || (screen === 'team' && session.role !== 'team')) {
      return renderJoin(roomId, session ? 'That link needs a different role — please rejoin.' : 'Enter your PIN to continue.');
    }
    app.session = session;

    const infoRes = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/info`);
    if (!infoRes.ok) return renderJoin(roomId, 'That room no longer exists.');

    const stateRes = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/state`);
    if (!stateRes.ok) return renderJoin(roomId, 'Could not load the auction state.');
    app.state = stateRes.data.state;

    if (screen === 'host') renderHostConsole(roomId, infoRes.data.info);
    else renderTeamConsole(roomId, session);

    connectWs(roomId, (state) => {
      app.state = state;
      if (screen === 'host') renderHostConsole(roomId, infoRes.data.info, { keepPinsOpen: app._pinsOpen, keepSettingsOpen: app._settingsOpen, keepPlayersOpen: app._playersOpen });
      else renderTeamConsole(roomId, session);
    });
  }

  async function enterSpectator(roomId) {
    const infoRes = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/info`);
    if (!infoRes.ok) return renderJoin(roomId, 'That room no longer exists.');
    const stateRes = await apiGet(`/api/rooms/${encodeURIComponent(roomId)}/state`);
    if (!stateRes.ok) return renderJoin(roomId, 'Could not load the auction state.');
    app.state = stateRes.data.state;
    renderSpectator(roomId, infoRes.data.info);
    connectWs(roomId, (state) => {
      app.state = state;
      renderSpectator(roomId, infoRes.data.info);
    });
  }

  async function roomAction(roomId, action, payload) {
    const session = loadSession(roomId);
    const { ok, status, data } = await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/actions`, {
      token: session ? session.token : '',
      action,
      payload: payload || {},
    });
    if (!ok && status === 401) {
      clearSession(roomId);
      renderJoin(roomId, data.error || 'Your session expired — please rejoin.');
      return false;
    }
    if (!ok) {
      app.state = { ...app.state, message: data.error || 'Action failed.' };
      rerenderCurrentRoom();
      return false;
    }
    app.state = data.state;
    rerenderCurrentRoom();
    return true;
  }

  function rerenderCurrentRoom() {
    if (app.screen === 'host') renderHostConsole(app.roomId, app._roomInfo, { keepPinsOpen: app._pinsOpen, keepSettingsOpen: app._settingsOpen, keepPlayersOpen: app._playersOpen });
    else if (app.screen === 'team') renderTeamConsole(app.roomId, app.session);
    else if (app.screen === 'view') renderSpectator(app.roomId, app._roomInfo);
  }

  // ---------------------------------------------------------------------
  // Shared auction math (mirrors server/auctionLogic.js so the UI can
  // preview outcomes instantly; the server always re-validates).
  // ---------------------------------------------------------------------
  function currentPlayer(state) {
    return state.players.find((p) => p.id === state.currentPlayerId) || null;
  }
  function leadingTeam(state) {
    return state.teams.find((t) => t.id === state.highestTeamId) || null;
  }
  function inferIncrement(state, tier) {
    const inc = state.config && state.config.increments;
    return inc && inc[tier] != null ? inc[tier] : 1;
  }
  function nextBidAmount(state) {
    const p = currentPlayer(state);
    if (!p) return 0;
    return state.highestBid > 0 ? state.highestBid + inferIncrement(state, p.tier) : p.basePrice;
  }
  function minPurseReserveForFutureSlots(state, team, currentPlayerId) {
    const teamSize = state.config.teamSize;
    const slotsAfterThisWin = team.roster.length + 1;
    const stillNeeded = teamSize - slotsAfterThisWin;
    if (stillNeeded <= 0) return 0;
    const candidates = state.players
      .filter((pl) => pl.status !== 'sold' && pl.status !== 'retained' && pl.id !== currentPlayerId)
      .map((pl) => pl.basePrice)
      .sort((a, b) => a - b);
    if (candidates.length < stillNeeded) return Number.POSITIVE_INFINITY;
    return candidates.slice(0, stillNeeded).reduce((s, x) => s + x, 0);
  }
  function maxAffordableBid(state, team) {
    const p = currentPlayer(state);
    if (!p) return 0;
    const reserve = minPurseReserveForFutureSlots(state, team, p.id);
    if (!Number.isFinite(reserve)) return 0;
    return Math.max(0, team.purse - reserve);
  }
  function rosterRoleParen(role) {
    const r = String(role || '').trim();
    return r ? ` <span class="muted tiny">(${escapeHtml(r.toLowerCase())})</span>` : '';
  }
  function teamOwnerStatus(state, team) {
    const p = currentPlayer(state);
    const size = state.config.teamSize;
    const slots = team.roster.length;
    const cap = p ? maxAffordableBid(state, team) : 0;
    const nextAmt = nextBidAmount(state);
    const lastBidderBlocked = state.highestBid > 0 && state.highestTeamId === team.id;

    if (slots >= size) return { mod: 'team-card-v2--full', chip: 'team-chip--full', label: 'Squad complete', hint: `All ${size} slots filled — this team cannot bid anymore.` };
    if (state.phase === 'complete') return { mod: 'team-card-v2--wait', chip: 'team-chip--idle', label: 'Auction over', hint: 'This auction has finished.' };
    if (!p) return { mod: 'team-card-v2--wait', chip: 'team-chip--idle', label: 'No lot selected', hint: 'When a player is on the block, your purse and max bid show here.' };
    if (state.phase === 'paused') return { mod: 'team-card-v2--wait', chip: 'team-chip--idle', label: 'Paused', hint: 'Bidding is frozen until the host resumes.' };
    if (state.phase === 'setup') return { mod: 'team-card-v2--wait', chip: 'team-chip--idle', label: 'Not started', hint: 'Start the auction to enable bidding.' };
    if (state.phase !== 'running') return { mod: 'team-card-v2--wait', chip: 'team-chip--idle', label: 'Waiting', hint: '' };
    if (lastBidderBlocked) return { mod: 'team-card-v2--leading', chip: 'team-chip--leading', label: 'You lead — wait', hint: 'Another team must bid before you can raise again.' };
    if (team.purse < nextAmt) return { mod: 'team-card-v2--capped', chip: 'team-chip--capped', label: 'Low purse', hint: `Next bid is ${nextAmt}; you have ${team.purse} remaining.` };
    if (nextAmt > cap) {
      const need = size - slots - 1;
      return { mod: 'team-card-v2--capped', chip: 'team-chip--capped', label: 'Purse reserved', hint: cap === 0 ? 'Not enough unsold players left at low prices to fill your remaining squad safely.' : `Keep ${need} slot(s) in mind — max you can bid here is ${cap}.` };
    }
    return { mod: 'team-card-v2--canbid', chip: 'team-chip--canbid', label: 'Can bid', hint: `You may bid up to ${cap} on this player.` };
  }

  function teamStripHtml(state, { withRosterOnly } = {}) {
    return state.teams
      .map((team, idx) => {
        const cap = maxAffordableBid(state, team);
        const p = currentPlayer(state);
        const maxLabel = p ? cap : '—';
        const st = teamOwnerStatus(state, team);
        const size = state.config.teamSize;
        const slots = team.roster.length;
        const rosterInner = team.roster.length === 0
          ? '<div class="team-strip-roster__empty">No players signed yet</div>'
          : team.roster.map((pl) => `
            <div class="team-strip-roster__row">
              ${pl.image ? `<img class="team-strip-roster__pic" src="${escapeHtml(pl.image)}" alt="">` : ''}
              <span class="team-strip-roster__nm">${escapeHtml(pl.name)}${rosterRoleParen(pl.role)}</span>
              <span class="team-strip-roster__pr">${pl.soldPrice}</span>
            </div>
          `).join('');
        const paletteStyle = teamPaletteVarsByIndex(idx);
        return `
        <div class="team-strip-card team-colorized ${st.mod}" style="${paletteStyle}" title="${escapeHtml(st.hint || team.name)}">
          <div class="team-strip-card__name">${escapeHtml(team.name)}</div>
          <span class="team-chip ${st.chip}">${escapeHtml(st.label)}</span>
          ${withRosterOnly ? '' : `
          <div class="team-strip-card__row"><span>Purse</span><strong>${team.purse}</strong></div>
          <div class="team-strip-card__row"><span>Max bid</span><strong>${maxLabel}</strong></div>
          <div class="team-strip-card__row"><span>Squad</span><strong>${slots}/${size}</strong></div>`}
          <div class="team-strip-roster">
            <p class="team-strip-roster__label">Signed squad</p>
            <div class="team-strip-roster__scroll">${rosterInner}</div>
          </div>
        </div>`;
      })
      .join('');
  }

  function currentPlayerBlockHtml(state, { bidLabel } = {}) {
    const p = currentPlayer(state);
    const leading = leadingTeam(state);
    return `
      <div class="space-between" style="align-items:flex-start;margin-bottom:10px;">
        <h3 style="margin:0;font-size:16px;">On the block</h3>
        <div class="tags">
          ${leading ? `<span class="tag good">Leading: ${escapeHtml(leading.name)}</span>` : ''}
          ${p ? `<span class="tag ${p.status === 'unsold' ? 'warn' : p.status === 'sold' ? 'good' : ''}">${p.status.toUpperCase()}</span>` : ''}
          ${!p ? '<span class="tag">No player</span>' : ''}
        </div>
      </div>
      <div class="player-head" style="margin-top:0;">
        <div class="stack" style="gap:8px;align-items:stretch;">
          <div class="avatar">${p ? (p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}">` : '<span class="muted tiny" style="padding:12px;text-align:center;">Player</span>') : '<span class="muted tiny">—</span>'}</div>
        </div>
        <div>
          <h3 class="player-name">${p ? escapeHtml(p.name) : 'No player selected'}</h3>
          ${p && p.status !== 'retained' ? `
          <div class="player-block-hero" aria-label="Tier and role">
            <div class="player-block-pill player-block-pill--tier"><span class="player-block-pill__label">Tier</span><span class="player-block-pill__value">${escapeHtml(p.tier || '—')}</span></div>
            <div class="player-block-pill player-block-pill--role"><span class="player-block-pill__label">Role</span><span class="player-block-pill__value">${escapeHtml(p.role || '—')}</span></div>
          </div>` : p ? '<p class="muted tiny" style="margin-top:8px;">Retained — not on auction.</p>' : ''}
          <div class="muted tiny" style="margin-top:8px;">Base ${p ? p.basePrice : '-'} • Increment ${p ? inferIncrement(state, p.tier) : '-'}</div>
          <div class="kpis">
            <div class="kpi"><div class="l">Base</div><div class="v">${p ? p.basePrice : '-'}</div></div>
            <div class="kpi"><div class="l">Current bid</div><div class="v">${state.highestBid || '-'}</div></div>
            <div class="kpi"><div class="l">Increment</div><div class="v">${p ? inferIncrement(state, p.tier) : '-'}</div></div>
          </div>
          ${bidLabel || ''}
        </div>
      </div>
    `;
  }

  function bidLogHtml(entries, emptyText) {
    return entries.map((b) => `
      <div class="log-entry">
        <div class="log-entry__main"><strong>${escapeHtml(b.teamName)}</strong><span class="muted tiny">${escapeHtml(b.playerName)}</span></div>
        <span class="log-entry__amt">${b.amount}</span>
      </div>
    `).join('') || `<div class="muted" style="padding:8px 0;">${escapeHtml(emptyText)}</div>`;
  }

  // ---------------------------------------------------------------------
  // Host console
  // ---------------------------------------------------------------------
  function renderHostConsole(roomId, roomInfo, opts = {}) {
    app.roomId = roomId;
    app.screen = 'host';
    app._roomInfo = roomInfo;
    const state = app.state;
    setSubtitle(`Auctioneer — ${roomInfo ? roomInfo.name : roomId} (Room ${roomId})`);
    setTopActions(`<button class="btn ghost" type="button" data-act="leave-room">Leave console</button>`);

    mount(`
      <div class="auction-page">
        <div class="row space-between" style="align-items:flex-start;">
          <div class="notice" style="flex:1;min-width:260px;">Room ID <strong>${escapeHtml(roomId)}</strong> — share it with the Room ID + PIN with your teams and spectators.</div>
          <div class="row" style="gap:8px;">
            <button class="btn ghost" type="button" data-act="toggle-settings">Room settings</button>
            <button class="btn ghost" type="button" data-act="toggle-players">Manage players</button>
            <button class="btn ghost" type="button" data-act="toggle-pins">Share room</button>
          </div>
        </div>
        <div id="settingsPanel"></div>
        <div id="playersPanel"></div>
        <div id="pinsPanel"></div>

        <div class="team-strip-wrap">
          <p class="team-strip-wrap__title">Team status</p>
          <div class="team-strip">${teamStripHtml(state)}</div>
        </div>

        <div class="auction-two-col">
          <div class="panel current-list-panel">
            <h2 style="margin:0 0 4px;">Current player</h2>
            <div class="current-list__msg">${escapeHtml(state.message)}</div>
            <div class="current-list-scroll">
              ${currentPlayerBlockHtml(state, {
                bidLabel: `
                <div class="btns">
                  <button class="btn primary" data-act="start">Start</button>
                  <button class="btn ghost" data-act="pause">${state.phase === 'paused' ? 'Resume' : 'Pause'}</button>
                  <button class="btn ghost" data-act="undo">Undo</button>
                  <button class="btn ghost" data-act="skip">Skip</button>
                  <button class="btn good" data-act="sell" ${!currentPlayer(state) || !state.highestTeamId || !state.highestBid ? 'disabled' : ''}>Mark Sold</button>
                  <button class="btn warn" data-act="unsold" ${!currentPlayer(state) ? 'disabled' : ''}>Mark Unsold</button>
                  <button class="btn red" data-act="reset">Reset auction</button>
                </div>`,
              })}
            </div>
          </div>

          <div class="auction-bids-row">
            <div class="panel bid-zone">
              <div class="space-between" style="align-items:flex-start;">
                <h2 style="margin:0">Live bidding</h2>
                <span class="bid-pill" title="Amount for the next valid bid">Next: ${currentPlayer(state) ? nextBidAmount(state) : '—'}</span>
              </div>
              <p class="panel-sub" style="margin-top:10px;margin-bottom:0">Teams place bids from their own room links (Room ID + their PIN). This screen updates automatically.</p>
            </div>
            <div class="panel bid-log-panel">
              <div class="space-between" style="flex-shrink:0;"><h2 style="margin:0">Bid log</h2><span class="badge">${state.bidHistory.length}</span></div>
              <div class="hr"></div>
              <div class="log-scroll">${bidLogHtml(state.bidHistory, 'No bids on this player yet.')}</div>
            </div>
          </div>
        </div>
      </div>
    `);

    if (opts.keepPinsOpen) renderPinsPanel(roomId);
    if (opts.keepSettingsOpen) renderSettingsPanel(roomId);
    if (opts.keepPlayersOpen) renderPlayersPanel(roomId);
  }

  function renderSettingsPanel(roomId) {
    app._settingsOpen = true;
    const panel = $('#settingsPanel');
    if (!panel) return;
    const state = app.state;
    const config = state.config;

    panel.innerHTML = `
      <div class="panel" style="margin-top:14px;">
        <div class="space-between"><h2 style="margin:0">Room settings</h2><button class="btn ghost" type="button" data-act="toggle-settings">Close</button></div>
        <p class="field-hint" style="margin-top:4px;">Changes apply to this room immediately and everyone connected sees them live.</p>
        <div class="hr"></div>

        <h3 style="margin:0 0 8px;">Squad size</h3>
        <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="max-width:160px;">
            <label for="cfgTeamSize">Players per team</label>
            <input class="input" id="cfgTeamSize" type="number" min="1" value="${config.teamSize}">
          </div>
          <button class="btn ghost" type="button" data-act="save-team-size">Save</button>
        </div>

        <div class="hr"></div>
        <h3 style="margin:0 0 8px;">Purse — all teams</h3>
        <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="max-width:200px;">
            <label for="cfgPurseAll">Starting purse per team</label>
            <input class="input" id="cfgPurseAll" type="number" min="0" value="${config.purse}">
          </div>
          <button class="btn warn" type="button" data-act="save-purse-all">Apply to all teams</button>
        </div>
        <p class="field-hint">This overwrites every team's current purse — use it for a correction before bidding gets underway, not mid-auction.</p>

        <div class="hr"></div>
        <h3 style="margin:0 0 8px;">Tier base prices &amp; increments</h3>
        <div class="table-wrap">
          <table class="share-table">
            <thead><tr><th>Tier</th><th>Base price</th><th>Bid increment</th><th></th></tr></thead>
            <tbody>
              ${TIERS.map((t) => `
                <tr>
                  <td>Tier ${t}</td>
                  <td><input class="input" style="max-width:120px;" type="number" min="0" id="cfgBase-${t}" value="${config.basePrices[t]}"></td>
                  <td><input class="input" style="max-width:120px;" type="number" min="0" id="cfgInc-${t}" value="${config.increments[t]}"></td>
                  <td><button class="btn ghost" type="button" data-act="save-tier" data-tier="${t}">Save</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p class="field-hint">Changing a tier's base price updates every player still at that tier who hasn't been sold yet.</p>

        <div class="hr"></div>
        <h3 style="margin:0 0 8px;">Teams</h3>
        <div class="table-wrap">
          <table class="share-table">
            <thead><tr><th>Name</th><th>Purse</th><th></th></tr></thead>
            <tbody>
              ${state.teams.map((t) => `
                <tr>
                  <td><input class="input" id="cfgTeamName-${t.id}" value="${escapeHtml(t.name)}"></td>
                  <td><input class="input" style="max-width:140px;" type="number" min="0" id="cfgTeamPurse-${t.id}" value="${t.purse}"></td>
                  <td><button class="btn ghost" type="button" data-act="save-team-row" data-team="${t.id}">Save</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p class="field-hint">Editing a team's purse here only changes that one team — it won't touch anyone else's.</p>
      </div>
    `;
  }

  function renderPlayersPanel(roomId) {
    app._playersOpen = true;
    const panel = $('#playersPanel');
    if (!panel) return;
    const state = app.state;
    const byId = new Map(state.players.map((p) => [p.id, p]));
    const pending = state.queue.map((id) => byId.get(id)).filter(Boolean);
    const retained = state.players.filter((p) => p.status === 'retained');
    const teamOptions = state.teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');

    const poolRows = pending.map((p, idx) => `
      <tr data-player-row="${p.id}">
        <td>
          <div class="row" style="gap:2px;flex-direction:column;">
            <button class="btn ghost" type="button" style="padding:2px 8px;" data-act="move-player-up" data-player="${p.id}" ${idx === 0 ? 'disabled' : ''}>&uarr;</button>
            <button class="btn ghost" type="button" style="padding:2px 8px;" data-act="move-player-down" data-player="${p.id}" ${idx === pending.length - 1 ? 'disabled' : ''}>&darr;</button>
          </div>
        </td>
        <td>${idx + 1}</td>
        <td>${p.image ? `<img src="${escapeHtml(p.image)}" alt="" style="width:32px;height:32px;border-radius:8px;object-fit:cover;">` : ''} ${escapeHtml(p.name)}${p.age ? ` <span class="muted tiny">(${p.age})</span>` : ''}</td>
        <td>
          <select class="select" style="width:auto;padding:6px 8px;" data-player-field="role" data-player="${p.id}">
            ${PLAYING_ROLES.map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="select" style="width:auto;padding:6px 8px;" data-player-field="tier" data-player="${p.id}">
            ${TIERS.map((t) => `<option value="${t}" ${p.tier === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </td>
        <td><input class="input" style="max-width:110px;" type="number" min="0" data-player-field="basePrice" data-player="${p.id}" value="${p.basePrice}"></td>
        <td><button class="btn ghost" type="button" data-act="save-player" data-player="${p.id}">Save</button></td>
        <td>
          <div class="row" style="gap:4px;">
            <select class="select" style="width:auto;padding:6px 8px;" data-retain-team="${p.id}">${teamOptions}</select>
            <select class="select" style="width:auto;padding:6px 8px;" data-retain-role="${p.id}">
              ${RETAIN_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}
            </select>
            <button class="btn ghost" type="button" data-act="retain-player" data-player="${p.id}">Assign</button>
          </div>
        </td>
      </tr>
    `).join('');

    const retainedRows = retained.map((p) => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.role)}</td>
        <td>${escapeHtml(p.soldTo)}</td>
        <td>${p.soldPrice}</td>
        <td><button class="btn ghost" type="button" data-act="unretain-player" data-player="${p.id}">Return to pool</button></td>
      </tr>
    `).join('');

    panel.innerHTML = `
      <div class="panel" style="margin-top:14px;">
        <div class="space-between"><h2 style="margin:0">Manage players</h2><button class="btn ghost" type="button" data-act="toggle-players">Close</button></div>
        <p class="field-hint" style="margin-top:4px;">Reorder the queue, fix a player's role/tier/base price, or pre-assign an owner, captain, or icon before the auction starts.</p>
        <div class="hr"></div>
        <h3 style="margin:0 0 8px;">Auction pool (${pending.length})</h3>
        <div class="table-wrap" style="max-height:420px;">
          <table class="share-table">
            <thead><tr><th></th><th>#</th><th>Name</th><th>Role</th><th>Tier</th><th>Base price</th><th></th><th>Pre-assign to a team</th></tr></thead>
            <tbody>${poolRows || `<tr><td colspan="8" class="muted tiny">No players waiting in the pool.</td></tr>`}</tbody>
          </table>
        </div>
        <p class="field-hint">Reordering only jumps the "on the block" player before the auction has started; mid-auction it just changes who's up next.</p>

        <div class="hr"></div>
        <h3 style="margin:0 0 8px;">Pre-assigned to teams (${retained.length})</h3>
        <div class="table-wrap" style="max-height:280px;">
          <table class="share-table">
            <thead><tr><th>Name</th><th>Role</th><th>Team</th><th>Purse cut</th><th></th></tr></thead>
            <tbody>${retainedRows || `<tr><td colspan="5" class="muted tiny">No owners, captains, or icons assigned yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  async function renderPinsPanel(roomId) {
    app._pinsOpen = true;
    const panel = $('#pinsPanel');
    if (!panel) return;
    const session = loadSession(roomId);
    const [pinsRes, pendingRes] = await Promise.all([
      apiGet(`/api/rooms/${encodeURIComponent(roomId)}/host/pins?token=${encodeURIComponent(session.token)}`),
      apiGet(`/api/rooms/${encodeURIComponent(roomId)}/host/pending?token=${encodeURIComponent(session.token)}`),
    ]);
    if (!pinsRes.ok) {
      panel.innerHTML = `<div class="notice bad" style="margin-top:14px;">${escapeHtml(pinsRes.data.error || 'Could not load PINs.')}</div>`;
      return;
    }
    const data = pinsRes.data;
    const pending = pendingRes.ok ? pendingRes.data.pending : [];
    const viewLink = `${location.origin}/?roomId=${roomId}&screen=view`;
    const registerLink = `${location.origin}/?roomId=${roomId}&screen=register`;
    const mode = data.settings ? data.settings.playerRegistrationMode : 'approval';

    const pendingHtml = pending.length
      ? pending.map((p) => `
        <div class="recent-room-row" style="align-items:center;">
          <div class="row" style="gap:10px;align-items:center;">
            ${p.photo ? `<img src="${escapeHtml(p.photo)}" alt="" style="width:40px;height:40px;border-radius:10px;object-fit:cover;">` : ''}
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              <div class="muted tiny">${[p.age ? `${p.age} yrs` : '', p.role].filter(Boolean).join(' · ') || 'No details given'}</div>
            </div>
          </div>
          <div class="row" style="gap:6px;">
            <select class="select" style="width:auto;padding:8px 10px;" data-pending-tier="${p.id}">
              ${TIERS.map((t) => `<option value="${t}" ${t === 'C' ? 'selected' : ''}>Tier ${t}</option>`).join('')}
            </select>
            <button class="btn good" type="button" data-act="approve-player" data-pending-id="${p.id}">Approve</button>
            <button class="btn ghost" type="button" data-act="reject-player" data-pending-id="${p.id}">Reject</button>
          </div>
        </div>
      `).join('')
      : '<p class="muted tiny" style="padding:4px 0;">No one is waiting for approval right now.</p>';

    panel.innerHTML = `
      <div class="panel" style="margin-top:14px;">
        <div class="space-between"><h2 style="margin:0">Share this room</h2><button class="btn ghost" type="button" data-act="toggle-pins">Close</button></div>
        <div class="hr"></div>
        <div class="space-between">
          <div><strong>Host PIN</strong><div class="pin-chip" style="margin-top:6px;">${escapeHtml(data.hostPin)}</div></div>
          <button class="copy-btn" type="button" data-act="copy" data-copy="${escapeHtml(data.hostPin)}">Copy</button>
          <button class="btn ghost" type="button" data-act="regen-pin" data-target="host">Regenerate</button>
        </div>
        <div class="hr"></div>
        <div class="table-wrap" style="max-height:320px;">
          <table class="share-table">
            <thead><tr><th>Team</th><th>PIN</th><th></th></tr></thead>
            <tbody>
              ${data.teams.map((t) => `
                <tr>
                  <td>${escapeHtml(t.name)}</td>
                  <td class="pin-col">${escapeHtml(t.pin)}</td>
                  <td class="row" style="gap:6px;">
                    <button class="copy-btn" type="button" data-act="copy" data-copy="Room ${roomId} — PIN ${t.pin} (${escapeHtml(t.name)})">Copy</button>
                    <button class="btn ghost" type="button" data-act="regen-pin" data-target="${t.teamId}">Regenerate</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="hr"></div>
        <div class="copy-row">
          <span class="tiny muted">Spectator link (no PIN needed):</span>
          <button class="copy-btn" type="button" data-act="copy" data-copy="${escapeHtml(viewLink)}">Copy spectator link</button>
        </div>
        <p class="field-hint" style="margin-top:10px;">Regenerating a PIN immediately signs out anyone using the old one.</p>

        <div class="hr"></div>
        <div class="space-between">
          <div><strong>Player PIN</strong><div class="pin-chip" style="margin-top:6px;">${escapeHtml(data.playerPin)}</div></div>
          <button class="copy-btn" type="button" data-act="copy" data-copy="${escapeHtml(data.playerPin)}">Copy</button>
          <button class="btn ghost" type="button" data-act="regen-pin" data-target="player">Regenerate</button>
        </div>
        <div class="copy-row" style="margin-top:8px;">
          <span class="tiny muted">Registration link:</span>
          <button class="copy-btn" type="button" data-act="copy" data-copy="${escapeHtml(registerLink)}">Copy registration link</button>
        </div>
        <div class="field" style="margin-top:12px;max-width:360px;">
          <label for="hostRegMode">When someone registers with this PIN</label>
          <select class="select" id="hostRegMode">
            <option value="approval" ${mode === 'approval' ? 'selected' : ''}>Hold for my approval</option>
            <option value="auto" ${mode === 'auto' ? 'selected' : ''}>Add them straight to the queue</option>
          </select>
        </div>

        <div class="hr"></div>
        <div class="space-between" style="flex-shrink:0;"><strong>Pending player registrations</strong><span class="badge">${pending.length}</span></div>
        <div class="stack" style="gap:8px;margin-top:10px;">${pendingHtml}</div>
      </div>
    `;

    const modeSelect = $('#hostRegMode');
    modeSelect && modeSelect.addEventListener('change', async () => {
      await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/host/registration-mode`, {
        token: session.token,
        mode: modeSelect.value,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Team console
  // ---------------------------------------------------------------------
  function renderTeamConsole(roomId, session) {
    app.roomId = roomId;
    app.screen = 'team';
    app.session = session;
    const state = app.state;
    const team = state.teams.find((t) => t.id === session.teamId);
    setSubtitle(`Team — ${team ? team.name : session.teamName || session.teamId} (Room ${roomId})`);
    setTopActions(`<button class="btn ghost" type="button" data-act="leave-room">Leave</button>`);

    if (!team) {
      mount(`<div class="auction-page"><div class="panel"><h2 style="margin-top:0">Team not found</h2><p class="panel-sub">This room no longer has your team. Ask the host for a fresh PIN.</p></div></div>`);
      return;
    }

    const idx = state.teams.findIndex((t) => t.id === team.id);
    const p = currentPlayer(state);
    const st = teamOwnerStatus(state, team);
    const cap = maxAffordableBid(state, team);
    const nextAmt = nextBidAmount(state);
    const lastBidderBlocked = state.highestBid > 0 && state.highestTeamId === team.id;
    const canBid = state.phase === 'running' && p && team.roster.length < state.config.teamSize && nextAmt > 0 && nextAmt <= cap && team.purse >= nextAmt && !lastBidderBlocked;
    const maxShow = p ? cap : '—';
    const paletteStyle = teamPaletteVarsByIndex(idx);
    const logSlice = p ? state.bidHistory.filter((b) => b.playerId === p.id) : state.bidHistory;

    mount(`
      <div class="auction-page">
        <div class="team-strip-wrap">
          <p class="team-strip-wrap__title">Your team</p>
          <div class="team-strip" style="grid-template-columns:minmax(0,1fr);max-width:420px;">
            ${teamStripHtml({ ...state, teams: [team] }).replace(`style="${teamPaletteVarsByIndex(0)}"`, `style="${paletteStyle}"`)}
          </div>
        </div>

        <div class="auction-two-col">
          <div class="panel current-list-panel">
            <h2 style="margin:0 0 4px;">Current player</h2>
            <div class="current-list__msg">${escapeHtml(state.message)}</div>
            <div class="current-list-scroll">${currentPlayerBlockHtml(state)}</div>
          </div>

          <div class="auction-bids-row">
            <div class="panel bid-zone">
              <div class="space-between" style="align-items:flex-start;">
                <h2 style="margin:0">Place your bid</h2>
                <span class="bid-pill" title="Amount for the next valid bid">Next: ${p ? nextAmt : '—'}</span>
              </div>
              <div class="hr"></div>
              <div class="panel-fill" style="flex:1;min-height:0;overflow-y:auto;">
                <button type="button" class="btn team-bid-btn ${state.highestTeamId === team.id ? 'primary' : 'ghost'}" style="${paletteStyle};width:100%;justify-content:center;" data-act="bid-next" ${canBid ? '' : 'disabled'}>${escapeHtml(team.name)} — bid ${p ? nextAmt : '—'} <span class="tiny muted">(max ${maxShow})</span></button>
                <div class="row" style="margin-top:12px;align-items:flex-end;">
                  <div style="flex:1;min-width:120px;">
                    <div class="tiny muted">Custom amount</div>
                    <input class="input" type="text" inputmode="numeric" id="teamCustomBid" placeholder="Amount" autocomplete="off">
                  </div>
                  <button type="button" class="btn ghost" data-act="bid-custom">Bid</button>
                </div>
                <p class="muted tiny" style="margin-top:12px;margin-bottom:0;line-height:1.45">${escapeHtml(st.hint || '')}</p>
              </div>
            </div>
            <div class="panel bid-log-panel">
              <div class="space-between" style="flex-shrink:0;"><h2 style="margin:0">${p ? 'Bids on this player' : 'Recent bids'}</h2><span class="badge">${logSlice.length}</span></div>
              <div class="hr"></div>
              <div class="log-scroll">${bidLogHtml(logSlice, 'No bids yet.')}</div>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  // ---------------------------------------------------------------------
  // Spectator (read-only, big-screen friendly)
  // ---------------------------------------------------------------------
  function renderSpectator(roomId, roomInfo) {
    app.roomId = roomId;
    app.screen = 'view';
    app._roomInfo = roomInfo;
    const state = app.state;
    setSubtitle(`Watching — ${roomInfo ? roomInfo.name : roomId} (Room ${roomId})`);
    setTopActions(`<span class="badge spectator-badge">Spectator</span> <button class="btn ghost" type="button" data-act="leave-room">Leave</button>`);

    mount(`
      <div class="auction-page">
        <div class="team-strip-wrap">
          <p class="team-strip-wrap__title">Team status</p>
          <div class="team-strip">${teamStripHtml(state)}</div>
        </div>
        <div class="auction-two-col">
          <div class="panel current-list-panel">
            <h2 style="margin:0 0 4px;">Current player</h2>
            <div class="current-list__msg">${escapeHtml(state.message)}</div>
            <div class="current-list-scroll">${currentPlayerBlockHtml(state)}</div>
          </div>
          <div class="panel bid-log-panel">
            <div class="space-between" style="flex-shrink:0;"><h2 style="margin:0">Bid log</h2><span class="badge">${state.bidHistory.length}</span></div>
            <div class="hr"></div>
            <div class="log-scroll">${bidLogHtml(state.bidHistory, 'No bids on this player yet.')}</div>
          </div>
        </div>
      </div>
    `);
  }

  // ---------------------------------------------------------------------
  // Single, permanent click delegation for the whole app. Screens are
  // re-rendered often (every WebSocket state push on host/team/view), so any
  // listener attached to a persistent container (#mainArea, #topActions,
  // document) must be registered exactly once here — never inside a render
  // function — or it would stack a duplicate handler on every update.
  // ---------------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="go-create"]')) return navigate({ screen: 'create' });
    if (e.target.closest('[data-act="go-join"]')) return navigate({ screen: 'join' });
    if (e.target.closest('[data-act="go-register"]')) return navigate({ screen: 'register' });
    if (e.target.closest('[data-act="go-login"]')) return navigate({ screen: 'login' });
    if (e.target.closest('[data-act="go-signup"]')) return navigate({ screen: 'signup' });
    if (e.target.closest('[data-act="account-logout"]')) {
      clearAccount();
      return navigate({});
    }
    const registerFromJoin = e.target.closest('[data-act="go-register-from-join"]');
    if (registerFromJoin) {
      const roomIdInput = $('#joinRoomId');
      const roomId = roomIdInput ? roomIdInput.value.trim().toUpperCase() : '';
      return navigate({ roomId, screen: 'register' });
    }
    const openRecent = e.target.closest('[data-act="open-recent"]');
    if (openRecent) {
      const roomId = openRecent.getAttribute('data-room');
      const role = openRecent.getAttribute('data-role');
      return navigate({ roomId, screen: role === 'host' ? 'host' : 'team' });
    }

    if (e.target.closest('[data-act="watch-only"]')) {
      const roomIdInput = $('#joinRoomId');
      const roomId = roomIdInput ? roomIdInput.value.trim().toUpperCase() : '';
      if (!roomId) return renderJoin(roomId, 'Enter a Room ID to watch.');
      return navigate({ roomId, screen: 'view' });
    }

    if (e.target.closest('[data-act="enter-host"]')) {
      const draft = app.createDraft;
      if (draft) return navigate({ roomId: draft.roomId, screen: 'host' });
    }

    const copyBtn = e.target.closest('[data-act="copy"]');
    if (copyBtn) return copyToClipboard(copyBtn.getAttribute('data-copy'), copyBtn);

    if (e.target.closest('[data-act="leave-room"]')) return navigate({});

    // --- Host console ---
    if (app.screen === 'host') {
      const roomId = app.roomId;
      if (e.target.closest('[data-act="toggle-pins"]')) {
        if (app._pinsOpen) {
          app._pinsOpen = false;
          teardownPoll();
          const panel = $('#pinsPanel');
          if (panel) panel.innerHTML = '';
        } else {
          renderPinsPanel(roomId);
          teardownPoll();
          app.pollTimer = setInterval(() => renderPinsPanel(roomId), 6000);
        }
        return;
      }
      if (e.target.closest('[data-act="toggle-settings"]')) {
        if (app._settingsOpen) {
          app._settingsOpen = false;
          const panel = $('#settingsPanel');
          if (panel) panel.innerHTML = '';
        } else {
          renderSettingsPanel(roomId);
        }
        return;
      }
      if (e.target.closest('[data-act="toggle-players"]')) {
        if (app._playersOpen) {
          app._playersOpen = false;
          const panel = $('#playersPanel');
          if (panel) panel.innerHTML = '';
        } else {
          renderPlayersPanel(roomId);
        }
        return;
      }
      if (e.target.closest('[data-act="save-team-size"]')) {
        const input = $('#cfgTeamSize');
        const teamSize = Number(input ? input.value : NaN);
        if (!Number.isFinite(teamSize) || teamSize <= 0) return;
        await roomAction(roomId, 'setTeamSize', { teamSize });
        return renderSettingsPanel(roomId);
      }
      if (e.target.closest('[data-act="save-purse-all"]')) {
        const input = $('#cfgPurseAll');
        const purse = Number(input ? input.value : NaN);
        if (!Number.isFinite(purse) || purse < 0) return;
        if (!confirm("Apply this purse to every team? This overwrites each team's current purse, even mid-auction.")) return;
        await roomAction(roomId, 'updateConfigPurse', { purse });
        return renderSettingsPanel(roomId);
      }
      const saveTierBtn = e.target.closest('[data-act="save-tier"]');
      if (saveTierBtn) {
        const tier = saveTierBtn.getAttribute('data-tier');
        const baseInput = $(`#cfgBase-${tier}`);
        const incInput = $(`#cfgInc-${tier}`);
        const base = Number(baseInput ? baseInput.value : NaN);
        const inc = Number(incInput ? incInput.value : NaN);
        if (Number.isFinite(base)) await roomAction(roomId, 'setBaseTier', { tier, value: base });
        if (Number.isFinite(inc)) await roomAction(roomId, 'setIncTier', { tier, value: inc });
        return renderSettingsPanel(roomId);
      }
      const saveTeamRowBtn = e.target.closest('[data-act="save-team-row"]');
      if (saveTeamRowBtn) {
        const teamId = saveTeamRowBtn.getAttribute('data-team');
        const nameInput = $(`#cfgTeamName-${teamId}`);
        const purseInput = $(`#cfgTeamPurse-${teamId}`);
        const name = nameInput ? nameInput.value.trim() : '';
        const purse = Number(purseInput ? purseInput.value : NaN);
        if (name) await roomAction(roomId, 'setTeamName', { teamId, name });
        if (Number.isFinite(purse)) await roomAction(roomId, 'setTeamPurse', { teamId, purse });
        return renderSettingsPanel(roomId);
      }

      const moveUpBtn = e.target.closest('[data-act="move-player-up"]');
      const moveDownBtn = e.target.closest('[data-act="move-player-down"]');
      if (moveUpBtn || moveDownBtn) {
        const playerId = (moveUpBtn || moveDownBtn).getAttribute('data-player');
        const queue = [...app.state.queue];
        const idx = queue.indexOf(playerId);
        const swapWith = moveUpBtn ? idx - 1 : idx + 1;
        if (idx < 0 || swapWith < 0 || swapWith >= queue.length) return;
        [queue[idx], queue[swapWith]] = [queue[swapWith], queue[idx]];
        await roomAction(roomId, 'reorderQueue', { queue });
        return renderPlayersPanel(roomId);
      }
      const savePlayerBtn = e.target.closest('[data-act="save-player"]');
      if (savePlayerBtn) {
        const playerId = savePlayerBtn.getAttribute('data-player');
        const roleSelect = document.querySelector(`[data-player-field="role"][data-player="${playerId}"]`);
        const tierSelect = document.querySelector(`[data-player-field="tier"][data-player="${playerId}"]`);
        const baseInput = document.querySelector(`[data-player-field="basePrice"][data-player="${playerId}"]`);
        const patch = {};
        if (roleSelect) patch.role = roleSelect.value;
        if (tierSelect) patch.tier = tierSelect.value;
        const base = Number(baseInput ? baseInput.value : NaN);
        if (Number.isFinite(base)) patch.basePrice = base;
        await roomAction(roomId, 'updatePlayer', { playerId, patch });
        return renderPlayersPanel(roomId);
      }
      const retainBtn = e.target.closest('[data-act="retain-player"]');
      if (retainBtn) {
        const playerId = retainBtn.getAttribute('data-player');
        const teamSelect = document.querySelector(`[data-retain-team="${playerId}"]`);
        const roleSelect = document.querySelector(`[data-retain-role="${playerId}"]`);
        const teamId = teamSelect ? teamSelect.value : '';
        const role = roleSelect ? roleSelect.value : '';
        if (!teamId || !role) return;
        await roomAction(roomId, 'retainPlayer', { playerId, teamId, role });
        return renderPlayersPanel(roomId);
      }
      const unretainBtn = e.target.closest('[data-act="unretain-player"]');
      if (unretainBtn) {
        const playerId = unretainBtn.getAttribute('data-player');
        if (!confirm('Move this player back into the auction pool? Their role/tier/base price will reset to defaults.')) return;
        await roomAction(roomId, 'unretainPlayer', { playerId });
        return renderPlayersPanel(roomId);
      }
      const regenBtn = e.target.closest('[data-act="regen-pin"]');
      if (regenBtn) {
        const session = loadSession(roomId);
        const target = regenBtn.getAttribute('data-target');
        if (!confirm('Regenerate this PIN? Anyone using the old PIN will be signed out immediately.')) return;
        await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/host/regenerate-pin`, { token: session.token, target });
        return renderPinsPanel(roomId);
      }
      const approveBtn = e.target.closest('[data-act="approve-player"]');
      if (approveBtn) {
        const session = loadSession(roomId);
        const pendingId = approveBtn.getAttribute('data-pending-id');
        const tierSelect = document.querySelector(`[data-pending-tier="${pendingId}"]`);
        const tier = tierSelect ? tierSelect.value : 'C';
        // The server broadcasts the updated state over the room's WebSocket (already
        // connected for the host console), so the queue/team panels refresh on their own.
        await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/host/approve-player`, {
          token: session.token,
          pendingId,
          tier,
        });
        return renderPinsPanel(roomId);
      }
      const rejectBtn = e.target.closest('[data-act="reject-player"]');
      if (rejectBtn) {
        const session = loadSession(roomId);
        const pendingId = rejectBtn.getAttribute('data-pending-id');
        await apiPost(`/api/rooms/${encodeURIComponent(roomId)}/host/reject-player`, { token: session.token, pendingId });
        return renderPinsPanel(roomId);
      }
      if (e.target.closest('[data-act="start"]')) return roomAction(roomId, 'startAuction');
      if (e.target.closest('[data-act="pause"]')) return roomAction(roomId, 'pauseResume');
      if (e.target.closest('[data-act="undo"]')) return roomAction(roomId, 'undo');
      if (e.target.closest('[data-act="skip"]')) return roomAction(roomId, 'skip');
      if (e.target.closest('[data-act="sell"]')) return roomAction(roomId, 'sell');
      if (e.target.closest('[data-act="unsold"]')) return roomAction(roomId, 'markUnsold');
      if (e.target.closest('[data-act="reset"]')) {
        if (!confirm('Reset this room back to its starting line-up? This clears all bids/sales.')) return;
        return roomAction(roomId, 'reset');
      }
    }

    // --- Team console ---
    if (app.screen === 'team') {
      const roomId = app.roomId;
      if (e.target.closest('[data-act="bid-next"]')) return roomAction(roomId, 'bid', {});
      if (e.target.closest('[data-act="bid-custom"]')) {
        const input = $('#teamCustomBid');
        const amount = Number(String(input ? input.value : '').replaceAll(',', '').trim());
        if (!Number.isFinite(amount) || amount <= 0) {
          app.state = { ...app.state, message: 'Enter a valid custom bid amount.' };
          rerenderCurrentRoom();
          return;
        }
        return roomAction(roomId, 'bid', { customAmount: amount });
      }
    }
  });

  // Space = pause/resume, Ctrl/Cmd+Z = undo — host console only. Registered
  // once; guarded on app.screen so it's a no-op everywhere else.
  document.addEventListener('keydown', (e) => {
    if (app.screen !== 'host') return;
    if (e.key === ' ') {
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      e.preventDefault();
      roomAction(app.roomId, 'pauseResume');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      roomAction(app.roomId, 'undo');
    }
  });

  // Registers the PWA service worker (see public/sw.js) so the app is
  // installable on phones/tablets/desktops. Best-effort only: a browser
  // without support, or a failed registration, just means "no install
  // prompt" — the app itself never depends on the service worker existing.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  boot();
})();
