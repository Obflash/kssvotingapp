const app = {
  state: {
    election: null,
    adminToken: sessionStorage.getItem('adminToken') || '',
    student: null,
  },
};

// election fetch cache to prevent rapid duplicate requests that cause UI flicker
app.state._electionCache = { ts: 0, data: null, promise: null };

function fetchElectionCached(force = false) {
  const now = Date.now();
  if (!force) {
    if (app.state._electionCache.promise) return app.state._electionCache.promise;
    // increase cache TTL to 5 minutes to avoid frequent polling/re-renders
    if (app.state._electionCache.data && now - app.state._electionCache.ts < 300000) {
      return Promise.resolve(app.state._electionCache.data);
    }
  }

  app.state._electionCache.promise = apiRequest('/api/election')
    .then((data) => {
      app.state._electionCache.data = data;
      app.state._electionCache.ts = Date.now();
      app.state._electionCache.promise = null;
      return data;
    })
    .catch((err) => {
      app.state._electionCache.promise = null;
      throw err;
    });

  return app.state._electionCache.promise;
}

function showMessage(node, text, isError = false) {
  if (!node) return;
  node.textContent = text;
  node.style.color = isError ? '#d94f4f' : '#1e8f5b';
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || 'Request failed.');
  }

  return data;
}

function safeGetId(key) {
  return sessionStorage.getItem(key) || '';
}

function renderHomeStatus() {
  fetchElectionCached()
    .then((data) => {
      const status = data.status || 'live';
      const label = {
        live: { text: '🟢 Election Live', value: 'Live' },
        upcoming: { text: '🟠 Election Not Started', value: 'Not Started' },
        closed: { text: '🔴 Election Closed', value: 'Closed' },
        paused: { text: '🟠 Election Paused', value: 'Paused' },
      };
      const badge = document.querySelector('#homeStatus');
      const statusText = document.querySelector('#homeStatusText');
      const dateNode = document.querySelector('#homeDate');
      if (badge) badge.textContent = label[status]?.text || label.live.text;
      if (statusText) statusText.textContent = label[status]?.value || 'Live';
      if (dateNode) dateNode.textContent = data.timer ? new Date(data.timer.end).toLocaleString() : 'Election date';
    })
    .catch(() => {
      const badge = document.querySelector('#homeStatus');
      if (badge) badge.textContent = '🟠 Election Not Started';
    });
}

function setupStudentLogin() {
  const form = document.querySelector('#studentLoginForm');
  const pinFieldWrapper = document.querySelector('#pinFieldWrapper');
  const loginStatusBadge = document.querySelector('#loginStatusBadge');
  if (!form) return;

  fetchElectionCached()
    .then((data) => {
      const state = data.status || 'live';
      if (loginStatusBadge) {
        const label = {
          live: '🟢 Election Live',
          upcoming: '🟠 Election Not Started',
          closed: '🔴 Election Closed',
          paused: '🟠 Election Paused',
        };
        loginStatusBadge.textContent = label[state] || '🟢 Election Live';
      }
      if (state === 'live' && data && data.settings && data.settings.requirePin) {
        pinFieldWrapper.classList.remove('hidden');
      }
    })
    .catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const studentId = document.querySelector('#studentId').value.trim();
    const pin = document.querySelector('#pin')?.value || '';
    const messageNode = document.querySelector('#loginMessage');

    try {
      const result = await apiRequest('/api/student/login', {
        method: 'POST',
        body: JSON.stringify({ studentId, pin }),
      });

      if (result.success) {
        sessionStorage.setItem('studentId', result.studentId);
        sessionStorage.setItem('studentSessionId', result.sessionId);
        window.location.href = '/student-vote.html';
      } else {
        showMessage(messageNode, result.message, true);
      }
    } catch (error) {
      showMessage(messageNode, error.message || 'Unable to log in. Please try again.', true);
    }
  });
}

