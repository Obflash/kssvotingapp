// ── Shared state ─────────────────────────────────────────────────────────────
const app = {
  state: {
    election: null,
    adminToken: sessionStorage.getItem('adminToken') || '',
    student: null,
    _electionCache: { ts: 0, data: null, promise: null },
  },
};

// ── Election fetch with cache ─────────────────────────────────────────────────
function fetchElectionCached(force = false) {
  const now = Date.now();
  if (!force) {
    if (app.state._electionCache.promise) return app.state._electionCache.promise;
    if (app.state._electionCache.data && now - app.state._electionCache.ts < 300000) {
      return Promise.resolve(app.state._electionCache.data);
    }
  }
  app.state._electionCache.promise = apiRequest('/api/election')
    .then((data) => { app.state._electionCache.data = data; app.state._electionCache.ts = Date.now(); app.state._electionCache.promise = null; return data; })
    .catch((err) => { app.state._electionCache.promise = null; throw err; });
  return app.state._electionCache.promise;
}

// ── API helper ────────────────────────────────────────────────────────────────
async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Request failed.');
  return data;
}

function showMessage(node, text, isError = false) {
  if (!node) return;
  node.textContent = text;
  node.style.color = isError ? '#d94f4f' : '#1e8f5b';
}

function safeGetId(key) { return sessionStorage.getItem(key) || ''; }

function formatCountdown(targetTime) {
  const remaining = Math.max(new Date(targetTime).getTime() - Date.now(), 0);
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

// ── HOME page ─────────────────────────────────────────────────────────────────
function renderHomeStatus() {
  fetchElectionCached()
    .then((data) => {
      const status = data.status || 'live';
      const label = { live: { text: '🟢 Election Live', value: 'Live' }, upcoming: { text: '🟠 Election Not Started', value: 'Not Started' }, closed: { text: '🔴 Election Closed', value: 'Closed' }, paused: { text: '🟠 Election Paused', value: 'Paused' } };
      const badge = document.querySelector('#homeStatus');
      const statusText = document.querySelector('#homeStatusText');
      const dateNode = document.querySelector('#homeDate');
      if (badge) badge.textContent = label[status]?.text || label.live.text;
      if (statusText) statusText.textContent = label[status]?.value || 'Live';
      if (dateNode) dateNode.textContent = data.timer ? new Date(data.timer.end).toLocaleString() : 'Election date';
    })
    .catch(() => { const b = document.querySelector('#homeStatus'); if (b) b.textContent = '🟠 Election Not Started'; });
}

// ── STUDENT LOGIN page ────────────────────────────────────────────────────────
function setupStudentLogin() {
  const form = document.querySelector('#studentLoginForm');
  const pinFieldWrapper = document.querySelector('#pinFieldWrapper');
  const loginStatusBadge = document.querySelector('#loginStatusBadge');
  if (!form) return;

  fetchElectionCached()
    .then((data) => {
      const s = data.status || 'live';
      const label = { live: '🟢 Election Live', upcoming: '🟠 Election Not Started', closed: '🔴 Election Closed', paused: '🟠 Election Paused' };
      if (loginStatusBadge) loginStatusBadge.textContent = label[s] || '🟢 Election Live';
      // PIN is always required — always show the field
      if (pinFieldWrapper) pinFieldWrapper.classList.remove('hidden');
    })
    .catch(() => {
      if (pinFieldWrapper) pinFieldWrapper.classList.remove('hidden');
    });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const studentId = document.querySelector('#studentId').value.trim();
    const pin = document.querySelector('#pin')?.value || '';
    const messageNode = document.querySelector('#loginMessage');
    try {
      const result = await apiRequest('/api/student/login', { method: 'POST', body: JSON.stringify({ studentId, pin }) });
      if (result.success) {
        sessionStorage.setItem('studentId', result.studentId);
        sessionStorage.setItem('studentSessionId', result.sessionId);
        window.location.href = '/student-vote.html';
      } else if (result.alreadyVoted) {
        // Show a prominent already-voted banner instead of a plain error
        const msg = document.querySelector('#loginMessage');
        if (msg) {
          msg.innerHTML = `
            <div style="background:#eaf8ef;border:2px solid #1e8f5b;border-radius:14px;padding:18px 20px;text-align:center;margin-top:14px;">
              <div style="font-size:2rem;margin-bottom:8px;">✅</div>
              <strong style="color:#1e8f5b;font-size:1.1rem;">Vote Already Recorded</strong>
              <p style="margin:8px 0 0;color:#374151;font-size:.95rem;">
                Your vote has already been submitted successfully.<br>
                Each student may only vote once. Thank you for participating!
              </p>
            </div>`;
          msg.style.color = 'inherit';
        }
      } else {
        showMessage(messageNode, result.message, true);
      }
    } catch (error) {
      showMessage(messageNode, error.message || 'Unable to log in. Please try again.', true);
    }
  });
}

// ── BALLOT page ───────────────────────────────────────────────────────────────
function setupBallotPage() {
  const form = document.querySelector('#voteForm');
  const loader = document.querySelector('#ballotLoader');
  const notice = document.querySelector('#voteNotice');
  const studentId = safeGetId('studentId');
  const sessionId = safeGetId('studentSessionId');

  if (!studentId || !sessionId) { window.location.href = '/student-login.html'; return; }

  async function loadBallot() {
    try {
      const result = await apiRequest(`/api/student/ballot?studentId=${encodeURIComponent(studentId)}&sessionId=${encodeURIComponent(sessionId)}`);
      if (!result.success) { showMessage(notice, result.message, true); notice.style.display = 'block'; loader.classList.add('hidden'); return; }

      const election = await fetchElectionCached();
      const countdown = document.querySelector('#countdownTimer');
      if (countdown && election.timer && election.timer.end) {
        countdown.textContent = formatCountdown(election.timer.end);
        setInterval(() => { countdown.textContent = formatCountdown(election.timer.end); }, 1000);
      }

      const ballot = result.ballot || [];
      loader.classList.add('hidden');
      form.classList.remove('hidden');

      if (!ballot.length) { form.innerHTML = '<div class="panel"><h3>No positions available.</h3></div>'; return; }

      form.innerHTML = ballot.map((position) => {
        const alreadyVoted = position.alreadyVoted;
        const candidateCards = (position.candidates || []).map((candidate) => `
          <div class="candidate-card">
            <img class="candidate-photo" src="${candidate.photo || 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=800&q=80'}" alt="${candidate.fullName}" />
            <h3>${candidate.fullName}</h3>
            <p class="muted">Class: ${candidate.className || 'N/A'}</p>
            <p class="muted">${candidate.slogan || 'Campaign slogan'}</p>
            <div class="option-row">
              <label><input type="radio" name="position-${position.id}" value="${candidate.id}" ${alreadyVoted ? 'disabled' : ''} /> Select</label>
            </div>
          </div>`).join('');
        return `
          <section class="position-section">
            <div class="position-title">
              <h2>${position.name.toUpperCase()}</h2>
              ${alreadyVoted ? '<span class="status-badge">✓ Voted</span>' : ''}
            </div>
            <div class="candidate-grid">${candidateCards || '<p class="muted">No candidates available yet.</p>'}</div>
          </section>`;
      }).join('');

      const reviewButton = document.createElement('div');
      reviewButton.className = 'vote-actions';
      reviewButton.innerHTML = `<button type="button" class="secondary-btn" id="reviewVotesBtn">Review My Votes</button><button type="submit" class="primary-btn">Submit Vote</button>`;
      form.appendChild(reviewButton);

      document.querySelector('#reviewVotesBtn')?.addEventListener('click', () => {
        const selections = {};
        ballot.forEach((p) => { const c = form.querySelector(`input[name="position-${p.id}"]:checked`); if (c) selections[p.id] = c.value; });
        if (!Object.keys(selections).length) { showMessage(notice, 'Please select candidates before reviewing your votes.', true); notice.style.display = 'block'; return; }
        const summary = ballot.filter((p) => selections[p.id]).map((p) => `${p.name}: ${p.candidates.find((c) => c.id === selections[p.id])?.fullName || 'Unknown'}`).join('<br>');
        notice.innerHTML = `<strong>Please review your selections carefully.</strong><br>${summary}`;
        notice.style.display = 'block';
      });
    } catch (error) {
      showMessage(notice, error.message || 'Unable to load ballot.', true);
      notice.style.display = 'block';
      loader.classList.add('hidden');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const selections = {};
    form.querySelectorAll('input[type="radio"]:checked').forEach((r) => { selections[r.name.replace('position-', '')] = r.value; });
    if (!Object.keys(selections).length) { showMessage(notice, 'Please select a candidate for each position.', true); notice.style.display = 'block'; return; }
    try {
      const result = await apiRequest('/api/submit-vote', { method: 'POST', body: JSON.stringify({ studentId, sessionId, selections }) });
      if (result.success) {
        // Clear session so PIN can never be reused from this browser
        sessionStorage.removeItem('studentSessionId');
        sessionStorage.removeItem('studentId');
        notice.innerHTML = `
          <div style="text-align:center;padding:20px 0;">
            <div style="font-size:3rem;margin-bottom:12px;">✅</div>
            <strong style="font-size:1.3rem;color:var(--success);">Vote Successfully Recorded!</strong>
            <p style="margin:12px 0 0;color:var(--text);">
              Thank you for participating in the Kumasi STEM JHS Student Election.<br>
              Your vote has been securely saved.
            </p>
            <a href="/" style="display:inline-block;margin-top:18px;padding:12px 24px;background:var(--primary);color:#fff;border-radius:12px;font-weight:700;text-decoration:none;">Return to Home</a>
          </div>`;
        notice.style.display = 'block';
        form.classList.add('hidden');
      } else {
        showMessage(notice, result.message, true);
        notice.style.display = 'block';
      }
    } catch (error) {
      showMessage(notice, error.message || 'Unable to submit vote.', true);
      notice.style.display = 'block';
    }
  });

  loadBallot();
}

// ── ADMIN LOGIN page ──────────────────────────────────────────────────────────
function setupAdminLogin() {
  const form = document.querySelector('#adminLoginForm');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.querySelector('#adminUsername').value.trim();
    const password = document.querySelector('#adminPassword').value.trim();
    const messageNode = document.querySelector('#adminMessage');
    try {
      const result = await apiRequest('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (result.success) { sessionStorage.setItem('adminToken', result.token); window.location.href = '/admin.html'; }
      else showMessage(messageNode, result.message, true);
    } catch (error) { showMessage(messageNode, error.message || 'Unable to log in as admin.', true); }
  });
}