function formatCountdown(targetTime) {
  const end = new Date(targetTime).getTime();
  const now = Date.now();
  const remaining = Math.max(end - now, 0);

  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function setupBallotPage() {
  const form = document.querySelector('#voteForm');
  const loader = document.querySelector('#ballotLoader');
  const notice = document.querySelector('#voteNotice');
  const studentId = safeGetId('studentId');
  const sessionId = safeGetId('studentSessionId');

  if (!studentId || !sessionId) {
    window.location.href = '/student-login.html';
    return;
  }

  async function loadBallot() {
    try {
      const result = await apiRequest(`/api/student/ballot?studentId=${encodeURIComponent(studentId)}&sessionId=${encodeURIComponent(sessionId)}`);
      if (!result.success) {
        showMessage(notice, result.message, true);
        notice.style.display = 'block';
        loader.classList.add('hidden');
        return;
      }

      const election = await fetchElectionCached();
      const countdown = document.querySelector('#countdownTimer');
      if (countdown && election.timer && election.timer.end) {
        countdown.textContent = formatCountdown(election.timer.end);
        setInterval(() => {
          countdown.textContent = formatCountdown(election.timer.end);
        }, 1000);
      }

      const ballot = result.ballot || [];
      loader.classList.add('hidden');
      form.classList.remove('hidden');

      if (!ballot.length) {
        form.innerHTML = '<div class="panel"><h3>No positions available.</h3></div>';
        return;
      }

      form.innerHTML = ballot.map((position) => {
        const alreadyVoted = position.alreadyVoted;
        const candidateCards = (position.candidates || []).map((candidate) => `
          <div class="candidate-card">
            <img class="candidate-photo" src="${candidate.photo || 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=800&q=80'}" alt="${candidate.fullName}" />
            <h3>${candidate.fullName}</h3>
            <p class="muted">Class: ${candidate.className || 'N/A'}</p>
            <p class="muted">${candidate.slogan || 'Campaign slogan'}</p>
            <div class="option-row">
              <label>
                <input type="radio" name="position-${position.id}" value="${candidate.id}" ${alreadyVoted ? 'disabled' : ''} />
                Select
              </label>
            </div>
          </div>
        `).join('');

        return `
          <section class="position-section">
            <div class="position-title">
              <h2>${position.name.toUpperCase()}</h2>
              ${alreadyVoted ? '<span class="status-badge">✓ Voted</span>' : ''}
            </div>
            <div class="candidate-grid">${candidateCards || '<p class="muted">No candidates available yet.</p>'}</div>
          </section>
        `;
      }).join('');

      const reviewButton = document.createElement('div');
      reviewButton.className = 'vote-actions';
      reviewButton.innerHTML = `
        <button type="button" class="secondary-btn" id="reviewVotesBtn">Review My Votes</button>
        <button type="submit" class="primary-btn">Submit Vote</button>
      `;
      form.appendChild(reviewButton);

      document.querySelector('#reviewVotesBtn')?.addEventListener('click', () => {
        const selections = {};
        ballot.forEach((position) => {
          const checked = form.querySelector(`input[name="position-${position.id}"]:checked`);
          if (checked) selections[position.id] = checked.value;
        });

        if (!Object.keys(selections).length) {
          showMessage(notice, 'Please select candidates before reviewing your votes.', true);
          notice.style.display = 'block';
          return;
        }

        const summary = ballot
          .filter((position) => selections[position.id])
          .map((position) => `${position.name}: ${position.candidates.find((candidate) => candidate.id === selections[position.id])?.fullName || 'Unknown'}`)
          .join('<br>');

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
    const radioGroups = form.querySelectorAll('input[type="radio"]:checked');

    radioGroups.forEach((radio) => {
      const name = radio.name.replace('position-', '');
      selections[name] = radio.value;
    });

    if (!Object.keys(selections).length) {
      showMessage(notice, 'Please select a candidate for each position.', true);
      notice.style.display = 'block';
      return;
    }

    try {
      const result = await apiRequest('/api/submit-vote', {
        method: 'POST',
        body: JSON.stringify({ studentId, sessionId, selections }),
      });

      if (result.success) {
        sessionStorage.removeItem('studentSessionId');
        notice.innerHTML = `Vote Successfully Recorded<br>Thank you for participating in the Kumasi STEM JHS Student Election.`;
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

function setupAdminLogin() {
  const form = document.querySelector('#adminLoginForm');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.querySelector('#adminUsername').value.trim();
    const password = document.querySelector('#adminPassword').value.trim();
    const messageNode = document.querySelector('#adminMessage');

    try {
      const result = await apiRequest('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });

      if (result.success) {
        sessionStorage.setItem('adminToken', result.token);
        window.location.href = '/admin.html';
      } else {
        showMessage(messageNode, result.message, true);
      }
    } catch (error) {
      showMessage(messageNode, error.message || 'Unable to log in as admin.', true);
    }
  });
}

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

  grid.innerHTML = cards.map((item) => `
    <div class="summary-card">
      <div class="label">${item.label}</div>
      <strong>${item.value}</strong>
    </div>
  `).join('');

  const statusBadge = document.querySelector('#adminStatusPill');
  if (statusBadge) {
    const statusMap = {
      live: '🟢 Election Live',
      upcoming: '🟠 Election Not Started',
      closed: '🔴 Election Closed',
      paused: '🟠 Election Paused',
    };
    statusBadge.textContent = statusMap[summary.electionStatus] || '🟢 Election Live';
  }
}

function renderPositions(positions) {
  const list = document.querySelector('#positionList');
  if (!list) return;
  list.innerHTML = (positions || []).map((position) => `
    <div class="list-item">
      <div>
        <strong>${position.name}</strong>
        <small>${position.status || 'active'}</small>
      </div>
      <div class="button-row">
        <button class="secondary-btn small-btn" data-action="edit-position" data-id="${position.id}">Edit</button>
        <button class="danger-btn small-btn" data-action="delete-position" data-id="${position.id}">Delete</button>
      </div>
    </div>
  `).join('');

  const select = document.querySelector('#candidatePositionInput');
  if (select) {
    select.innerHTML = (positions || []).map((position) => `<option value="${position.id}">${position.name}</option>`).join('');
  }
}

function renderCandidates(candidates) {
  const list = document.querySelector('#candidateList');
  if (!list) return;
  list.innerHTML = (candidates || []).map((candidate) => `
    <div class="list-item">
      <div>
        <strong>${candidate.fullName}</strong>
        <small>${candidate.positionId || 'N/A'} • ${candidate.className || 'N/A'}</small>
      </div>
      <div class="button-row">
        <button class="secondary-btn small-btn" data-action="edit-candidate" data-id="${candidate.id}">Edit</button>
        <button class="danger-btn small-btn" data-action="delete-candidate" data-id="${candidate.id}">Delete</button>
      </div>
    </div>
  `).join('');
}

function renderStudents(students) {
  const list = document.querySelector('#studentList');
  if (!list) return;
  list.innerHTML = (students || []).map((student) => `
    <div class="list-item">
      <div>
        <strong>${student.studentId}</strong>
        <small>${student.className || 'N/A'} • ${student.active ? 'Active' : 'Inactive'}</small>
      </div>
      <div class="button-row">
        <button class="secondary-btn small-btn" data-action="toggle-student" data-id="${student.id}">${student.active ? 'Disable' : 'Enable'}</button>
        <button class="danger-btn small-btn" data-action="delete-student" data-id="${student.id}">Delete</button>
      </div>
    </div>
  `).join('');
}

function renderResults(results) {
  const panel = document.querySelector('#resultsPanel');
  if (!panel) return;

  panel.innerHTML = (results?.positions || []).map((position) => {
    const candidateRows = (position.candidates || []).map((candidate) => `
      <div>
        <div class="result-header">
          <strong>${candidate.fullName}</strong>
          <span>${candidate.votes} votes</span>
        </div>
        <div class="progress-bar"><span style="width: ${candidate.percentage || 0}%"></span></div>
      </div>
    `).join('');

    return `
      <div class="result-block">
        <div class="result-header">
          <strong>${position.positionName}</strong>
          <span>${position.totalVotes} total votes</span>
        </div>
        ${candidateRows}
      </div>
    `;
  }).join('');
}

function renderAudit(logs) {
  const list = document.querySelector('#auditList');
  if (!list) return;
  list.innerHTML = (logs || []).map((entry) => `
    <div class="audit-item">
      <div>
        <strong>${entry.action}</strong>
        <small>${entry.actor || 'System'}</small>
      </div>
      <small>${new Date(entry.date).toLocaleString()}</small>
    </div>
  `).join('');
}

async function loadDashboard() {
  const token = sessionStorage.getItem('adminToken');
  if (!token) {
    window.location.href = '/admin-login.html';
    return;
  }

  try {
    const result = await apiRequest('/api/admin/summary', {
      headers: { 'x-admin-token': token },
    });

    renderSummaryCards(result.summary);
    renderPositions(result.positions);
    renderCandidates(result.candidates);
    renderStudents(result.students);
    renderResults(result.results);
    renderAudit(result.auditLog);

    const settings = result.settings || {};
    const schoolNameInput = document.querySelector('#schoolNameInput');
    const electionTitleInput = document.querySelector('#electionTitleInput');
    const resultsVisibilityInput = document.querySelector('#resultsVisibilityInput');
    if (schoolNameInput) schoolNameInput.value = settings.schoolName || '';
    if (electionTitleInput) electionTitleInput.value = settings.electionTitle || '';
    if (resultsVisibilityInput) resultsVisibilityInput.value = settings.resultsVisibility || 'live';
  } catch (error) {
    showMessage(document.querySelector('#adminMessage'), error.message || 'Unauthorized access.', true);
    window.location.href = '/admin-login.html';
  }
}

function bindAdminEvents() {
  const settingsForm = document.querySelector('#settingsForm');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        schoolName: document.querySelector('#schoolNameInput').value,
        electionTitle: document.querySelector('#electionTitleInput').value,
        resultsVisibility: document.querySelector('#resultsVisibilityInput').value,
      };
      const token = sessionStorage.getItem('adminToken');
      await apiRequest('/api/admin/settings', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify(payload),
      });
      loadDashboard();
    });
  }

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      const token = sessionStorage.getItem('adminToken');
      const payload = { action };

      if (action === 'close') {
        const confirmClose = window.confirm('Are you sure you want to close the election? Voting will no longer be possible after this action.');
        if (!confirmClose) return;
      }

      if (action.startsWith('edit-')) {
        return;
      }

      if (action.startsWith('delete-')) {
        const id = button.dataset.id;
        const endpoint = action.includes('position') ? `/api/admin/positions/${id}` : action.includes('candidate') ? `/api/admin/candidates/${id}` : `/api/admin/students/${id}`;
        await apiRequest(endpoint, {
          method: 'DELETE',
          headers: { 'x-admin-token': token },
        });
        loadDashboard();
        return;
      }

      if (action === 'toggle-student') {
        const id = button.dataset.id;
        const student = (await apiRequest('/api/admin/summary', { headers: { 'x-admin-token': token } })).students.find((entry) => entry.id === id);
        await apiRequest(`/api/admin/students/${id}`, {
          method: 'PUT',
          headers: { 'x-admin-token': token },
          body: JSON.stringify({ active: !student.active }),
        });
        loadDashboard();
        return;
      }

      await apiRequest('/api/admin/election/control', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify(payload),
      });
      loadDashboard();
    });
  });

  const positionForm = document.querySelector('#positionForm');
  if (positionForm) {
    positionForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = sessionStorage.getItem('adminToken');
      const name = document.querySelector('#positionNameInput').value.trim();
      await apiRequest('/api/admin/positions', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify({ name }),
      });
      positionForm.reset();
      loadDashboard();
    });
  }

  const candidateForm = document.querySelector('#candidateForm');
  if (candidateForm) {
    candidateForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = sessionStorage.getItem('adminToken');
      const payload = {
        positionId: document.querySelector('#candidatePositionInput').value,
        fullName: document.querySelector('#candidateNameInput').value.trim(),
        className: document.querySelector('#candidateClassInput').value.trim(),
        photo: document.querySelector('#candidatePhotoInput').value.trim(),
        slogan: document.querySelector('#candidateSloganInput').value.trim(),
      };
      await apiRequest('/api/admin/candidates', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify(payload),
      });
      candidateForm.reset();
      loadDashboard();
    });
  }

  const studentForm = document.querySelector('#studentForm');
  if (studentForm) {
    studentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = sessionStorage.getItem('adminToken');
      const payload = {
        studentId: document.querySelector('#studentIdInput').value.trim(),
        className: document.querySelector('#studentClassInput').value.trim(),
        active: true,
      };
      await apiRequest('/api/admin/students', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify(payload),
      });
      studentForm.reset();
      loadDashboard();
    });
  }
}

function initPage() {
  renderHomeStatus();
  setupStudentLogin();
  setupBallotPage();
  setupAdminLogin();
  bindAdminEvents();

  const isAdminPage = window.location.pathname.endsWith('/admin.html');
  if (isAdminPage) {
    loadDashboard();
  }
}

window.addEventListener('DOMContentLoaded', initPage);