// ── ADMIN DASHBOARD render helpers ───────────────────────────────────────────
function renderSummaryCards(summary) {
  const grid = document.querySelector('#summaryGrid');
  if (!grid) return;
  const cards = [
    { label: 'Total Students', value: summary.totalEligible || 0 },
    { label: 'Voted', value: summary.votedCount || 0 },
    { label: 'Not Yet Voted', value: summary.notVoted || 0 },
    { label: 'Turnout', value: `${summary.turnout || '0.0'}%` },
    { label: 'Total Votes Cast', value: summary.totalVotesCast || 0 },
    { label: 'Election Status', value: summary.electionStatus || 'Live' },
  ];
  grid.innerHTML = cards.map((c) => `<div class="summary-card"><div class="label">${c.label}</div><strong>${c.value}</strong></div>`).join('');
  const statusBadge = document.querySelector('#adminStatusPill');
  if (statusBadge) {
    const statusMap = { live: '🟢 Election Live', upcoming: '🟠 Election Not Started', closed: '🔴 Election Closed', paused: '🟠 Election Paused' };
    statusBadge.textContent = statusMap[summary.electionStatus] || '🟢 Election Live';
  }
}

function renderPositions(positions) {
  const list = document.querySelector('#positionList');
  if (!list) return;
  list.innerHTML = (positions || []).map((p) => `
    <div class="list-item">
      <div><strong>${p.name}</strong><small>${p.status || 'active'}</small></div>
      <div class="button-row">
        <button class="danger-btn small-btn" data-action="delete-position" data-id="${p.id}">Delete</button>
      </div>
    </div>`).join('');

  const select = document.querySelector('#candidatePositionInput');
  if (select) select.innerHTML = (positions || []).map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
}

function renderCandidates(candidates) {
  const list = document.querySelector('#candidateList');
  if (!list) return;
  list.innerHTML = (candidates || []).map((c) => `
    <div class="list-item">
      <div style="display:flex;align-items:center;gap:10px;">
        <img src="${c.photo || 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=60&q=60'}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;flex-shrink:0;" alt="${c.fullName}" />
        <div><strong>${c.fullName}</strong><small>${c.className || 'N/A'} • ${c.slogan || ''}</small></div>
      </div>
      <div class="button-row">
        <button class="danger-btn small-btn" data-action="delete-candidate" data-id="${c.id}">Delete</button>
      </div>
    </div>`).join('');
}

function renderStudents(students) {
  const list = document.querySelector('#studentList');
  if (!list) return;
  if (!students || !students.length) { list.innerHTML = '<p class="muted">No students imported yet.</p>'; return; }
  list.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:.85rem;">
        <thead><tr style="background:var(--primary-soft);">
          <th style="padding:8px 10px;text-align:left;">ID</th>
          <th style="padding:8px 10px;text-align:left;">Name</th>
          <th style="padding:8px 10px;text-align:left;">Class</th>
          <th style="padding:8px 10px;text-align:left;">Section</th>
          <th style="padding:8px 10px;text-align:left;">Gender</th>
          <th style="padding:8px 10px;text-align:left;">PIN</th>
          <th style="padding:8px 10px;text-align:left;">Status</th>
          <th style="padding:8px 10px;text-align:left;">Actions</th>
        </tr></thead>
        <tbody>
          ${students.map((s) => `
            <tr style="border-bottom:1px solid var(--line);">
              <td style="padding:8px 10px;font-family:monospace;">${s.studentId}</td>
              <td style="padding:8px 10px;">${[s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ') || '—'}</td>
              <td style="padding:8px 10px;">${s.className || '—'}</td>
              <td style="padding:8px 10px;">${s.sectionName || '—'}</td>
              <td style="padding:8px 10px;">${s.gender || '—'}</td>
              <td style="padding:8px 10px;font-family:monospace;font-weight:700;letter-spacing:.1em;color:var(--primary);">${s.pin || '—'}</td>
              <td style="padding:8px 10px;"><span style="color:${s.active ? 'var(--success)' : 'var(--danger)'}">${s.active ? 'Active' : 'Inactive'}</span></td>
              <td style="padding:8px 10px;">
                <button class="secondary-btn small-btn" data-action="toggle-student" data-id="${s.id}" style="margin-right:4px;">${s.active ? 'Disable' : 'Enable'}</button>
                <button class="danger-btn small-btn" data-action="delete-student" data-id="${s.id}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── Results & Print ───────────────────────────────────────────────────────────
function renderResultsTab(results, settings, summary) {
  const winnersGrid = document.querySelector('#winnersGrid');
  const resultsReport = document.querySelector('#resultsReport');
  const statusLabel = document.querySelector('#resultsStatusLabel');
  const turnoutSummary = document.querySelector('#turnoutSummary');
  const turnoutDetail = document.querySelector('#turnoutDetail');

  if (!winnersGrid || !resultsReport) return;

  const status = results.positions && results.positions.length ? (document.querySelector('#adminStatusPill')?.textContent || '') : '';
  if (statusLabel) {
    const isFinal = (settings && settings.electionState === 'closed');
    statusLabel.textContent = isFinal ? '🔴 FINAL RESULTS' : '🟢 LIVE RESULTS';
    statusLabel.style.background = isFinal ? '#ffe7e7' : '#eaf8ef';
    statusLabel.style.color = isFinal ? 'var(--danger)' : 'var(--success)';
  }

  // Winners
  winnersGrid.innerHTML = (results.positions || []).map((pos) => {
    if (!pos.leader) return '';
    return `
      <div class="winner-card">
        <img class="winner-photo" src="${pos.leader.photo || 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=140&q=80'}" alt="${pos.leader.fullName}" />
        <div class="winner-info">
          <p style="margin:0 0 2px;font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">${pos.positionName}</p>
          <h4>${pos.leader.fullName}</h4>
          <p>${pos.leader.className || ''}</p>
          <span class="winner-badge">🏆 ${pos.leader.votes} vote${pos.leader.votes !== 1 ? 's' : ''}</span>
        </div>
      </div>`;
  }).join('');

  // Full breakdown
  resultsReport.innerHTML = (results.positions || []).map((pos) => {
    const bars = (pos.candidates || []).sort((a, b) => b.votes - a.votes).map((c) => `
      <div class="bar-row">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.fullName}</span>
        <div class="bar-bg"><div class="bar-fill" style="width:${c.percentage}%;"></div></div>
        <span style="text-align:right;font-weight:700;">${c.votes} <small style="color:var(--muted);">(${c.percentage}%)</small></span>
      </div>`).join('');
    return `
      <div class="position-result-block">
        <h3>${pos.positionName} — ${pos.totalVotes} total votes</h3>
        ${bars || '<p class="muted">No votes yet.</p>'}
      </div>`;
  }).join('');

  // Turnout
  if (turnoutSummary && turnoutDetail && summary) {
    turnoutSummary.style.display = 'block';
    turnoutDetail.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-top:10px;">
        <div class="summary-card"><div class="label">Total Eligible</div><strong>${summary.totalEligible}</strong></div>
        <div class="summary-card"><div class="label">Voted</div><strong>${summary.votedCount}</strong></div>
        <div class="summary-card"><div class="label">Not Voted</div><strong>${summary.notVoted}</strong></div>
        <div class="summary-card"><div class="label">Turnout</div><strong>${summary.turnout}%</strong></div>
      </div>`;
  }

  // Fill print header values
  const printHeader = document.querySelector('#printHeader');
  if (printHeader) {
    printHeader.style.display = 'block';
    const sn = document.querySelector('#printSchoolName');
    const et = document.querySelector('#printElectionTitle');
    const rs = document.querySelector('#printResultStatus');
    const pd = document.querySelector('#printDate');
    if (sn && settings) sn.textContent = settings.schoolName || '';
    if (et && settings) et.textContent = settings.electionTitle || '';
    if (rs) rs.textContent = statusLabel ? statusLabel.textContent : '';
    if (pd) pd.textContent = new Date().toLocaleString();
  }
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function renderAnalytics(analytics) {
  const grid = document.querySelector('#analyticsGrid');
  if (!grid) return;
  if (!analytics || !analytics.length) { grid.innerHTML = '<p class="muted">No voting data available yet.</p>'; return; }

  grid.innerHTML = analytics.map((cls) => `
    <div class="analytics-card">
      <h4>📚 ${cls.className}</h4>
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:4px;">
          <span>Unique voters</span><strong>${cls.uniqueVoters}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:.85rem;">
          <span>Total votes cast</span><strong>${cls.totalVotesCast}</strong>
        </div>
      </div>
      <div style="border-top:1px solid var(--line);padding-top:8px;">
        <p style="margin:0 0 6px;font-size:.78rem;text-transform:uppercase;color:var(--muted);letter-spacing:.05em;">By Section</p>
        ${cls.sections.map((sec) => `
          <div class="section-row">
            <span>Section ${sec.sectionName}</span>
            <span>${sec.uniqueVoters} voters / ${sec.totalVotesCast} votes</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function renderAudit(logs) {
  const list = document.querySelector('#auditList');
  if (!list) return;
  list.innerHTML = (logs || []).map((e) => `
    <div class="audit-item">
      <div><strong>${e.action}</strong><small>${e.actor || 'System'}</small></div>
      <small>${new Date(e.date).toLocaleString()}</small>
    </div>`).join('');
}

// ── Load dashboard ────────────────────────────────────────────────────────────
async function loadDashboard() {
  const token = sessionStorage.getItem('adminToken');
  if (!token) { window.location.href = '/admin-login.html'; return; }

  // Hide any previous global error
  const toast = document.querySelector('#globalToast');
  if (toast) toast.style.display = 'none';

  try {
    const result = await apiRequest('/api/admin/summary', { headers: { 'x-admin-token': token } });
    renderSummaryCards(result.summary);
    renderPositions(result.positions);
    renderCandidates(result.candidates);
    renderStudents(result.students);
    renderResultsTab(result.results, result.settings, result.summary);
    renderAnalytics(result.analytics);
    renderAudit(result.auditLog);

    const settings = result.settings || {};
    const sni = document.querySelector('#schoolNameInput');
    const eti = document.querySelector('#electionTitleInput');
    const rvi = document.querySelector('#resultsVisibilityInput');
    if (sni) sni.value = settings.schoolName || '';
    if (eti) eti.value = settings.electionTitle || '';
    if (rvi) rvi.value = settings.resultsVisibility || 'live';
  } catch (error) {
    if (toast) {
      toast.textContent = '⚠️ ' + (error.message || 'Failed to load dashboard.');
      toast.style.display = 'block';
    }
    if (error.message && error.message.toLowerCase().includes('unauthorized')) {
      window.location.href = '/admin-login.html';
    }
  }
}

// ── Photo upload (candidates) ─────────────────────────────────────────────────
function setupPhotoUpload() {
  const fileInput = document.querySelector('#candidatePhotoFile');
  const preview = document.querySelector('#photoPreview');
  const hint = document.querySelector('#uploadHint');
  const urlInput = document.querySelector('#candidatePhotoUrl');
  const finalInput = document.querySelector('#candidatePhotoFinal');
  if (!fileInput) return;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    // Show local preview immediately
    const localUrl = URL.createObjectURL(file);
    preview.src = localUrl;
    preview.classList.remove('hidden');
    hint.textContent = file.name;
    finalInput.value = ''; // will be set after upload

    // Upload to server
    const token = sessionStorage.getItem('adminToken');
    const formData = new FormData();
    formData.append('photo', file);
    try {
      const res = await fetch('/api/admin/candidates/upload-photo', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        finalInput.value = data.photoUrl;
        hint.textContent = '✅ ' + file.name + ' uploaded';
        urlInput.value = '';
      } else {
        hint.textContent = '❌ Upload failed: ' + (data.message || 'Server error');
        preview.classList.add('hidden');
      }
    } catch (e) {
      hint.textContent = '❌ Upload error: ' + (e.message || 'Network error');
      preview.classList.add('hidden');
    }
  });

  urlInput.addEventListener('input', () => {
    if (urlInput.value.trim()) {
      preview.src = urlInput.value.trim();
      preview.classList.remove('hidden');
      hint.textContent = 'Using URL image';
      finalInput.value = '';
      fileInput.value = '';
    }
  });
}

// ── CSV bulk import ───────────────────────────────────────────────────────────
const CSV_COLUMNS = ['student_id', 'first_name', 'middle_name', 'last_name', 'date_of_birth', 'gender', 'email', 'phone', 'class_name', 'section_name'];

// Module-level storage — never reset by loadDashboard() re-renders
let _csvParsedRows = [];
let _csvSetupDone = false;

// Helper: split one CSV line respecting quoted fields
function splitCsvLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// Helper: normalise date to YYYY-MM-DD
function normalizeDateCsv(raw) {
  if (!raw || !raw.trim()) return '';
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const month = parseInt(m, 10);
    const day   = parseInt(d, 10);
    if (month > 12) return `${y}-${String(day).padStart(2,'0')}-${String(month).padStart(2,'0')}`;
    return `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return s;
}

// Header alias map — handles common spelling variants from Excel exports
const HEADER_ALIASES = {
  student_id:   ['student_id','studentid','id','student id','student no','studentno','regno','reg_no','registration number','registration_number'],
  first_name:   ['first_name','firstname','first name','fname','given_name','givenname'],
  middle_name:  ['middle_name','middlename','middle name','mname','other_name','othername','other names'],
  last_name:    ['last_name','lastname','last name','lname','surname','family_name','familyname'],
  date_of_birth:['date_of_birth','dateofbirth','dob','birth_date','birthdate','date of birth'],
  gender:       ['gender','sex'],
  email:        ['email','email_address','emailaddress','e-mail','e mail'],
  phone:        ['phone','phone_number','phonenumber','mobile','tel','telephone','contact','phone no'],
  class_name:   ['class_name','classname','class','form','grade','class name','year'],
  section_name: ['section_name','sectionname','section','stream','group','section name','arm'],
};

function canonicalizeHeader(raw) {
  const cleaned = raw
    .replace(/^\uFEFF/, '')          // strip BOM
    .toLowerCase()
    .replace(/[^a-z0-9 _]/g, ' ')   // non-alphanumeric → space
    .replace(/\s+/g, ' ')
    .trim();
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(cleaned)) return canonical;
  }
  return cleaned.replace(/\s+/g, '_');
}

function setupCsvImport() {
  // Wire up listeners only once — guard against loadDashboard() calling this again
  if (_csvSetupDone) return;

  const dropArea   = document.querySelector('#csvDropArea');
  const fileInput  = document.querySelector('#csvFileInput');
  const templateBtn = document.querySelector('#csvTemplateBtn');
  if (!dropArea || !fileInput) return;
  _csvSetupDone = true;

  // ── helpers that read DOM fresh each time (not captured at setup time) ──
  function el(id) { return document.querySelector(id); }

  function setCsvStatus(msg, ok) {
    const s = el('#csvStatus');
    if (!s) return;
    s.textContent = msg;
    s.style.color = ok ? 'var(--success)' : 'var(--danger)';
  }

  // Template download
  if (templateBtn) {
    templateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const blob = new Blob(
        [CSV_COLUMNS.join(',') + '\n' + 'STU-2001,Kofi,,Mensah,2010-05-14,Male,kofi@school.edu,+233201234567,JHS 3A,A\n'],
        { type: 'text/csv' }
      );
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'students_template.csv' });
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  // Drag & drop
  dropArea.addEventListener('dragover',  (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); });
  dropArea.addEventListener('dragleave', ()  => dropArea.classList.remove('drag-over'));
  dropArea.addEventListener('drop', (e) => {
    e.preventDefault(); dropArea.classList.remove('drag-over');
    const f = e.dataTransfer.files[0]; if (f) readCsvFile(f);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) readCsvFile(fileInput.files[0]); });

  function readCsvFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => parseCsvText(e.target.result, file.name);
    reader.readAsText(file);
  }

  function parseCsvText(text, filename) {
    const clean = text.replace(/^\uFEFF/, '');
    const lines = clean.split(/\r?\n/).filter((l) => l.trim());

    if (lines.length < 2) {
      setCsvStatus('❌ File appears empty or has no data rows.', false);
      return;
    }

    // Pick delimiter that produces the most columns
    const candidates = ['\t', ',', ';', '|'];
    let delimiter = ',', maxCols = 0;
    for (const d of candidates) {
      const n = lines[0].split(d).length;
      if (n > maxCols) { maxCols = n; delimiter = d; }
    }

    const rawHeaders = splitCsvLine(lines[0], delimiter);
    const headers    = rawHeaders.map(canonicalizeHeader);

    if (!headers.includes('student_id')) {
      setCsvStatus(`❌ No "student_id" column found. Headers detected: ${rawHeaders.join(' | ')}`, false);
      return;
    }

    _csvParsedRows = [];  // reset module-level array

    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const values = splitCsvLine(line, delimiter);
      const row = {};
      headers.forEach((h, i) => { row[h] = (values[i] !== undefined ? values[i] : '').trim(); });
      if (!row.student_id) continue;
      if (row.date_of_birth) row.date_of_birth = normalizeDateCsv(row.date_of_birth);
      // Fill any missing expected keys with empty string
      for (const key of Object.keys(HEADER_ALIASES)) { if (row[key] === undefined) row[key] = ''; }
      _csvParsedRows.push(row);
    }

    if (!_csvParsedRows.length) {
      setCsvStatus(`❌ No valid rows. Delimiter: "${delimiter === '\t' ? 'TAB' : delimiter}", headers: ${headers.join(', ')}`, false);
      return;
    }

    setCsvStatus(`✅ ${filename} — ${_csvParsedRows.length} rows ready. Click "Import All Students" to proceed.`, true);

    const previewTable = el('#csvPreviewTable');
    if (previewTable) {
      previewTable.innerHTML = `
        <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${_csvParsedRows.slice(0, 5).map((r) => `<tr>${headers.map((h) => `<td>${r[h] || ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
    }

    const importActions = el('#csvImportActions');
    if (importActions) importActions.style.display = 'flex';
  }

  // Import button — looks up DOM fresh every click
  const csvImportBtnEl = document.querySelector('#csvImportBtn');
  const csvClearBtnEl  = document.querySelector('#csvClearBtn');
  if (!csvImportBtnEl || !csvClearBtnEl) return;

  csvImportBtnEl.addEventListener('click', async () => {
    const importBtn = el('#csvImportBtn');
    const statusEl  = el('#csvStatus');

    if (!_csvParsedRows.length) {
      if (statusEl) { statusEl.textContent = '❌ No data to import. Please select a CSV file first.'; statusEl.style.color = 'var(--danger)'; }
      return;
    }

    const token = sessionStorage.getItem('adminToken');
    if (importBtn) { importBtn.disabled = true; importBtn.textContent = `Importing ${_csvParsedRows.length} rows...`; }

    try {
      const result = await apiRequest('/api/admin/students/bulk-import', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify({ rows: _csvParsedRows }),
      });
      setCsvStatus(`✅ Done! Imported ${result.imported} students. Skipped duplicates: ${result.skipped}.`, true);
      const previewTable  = el('#csvPreviewTable');
      const importActions = el('#csvImportActions');
      if (previewTable)  previewTable.innerHTML = '';
      if (importActions) importActions.style.display = 'none';
      _csvParsedRows = [];
      fileInput.value = '';
      loadDashboard();
    } catch (e) {
      setCsvStatus('❌ Import failed: ' + (e.message || 'Unknown error'), false);
    } finally {
      if (importBtn) { importBtn.disabled = false; importBtn.textContent = 'Import All Students'; }
    }
  });

  // Clear button
  csvClearBtnEl.addEventListener('click', () => {
    _csvParsedRows = [];
    const previewTable  = el('#csvPreviewTable');
    const importActions = el('#csvImportActions');
    if (previewTable)  previewTable.innerHTML = '';
    if (importActions) importActions.style.display = 'none';
    setCsvStatus('', true);
    fileInput.value = '';
  });
}

// ── Tab navigation ────────────────────────────────────────────────────────────
function setupTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  if (!tabBtns.length) return;
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.querySelector(`#tab-${btn.dataset.tab}`);
      if (pane) pane.classList.add('active');
    });
  });
}

// ── Print ─────────────────────────────────────────────────────────────────────
function setupPrint() {
  const printBtn = document.querySelector('#printResultsBtn');
  const refreshBtn = document.querySelector('#refreshResultsBtn');
  if (printBtn) {
    printBtn.addEventListener('click', () => window.print());
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadDashboard());
  }
}

// ── Admin events ──────────────────────────────────────────────────────────────
let _adminEventsDone = false;

function bindAdminEvents() {
  if (_adminEventsDone) return;
  _adminEventsDone = true;

  // Settings form
  const settingsForm = document.querySelector('#settingsForm');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = sessionStorage.getItem('adminToken');
      const payload = {
        schoolName: document.querySelector('#schoolNameInput').value,
        electionTitle: document.querySelector('#electionTitleInput').value,
        resultsVisibility: document.querySelector('#resultsVisibilityInput').value,
      };
      await apiRequest('/api/admin/settings', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify(payload) });
      loadDashboard();
    });
  }

  // Election controls + delete/toggle buttons (delegated on document)
  document.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const token = sessionStorage.getItem('adminToken');

    if (action === 'close') {
      if (!window.confirm('Are you sure you want to close the election? Voting will no longer be possible.')) return;
    }

    if (['start', 'pause', 'resume', 'close'].includes(action)) {
      await apiRequest('/api/admin/election/control', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify({ action }) });
      loadDashboard();
      return;
    }

    if (action.startsWith('delete-')) {
      const id = button.dataset.id;
      const endpoint = action.includes('position')
        ? `/api/admin/positions/${id}`
        : action.includes('candidate')
          ? `/api/admin/candidates/${id}`
          : `/api/admin/students/${id}`;
      await apiRequest(endpoint, { method: 'DELETE', headers: { 'x-admin-token': token } });
      loadDashboard();
      return;
    }

    if (action === 'toggle-student') {
      const id = button.dataset.id;
      const summaryRes = await apiRequest('/api/admin/summary', { headers: { 'x-admin-token': token } });
      const student = (summaryRes.students || []).find((s) => String(s.id) === String(id));
      if (!student) return;
      await apiRequest(`/api/admin/students/${id}`, { method: 'PUT', headers: { 'x-admin-token': token }, body: JSON.stringify({ active: !student.active }) });
      loadDashboard();
    }
  });

  // Position form
  const positionForm = document.querySelector('#positionForm');
  if (positionForm) {
    positionForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = sessionStorage.getItem('adminToken');
      const name = document.querySelector('#positionNameInput').value.trim();
      if (!name) return;
      await apiRequest('/api/admin/positions', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify({ name }) });
      positionForm.reset();
      loadDashboard();
    });
  }

  // Candidate form
  const candidateForm = document.querySelector('#candidateForm');
  if (candidateForm) {
    candidateForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = sessionStorage.getItem('adminToken');
      const finalInput = document.querySelector('#candidatePhotoFinal');
      const urlInput   = document.querySelector('#candidatePhotoUrl');
      const photoVal   = (finalInput && finalInput.value.trim()) ? finalInput.value.trim()
                       : (urlInput   && urlInput.value.trim())   ? urlInput.value.trim() : '';
      const payload = {
        positionId: document.querySelector('#candidatePositionInput').value,
        fullName:   document.querySelector('#candidateNameInput').value.trim(),
        className:  document.querySelector('#candidateClassInput').value.trim(),
        photo:      photoVal,
        slogan:     document.querySelector('#candidateSloganInput').value.trim(),
        manifesto:  document.querySelector('#candidateManifestoInput').value.trim(),
      };
      if (!payload.fullName || !payload.positionId) { alert('Full name and position are required.'); return; }
      await apiRequest('/api/admin/candidates', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify(payload) });
      candidateForm.reset();
      const preview = document.querySelector('#photoPreview');
      const hint    = document.querySelector('#uploadHint');
      if (preview) preview.classList.add('hidden');
      if (hint)    hint.textContent = '📁 Click or drag an image here to upload from your device';
      if (finalInput) finalInput.value = '';
      loadDashboard();
    });
  }

  // ── PIN actions ─────────────────────────────────────────────────────────────
  const printPinsBtn = document.querySelector('#printPinsBtn');
  const exportPinsCsvBtn = document.querySelector('#exportPinsCsvBtn');
  const regeneratePinsBtn = document.querySelector('#regeneratePinsBtn');

  async function fetchPins() {
    const token = sessionStorage.getItem('adminToken');
    return apiRequest('/api/admin/students/pins', { headers: { 'x-admin-token': token } });
  }

  if (printPinsBtn) {
    printPinsBtn.addEventListener('click', async () => {
      const token = sessionStorage.getItem('adminToken');
      const data = await fetchPins();
      if (!data.success) { alert('Could not load PINs.'); return; }

      // Group by class
      const byClass = {};
      for (const s of data.pins) {
        const key = `${s.className} — Section ${s.sectionName}`;
        if (!byClass[key]) byClass[key] = [];
        byClass[key].push(s);
      }

      const win = window.open('', '_blank');
      win.document.write(`
        <!DOCTYPE html><html><head>
        <title>Student PIN Sheet</title>
        <style>
          body{font-family:Arial,sans-serif;padding:24px;font-size:13px;}
          h1{font-size:18px;margin-bottom:4px;}
          h2{font-size:14px;margin:20px 0 8px;background:#edf3ff;padding:6px 10px;border-radius:6px;}
          table{width:100%;border-collapse:collapse;margin-bottom:16px;}
          th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;}
          th{background:#f0f4ff;}
          .pin{font-family:monospace;font-weight:700;font-size:14px;letter-spacing:.15em;color:#113e7c;}
          @media print{button{display:none}}
        </style>
        </head><body>
        <h1>Kumasi STEM JHS — Student PIN Sheet</h1>
        <p style="color:#666;margin-bottom:16px;">Generated: ${new Date().toLocaleString()} &nbsp;|&nbsp; Total students: ${data.total}<br>
        <strong>Keep this document confidential.</strong> Distribute each PIN only to the named student.</p>
        <button onclick="window.print()" style="padding:8px 16px;background:#113e7c;color:#fff;border:none;border-radius:8px;cursor:pointer;margin-bottom:20px;">🖨 Print</button>
        ${Object.entries(byClass).map(([cls, students]) => `
          <h2>${cls} (${students.length} students)</h2>
          <table>
            <thead><tr><th>#</th><th>Student ID</th><th>Name</th><th>PIN</th></tr></thead>
            <tbody>${students.map((s, i) => `
              <tr>
                <td>${i + 1}</td>
                <td style="font-family:monospace;">${s.studentId}</td>
                <td>${s.name || '—'}</td>
                <td class="pin">${s.pin}</td>
              </tr>`).join('')}
            </tbody>
          </table>`).join('')}
        </body></html>`);
      win.document.close();
    });
  }

  if (exportPinsCsvBtn) {
    exportPinsCsvBtn.addEventListener('click', async () => {
      const data = await fetchPins();
      if (!data.success) { alert('Could not load PINs.'); return; }
      const header = 'student_id,name,class_name,section_name,pin';
      const rows = data.pins.map(s =>
        [s.studentId, `"${s.name}"`, `"${s.className}"`, s.sectionName, s.pin].join(',')
      );
      const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `student_pins_${new Date().toISOString().slice(0,10)}.csv`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  if (regeneratePinsBtn) {
    regeneratePinsBtn.addEventListener('click', async () => {
      if (!confirm('This will generate new PINs for ALL students. Old PINs will no longer work. Continue?')) return;
      const token = sessionStorage.getItem('adminToken');
      try {
        const r = await apiRequest('/api/admin/students/regenerate-pins', {
          method: 'POST',
          headers: { 'x-admin-token': token },
        });
        alert(r.message);
        loadDashboard();
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    });
  }

  // Student form — single add
  const studentForm = document.querySelector('#studentForm');
  if (studentForm) {
    studentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = sessionStorage.getItem('adminToken');

      // Read values fresh at submit time
      const studentId  = (document.querySelector('#studentIdInput')    || {}).value || '';
      const firstName  = (document.querySelector('#stuFirstNameInput') || {}).value || '';
      const middleName = (document.querySelector('#stuMiddleNameInput')|| {}).value || '';
      const lastName   = (document.querySelector('#stuLastNameInput')  || {}).value || '';
      const dob        = (document.querySelector('#stuDobInput')       || {}).value || '';
      const gender     = (document.querySelector('#stuGenderInput')    || {}).value || '';
      const email      = (document.querySelector('#stuEmailInput')     || {}).value || '';
      const phone      = (document.querySelector('#stuPhoneInput')     || {}).value || '';
      const className  = (document.querySelector('#studentClassInput') || {}).value || '';
      const sectionName= (document.querySelector('#studentSectionInput')|| {}).value || '';

      if (!studentId.trim()) { alert('Student ID is required.'); return; }

      const payload = {
        studentId:   studentId.trim(),
        firstName:   firstName.trim(),
        middleName:  middleName.trim(),
        lastName:    lastName.trim(),
        dateOfBirth: dob || null,
        gender,
        email:       email.trim(),
        phone:       phone.trim(),
        className:   className.trim(),
        sectionName: sectionName.trim(),
        active: true,
      };

      try {
        await apiRequest('/api/admin/students', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify(payload) });
        studentForm.reset();
        loadDashboard();
      } catch (err) {
        alert(err.message || 'Failed to add student.');
      }
    });
  }
}

// ── Page router ───────────────────────────────────────────────────────────────
function initPage() {
  const path = window.location.pathname;

  if (path === '/' || path.endsWith('/index.html')) {
    renderHomeStatus();
    return;
  }
  if (path.endsWith('/student-login.html')) {
    setupStudentLogin();
    return;
  }
  if (path.endsWith('/student-vote.html')) {
    setupBallotPage();
    return;
  }
  if (path.endsWith('/admin-login.html')) {
    setupAdminLogin();
    return;
  }
  if (path.endsWith('/admin.html')) {
    setupTabs();
    setupPhotoUpload();
    setupCsvImport();
    setupPrint();
    bindAdminEvents();   // bind once, immediately — not after loadDashboard
    loadDashboard();
    return;
  }

  renderHomeStatus();
}

window.addEventListener('DOMContentLoaded', initPage);
