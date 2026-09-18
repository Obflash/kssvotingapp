const express = require('express');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();
const fs = require('fs');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;
const serverStart = new Date();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const demoAdmin = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
};

let state = createInitialState();
let adminSession = { authenticated: false, username: null, token: null };
// simple server-side cache to protect /api/election from rapid bursts
let electionResponseCache = { ts: 0, data: null };

// Postgres / Supabase connection
let dbClient = null;
let dbConnected = false;

async function initDb() {
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;
  if (!dbUrl) {
    console.log('No DATABASE_URL provided; running in in-memory demo mode.');
    return;
  }

  dbClient = new Client({ connectionString: dbUrl });
  try {
    await dbClient.connect();
    dbConnected = true;
    console.log('Connected to Postgres at', dbUrl.replace(/:\/\/.*@/, '://***@'));

    // run schema if present to ensure tables exist (idempotent)
    try {
      const schemaPath = path.join(__dirname, 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        await dbClient.query(sql);
        console.log('Database schema applied successfully.');
      }
    } catch (schemaErr) {
      console.warn('Failed to apply schema.sql:', schemaErr.message || schemaErr);
    }
  } catch (err) {
    console.warn('Unable to connect to Postgres:', err.message || err);
    dbClient = null;
    dbConnected = false;
  }

  // try Supabase REST client if configured, prefer service role then secret keys
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (supabaseUrl) {
      const keyCandidates = [
        { name: 'service_role', key: process.env.SUPABASE_SERVICE_ROLE_KEY },
        { name: 'secret', key: process.env.SUPABASE_SECRET_KEY },
        { name: 'super_secret', key: process.env.SUPABASE_SUPER_SECRET_KEY },
      ];

      for (const candidate of keyCandidates) {
        if (!candidate.key) continue;
        try {
          const client = createSupabaseClient(supabaseUrl, candidate.key, { auth: { persistSession: false } });
          const { data, error } = await client.from('elections').select('id').limit(1);
          if (error) {
            console.warn(`Supabase test with key ${candidate.name} failed:`, error.message || error);
            continue;
          }
          global.supabase = client;
          global.supabaseKeyUsed = candidate.name;
          console.log(`Connected to Supabase at ${supabaseUrl.replace(/https?:\/\//, '')} using key: ${candidate.name}`);
          dbConnected = true;
          break;
        } catch (innerErr) {
          console.warn(`Supabase init attempt (${candidate.name}) error:`, innerErr && innerErr.message ? innerErr.message : innerErr);
          continue;
        }
      }
      if (!global.supabase) {
        console.warn('No valid Supabase key succeeded; Supabase client not initialized.');
      }
    }
  } catch (supErr) {
    console.warn('Error initializing Supabase client:', supErr && supErr.message ? supErr.message : supErr);
    global.supabase = null;
  }
}

// lightweight in-memory request log for debugging client reloads
state.requestLog = state.requestLog || [];

app.use((req, res, next) => {
  try {
    state.requestLog.unshift({
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip || req.connection.remoteAddress,
      ua: req.headers['user-agent'] || '',
    });
    if (state.requestLog.length > 1000) state.requestLog.pop();
  } catch (e) {
    // ignore logging errors
  }
  next();
});

// temporary per-IP rate limiter for API endpoints to prevent rapid client bursts
const rateMap = {};
const RATE_WINDOW_MS = 1000; // 1s window
const RATE_MAX_REQ = 8; // max requests per window per IP

app.use((req, res, next) => {
  try {
    if (!req.path.startsWith('/api/')) return next();
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    rateMap[ip] = rateMap[ip] || [];
    rateMap[ip] = rateMap[ip].filter((ts) => now - ts < RATE_WINDOW_MS);
    rateMap[ip].push(now);
    if (rateMap[ip].length > RATE_MAX_REQ) {
      state.requestLog.unshift({ time: new Date().toISOString(), method: req.method, path: req.path, ip, ua: req.headers['user-agent'] || '', note: 'rate-limited' });
      if (state.requestLog.length > 1000) state.requestLog.pop();
      return sendJson(res, { success: false, message: 'Too many requests — temporarily rate limited.' }, 429);
    }
  } catch (e) {
    // ignore
  }
  return next();
});

function createInitialState() {
  const now = new Date();
  const startDate = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
  const endDate = new Date(now.getTime() + 28 * 60 * 60 * 1000).toISOString();

  const positions = [
    { id: 'pos-1', name: 'School President', displayOrder: 1, status: 'active' },
    { id: 'pos-2', name: 'Vice President', displayOrder: 2, status: 'active' },
    { id: 'pos-3', name: 'General Secretary', displayOrder: 3, status: 'active' },
    { id: 'pos-4', name: 'Treasurer', displayOrder: 4, status: 'active' },
  ];

  const candidates = [
    { id: 'cand-1', positionId: 'pos-1', fullName: 'John Mensah', className: 'JHS 3A', photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=600&q=80', manifesto: 'Committed to student welfare and school leadership.', slogan: 'Lead with service', status: 'active' },
    { id: 'cand-2', positionId: 'pos-1', fullName: 'Mary Owusu', className: 'JHS 3B', photo: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=600&q=80', manifesto: 'Promote teamwork and academic excellence.', slogan: 'Together we rise', status: 'active' },
    { id: 'cand-3', positionId: 'pos-2', fullName: 'Kwame Boateng', className: 'JHS 3A', photo: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=600&q=80', manifesto: 'Create strong student representation and support.', slogan: 'Voice for every student', status: 'active' },
    { id: 'cand-4', positionId: 'pos-2', fullName: 'Efua Sarpong', className: 'JHS 3C', photo: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=600&q=80', manifesto: 'Support fairness, discipline and teamwork.', slogan: 'Unity first', status: 'active' },
    { id: 'cand-5', positionId: 'pos-3', fullName: 'Nana Asare', className: 'JHS 2A', photo: 'https://images.unsplash.com/photo-1504593811423-6dd665756598?auto=format&fit=crop&w=600&q=80', manifesto: 'Organise events and keep communication strong.', slogan: 'Organise, inform, inspire', status: 'active' },
    { id: 'cand-6', positionId: 'pos-3', fullName: 'Ama Akoto', className: 'JHS 2B', photo: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=600&q=80', manifesto: 'Improve student engagement and records.', slogan: 'Record, report, rise', status: 'active' },
    { id: 'cand-7', positionId: 'pos-4', fullName: 'Kojo Annan', className: 'JHS 3A', photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=600&q=80', manifesto: 'Manage resources transparently and responsibly.', slogan: 'Smart funds, smart future', status: 'active' },
    { id: 'cand-8', positionId: 'pos-4', fullName: 'Adwoa Ampah', className: 'JHS 3B', photo: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=600&q=80', manifesto: 'Strengthen finance accountability and planning.', slogan: 'Every cedi counts', status: 'active' },
  ];

  const eligibleStudents = [
    { id: 'stu-1', studentId: 'STU-1001', className: 'JHS 1A', active: true, pin: '1234' },
    { id: 'stu-2', studentId: 'STU-1002', className: 'JHS 1B', active: true, pin: '1234' },
    { id: 'stu-3', studentId: 'STU-1003', className: 'JHS 2A', active: true, pin: '1234' },
    { id: 'stu-4', studentId: 'STU-1004', className: 'JHS 2B', active: true, pin: '1234' },
    { id: 'stu-5', studentId: 'STU-1005', className: 'JHS 3A', active: true, pin: '1234' },
    { id: 'stu-6', studentId: 'STU-1006', className: 'JHS 3B', active: true, pin: '1234' },
    { id: 'stu-7', studentId: 'STU-1007', className: 'JHS 1A', active: true, pin: '1234' },
    { id: 'stu-8', studentId: 'STU-1008', className: 'JHS 2A', active: true, pin: '1234' },
    { id: 'stu-9', studentId: 'STU-1009', className: 'JHS 3A', active: true, pin: '1234' },
    { id: 'stu-10', studentId: 'STU-1010', className: 'JHS 3C', active: true, pin: '1234' },
  ];

  const votes = [
    { id: 'vote-1', electionId: 'election-1', positionId: 'pos-1', candidateId: 'cand-1', studentId: 'STU-1001', voterReference: 'anon-1001', submittedAt: new Date().toISOString() },
    { id: 'vote-2', electionId: 'election-1', positionId: 'pos-2', candidateId: 'cand-3', studentId: 'STU-1001', voterReference: 'anon-1001-b', submittedAt: new Date().toISOString() },
    { id: 'vote-3', electionId: 'election-1', positionId: 'pos-3', candidateId: 'cand-5', studentId: 'STU-1002', voterReference: 'anon-1002', submittedAt: new Date().toISOString() },
    { id: 'vote-4', electionId: 'election-1', positionId: 'pos-4', candidateId: 'cand-7', studentId: 'STU-1002', voterReference: 'anon-1002-b', submittedAt: new Date().toISOString() },
    { id: 'vote-5', electionId: 'election-1', positionId: 'pos-1', candidateId: 'cand-2', studentId: 'STU-1003', voterReference: 'anon-1003', submittedAt: new Date().toISOString() },
  ];

  const settings = {
    schoolName: 'Kumasi STEM JHS',
    schoolLogo: '',
    electionTitle: 'Kumasi STEM JHS Student Election Portal',
    electionSubtitle: 'Secure • Simple • Fair • One Student, One Vote',
    electionDescription: 'School leadership election for the 2026 academic year.',
    electionStartDate: startDate,
    electionEndDate: endDate,
    timezone: 'Africa/Accra',
    studentAuthMethod: 'student-id',
    requirePin: true,
    resultsVisibility: 'live',
    liveResultsInterval: 5,
    publicResults: true,
    electionState: 'live',
  };

  return {
    electionId: 'election-1',
    settings,
    positions,
    candidates,
    eligibleStudents,
    votes,
    auditLog: [
      { id: 'log-1', action: 'Election started', actor: 'Administrator', date: new Date().toISOString() },
      { id: 'log-2', action: 'Candidate added', actor: 'Administrator', date: new Date().toISOString() },
      { id: 'log-3', action: 'Student import complete', actor: 'Administrator', date: new Date().toISOString() },
    ],
    failedLogins: [],
  };
}

function normalizeStudentId(value) {
  return (value || '').trim().toUpperCase();
}

function getElectionStatus() {
  const now = new Date();
  const start = new Date(state.settings.electionStartDate);
  const end = new Date(state.settings.electionEndDate);

  if (state.settings.electionState === 'closed') return 'closed';
  if (state.settings.electionState === 'paused') return 'paused';
  if (now < start) return 'upcoming';
  if (now > end) return 'closed';
  return 'live';
}

function computeVotesForCandidate(candidateId) {
  return state.votes.filter((vote) => vote.candidateId === candidateId).length;
}

function computeResults() {
  const positionResults = state.positions.map((position) => {
    const candidateEntries = state.candidates
      .filter((candidate) => candidate.positionId === position.id && candidate.status !== 'inactive')
      .map((candidate) => {
        const votesForCandidate = computeVotesForCandidate(candidate.id);
        return {
          ...candidate,
          votes: votesForCandidate,
        };
      });

    const totalVotes = candidateEntries.reduce((sum, candidate) => sum + candidate.votes, 0);
    const leader = candidateEntries.reduce((winner, candidate) => {
      if (!winner || candidate.votes > winner.votes) return candidate;
      return winner;
    }, null);

    return {
      positionId: position.id,
      positionName: position.name,
      totalVotes,
      leader: leader ? { id: leader.id, fullName: leader.fullName, votes: leader.votes } : null,
      candidates: candidateEntries.map((candidate) => ({
        ...candidate,
        percentage: totalVotes > 0 ? ((candidate.votes / totalVotes) * 100).toFixed(1) : '0.0',
      })),
    };
  });

  const uniqueVoters = new Set(state.votes.map((vote) => vote.studentId));
  const totalEligible = state.eligibleStudents.filter((student) => student.active).length;
  const totalVoted = uniqueVoters.size;

  return {
    totalEligible,
    totalVoted,
    turnoutPercentage: totalEligible > 0 ? ((totalVoted / totalEligible) * 100).toFixed(1) : '0.0',
    positions: positionResults,
  };
}

function addAuditLog(action, actor, details) {
  state.auditLog.unshift({
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    action,
    actor,
    details,
    date: new Date().toISOString(),
  });
}

function sendJson(res, payload, status = 200) {
  return res.status(status).json(payload);
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (adminSession.authenticated && adminSession.token === token) {
    return next();
  }
  return sendJson(res, { success: false, message: 'Unauthorized access.' }, 401);
}

app.get('/api/health', (req, res) => {
  sendJson(res, {
    ok: true,
    electionStatus: getElectionStatus(),
    timestamp: new Date().toISOString(),
    dbConnected: Boolean(dbConnected),
  });
});

app.get('/api/uptime', (req, res) => {
  sendJson(res, {
    ok: true,
    uptimeSeconds: process.uptime(),
    serverStart: serverStart.toISOString(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/request-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  sendJson(res, { success: true, logs: state.requestLog.slice(0, limit) });
});

app.get('/api/election', (req, res) => {
  const now = Date.now();
  if (electionResponseCache.data && now - electionResponseCache.ts < 1000) {
    return sendJson(res, electionResponseCache.data);
  }

  const summary = computeResults();
  const payload = {
    success: true,
    schoolName: state.settings.schoolName,
    title: state.settings.electionTitle,
    subtitle: state.settings.electionSubtitle,
    description: state.settings.electionDescription,
    status: getElectionStatus(),
    settings: state.settings,
    timer: {
      start: state.settings.electionStartDate,
      end: state.settings.electionEndDate,
      timezone: state.settings.timezone,
    },
    positions: state.positions.map((position) => ({
      ...position,
      candidates: state.candidates.filter((candidate) => candidate.positionId === position.id && candidate.status !== 'inactive'),
    })),
    eligibleStudents: state.eligibleStudents.length,
    summary,
  };

  electionResponseCache = { ts: now, data: payload };
  return sendJson(res, payload);
});

app.post('/api/student/login', (req, res) => {
  const studentId = normalizeStudentId(req.body.studentId || '');
  const pin = (req.body.pin || '').toString();
  const eligibleStudent = state.eligibleStudents.find((student) => student.studentId === studentId && student.active);

  if (!eligibleStudent) {
    return sendJson(res, { success: false, message: 'Student ID not recognised. Please contact the election administrator.' }, 401);
  }

  const electionStatus = getElectionStatus();

  if (electionStatus === 'upcoming') {
    return sendJson(res, { success: false, message: 'The election has not started yet.' }, 403);
  }

  if (electionStatus === 'closed') {
    return sendJson(res, { success: false, message: 'The election has ended. Voting is no longer available.' }, 403);
  }

  if (state.settings.requirePin && state.settings.studentAuthMethod === 'pin') {
    if (!pin || pin !== eligibleStudent.pin) {
      state.failedLogins.push({ studentId, reason: 'invalid-pin', timestamp: new Date().toISOString() });
      return sendJson(res, { success: false, message: 'Student ID or PIN is incorrect.' }, 401);
    }
  }

  const allPositions = state.positions.filter((pos) => pos.status !== 'inactive');
  const completedVotes = allPositions.filter((pos) => state.votes.some((vote) => vote.studentId === studentId && vote.positionId === pos.id)).length;

  if (completedVotes >= allPositions.length) {
    return sendJson(res, { success: false, message: 'You have successfully completed your voting. Thank you for participating.' }, 200);
  }

  const sessionId = `session-${studentId}-${Date.now()}`;
  state.studentSessions = state.studentSessions || {};
  state.studentSessions[studentId] = { sessionId, loggedInAt: new Date().toISOString() };

  return sendJson(res, { success: true, studentId, sessionId, message: 'Login successful.' });
});

app.get('/api/student/ballot', (req, res) => {
  const studentId = normalizeStudentId(req.query.studentId || '');
  const sessionId = req.query.sessionId || '';
  const session = state.studentSessions && state.studentSessions[studentId];

  if (!session || session.sessionId !== sessionId) {
    return sendJson(res, { success: false, message: 'Session expired. Please log in again.' }, 401);
  }

  if (getElectionStatus() === 'closed') {
    return sendJson(res, { success: false, message: 'The election has ended. Voting is no longer available.' }, 403);
  }

  const ballot = state.positions
    .filter((position) => position.status !== 'inactive')
    .map((position) => ({
      ...position,
      alreadyVoted: state.votes.some((vote) => vote.studentId === studentId && vote.positionId === position.id),
      candidates: state.candidates.filter((candidate) => candidate.positionId === position.id && candidate.status !== 'inactive'),
    }));

  return sendJson(res, { success: true, ballot, studentId });
});

app.post('/api/submit-vote', (req, res) => {
  const { studentId, sessionId, selections } = req.body || {};
  const normalizedStudentId = normalizeStudentId(studentId || '');
  const session = state.studentSessions && state.studentSessions[normalizedStudentId];

  if (!session || session.sessionId !== sessionId) {
    return sendJson(res, { success: false, message: 'Session expired. Please log in again.' }, 401);
  }

  if (getElectionStatus() !== 'live') {
    return sendJson(res, { success: false, message: 'Voting is not open at the moment.' }, 403);
  }

  if (!selections || !Object.keys(selections).length) {
    return sendJson(res, { success: false, message: 'Please select a candidate for each available position.' }, 400);
  }

  const positionIds = state.positions.filter((pos) => pos.status !== 'inactive').map((pos) => pos.id);
  const submitted = Object.entries(selections);

  for (const [positionId, candidateId] of submitted) {
    if (!positionIds.includes(positionId)) {
      return sendJson(res, { success: false, message: 'Invalid position submission.' }, 400);
    }

    const candidate = state.candidates.find((entry) => entry.id === candidateId && entry.positionId === positionId && entry.status !== 'inactive');
    if (!candidate) {
      return sendJson(res, { success: false, message: 'Missing candidate. Please review your choices.' }, 400);
    }

    const alreadyVoted = state.votes.some((vote) => vote.studentId === normalizedStudentId && vote.positionId === positionId);
    if (alreadyVoted) {
      return sendJson(res, { success: false, message: 'You have already voted for this position.' }, 409);
    }
  }

  const savedVotes = [];
  for (const [positionId, candidateId] of submitted) {
    const vote = {
      id: `vote-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      electionId: state.electionId,
      positionId,
      candidateId,
      studentId: normalizedStudentId,
      voterReference: `anon-${normalizedStudentId}`,
      submittedAt: new Date().toISOString(),
    };
    state.votes.push(vote);
    savedVotes.push({ positionId, candidateId });
  }

  addAuditLog('Vote submitted', normalizedStudentId, { voteCount: savedVotes.length });

  return sendJson(res, {
    success: true,
    message: 'Vote Successfully Recorded',
    votes: savedVotes,
    electionName: state.settings.electionTitle,
    submittedAt: new Date().toISOString(),
  });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === demoAdmin.username && password === demoAdmin.password) {
    adminSession = {
      authenticated: true,
      username,
      token: `admin-${Date.now()}`,
    };
    return sendJson(res, { success: true, token: adminSession.token, username });
  }

  return sendJson(res, { success: false, message: 'Invalid administrator credentials.' }, 401);
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const uniqueVoters = new Set(state.votes.map((vote) => vote.studentId));
  const totalEligible = state.eligibleStudents.filter((student) => student.active).length;
  const votedCount = uniqueVoters.size;
  const notVoted = Math.max(totalEligible - votedCount, 0);
  const turnout = totalEligible > 0 ? ((votedCount / totalEligible) * 100).toFixed(1) : '0.0';

  const results = computeResults();
  const electionStatus = getElectionStatus();

  sendJson(res, {
    success: true,
    summary: {
      totalEligible,
      votedCount,
      notVoted,
      totalVotesCast: state.votes.length,
      turnout,
      electionStatus,
      positions: state.positions.length,
      candidates: state.candidates.length,
    },
    results,
    positions: state.positions,
    candidates: state.candidates,
    students: state.eligibleStudents,
    auditLog: state.auditLog.slice(0, 20),
    settings: state.settings,
  });
});

app.post('/api/admin/positions', requireAdmin, (req, res) => {
  const { name, status = 'active', displayOrder = state.positions.length + 1 } = req.body || {};
  if (!name) return sendJson(res, { success: false, message: 'Position name is required.' }, 400);

  const newPosition = {
    id: `pos-${Date.now()}`,
    name,
    status,
    displayOrder: Number(displayOrder),
  };
  state.positions.push(newPosition);
  addAuditLog('Position added', adminSession.username, { position: name });
  sendJson(res, { success: true, position: newPosition });
});

app.put('/api/admin/positions/:id', requireAdmin, (req, res) => {
  const position = state.positions.find((item) => item.id === req.params.id);
  if (!position) return sendJson(res, { success: false, message: 'Position not found.' }, 404);

  Object.assign(position, {
    name: req.body.name || position.name,
    status: req.body.status || position.status,
    displayOrder: Number(req.body.displayOrder || position.displayOrder),
  });

  addAuditLog('Position updated', adminSession.username, { positionId: position.id });
  sendJson(res, { success: true, position });
});

app.delete('/api/admin/positions/:id', requireAdmin, (req, res) => {
  const before = state.positions.length;
  state.positions = state.positions.filter((position) => position.id !== req.params.id);
  state.candidates = state.candidates.filter((candidate) => candidate.positionId !== req.params.id);
  if (state.positions.length === before) return sendJson(res, { success: false, message: 'Position not found.' }, 404);

  addAuditLog('Position removed', adminSession.username, { positionId: req.params.id });
  sendJson(res, { success: true, message: 'Position removed.' });
});

app.post('/api/admin/candidates', requireAdmin, (req, res) => {
  const { positionId, fullName, className, photo, manifesto, slogan, status = 'active', studentId = '' } = req.body || {};
  if (!positionId || !fullName) return sendJson(res, { success: false, message: 'Position and full name are required.' }, 400);

  const newCandidate = {
    id: `cand-${Date.now()}`,
    positionId,
    studentId,
    fullName,
    className,
    photo: photo || 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=800&q=80',
    manifesto: manifesto || 'Candidate manifesto not provided.',
    slogan: slogan || 'Vote for change',
    status,
  };

  state.candidates.push(newCandidate);
  addAuditLog('Candidate added', adminSession.username, { fullName, positionId });
  sendJson(res, { success: true, candidate: newCandidate });
});

app.put('/api/admin/candidates/:id', requireAdmin, (req, res) => {
  const candidate = state.candidates.find((item) => item.id === req.params.id);
  if (!candidate) return sendJson(res, { success: false, message: 'Candidate not found.' }, 404);

  Object.assign(candidate, {
    positionId: req.body.positionId || candidate.positionId,
    fullName: req.body.fullName || candidate.fullName,
    className: req.body.className || candidate.className,
    photo: req.body.photo || candidate.photo,
    manifesto: req.body.manifesto || candidate.manifesto,
    slogan: req.body.slogan || candidate.slogan,
    status: req.body.status || candidate.status,
    studentId: req.body.studentId || candidate.studentId,
  });

  addAuditLog('Candidate updated', adminSession.username, { candidateId: candidate.id });
  sendJson(res, { success: true, candidate });
});

app.delete('/api/admin/candidates/:id', requireAdmin, (req, res) => {
  const candidate = state.candidates.find((item) => item.id === req.params.id);
  if (!candidate) return sendJson(res, { success: false, message: 'Candidate not found.' }, 404);

  state.candidates = state.candidates.filter((item) => item.id !== req.params.id);
  addAuditLog('Candidate removed', adminSession.username, { candidateId: req.params.id });
  sendJson(res, { success: true, message: 'Candidate removed.' });
});

app.post('/api/admin/students', requireAdmin, (req, res) => {
  const { studentId, className, active = true } = req.body || {};
  if (!studentId) return sendJson(res, { success: false, message: 'Student ID is required.' }, 400);

  const normalizedStudentId = normalizeStudentId(studentId);
  const exists = state.eligibleStudents.some((student) => student.studentId === normalizedStudentId);
  if (exists) return sendJson(res, { success: false, message: 'Student ID already exists.' }, 409);

  const student = { id: `stu-${Date.now()}`, studentId: normalizedStudentId, className, active, pin: '1234' };
  state.eligibleStudents.push(student);
  addAuditLog('Student added', adminSession.username, { studentId: normalizedStudentId });
  sendJson(res, { success: true, student });
});

app.put('/api/admin/students/:id', requireAdmin, (req, res) => {
  const student = state.eligibleStudents.find((item) => item.id === req.params.id);
  if (!student) return sendJson(res, { success: false, message: 'Student not found.' }, 404);

  student.studentId = normalizeStudentId(req.body.studentId || student.studentId);
  student.className = req.body.className || student.className;
  student.active = req.body.active !== undefined ? Boolean(req.body.active) : student.active;

  addAuditLog('Student updated', adminSession.username, { studentId: student.studentId });
  sendJson(res, { success: true, student });
});

app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
  const student = state.eligibleStudents.find((item) => item.id === req.params.id);
  if (!student) return sendJson(res, { success: false, message: 'Student not found.' }, 404);

  state.eligibleStudents = state.eligibleStudents.filter((item) => item.id !== req.params.id);
  addAuditLog('Student removed', adminSession.username, { studentId: student.studentId });
  sendJson(res, { success: true, message: 'Student removed.' });
});

app.post('/api/admin/election/control', requireAdmin, (req, res) => {
  const { action } = req.body || {};

  if (!['start', 'pause', 'resume', 'close'].includes(action)) {
    return sendJson(res, { success: false, message: 'Invalid election action.' }, 400);
  }

  if (action === 'start') state.settings.electionState = 'live';
  if (action === 'pause') state.settings.electionState = 'paused';
  if (action === 'resume') state.settings.electionState = 'live';
  if (action === 'close') state.settings.electionState = 'closed';

  addAuditLog(`Election ${action}ed`, adminSession.username, { action });
  sendJson(res, { success: true, message: `Election ${action}ed.`, status: getElectionStatus() });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const nextSettings = { ...state.settings, ...req.body };
  state.settings = nextSettings;
  addAuditLog('Election settings changed', adminSession.username, { summary: nextSettings.electionTitle });
  sendJson(res, { success: true, settings: state.settings });
});

app.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  sendJson(res, { success: true, logs: state.auditLog });
});

// Local-only endpoint to re-run DB / Supabase initialization without restarting the server
app.post('/api/reconnect-db', async (req, res) => {
  const ip = req.ip || req.connection && req.connection.remoteAddress || '';
  const allowed = ip === '::1' || ip === '127.0.0.1' || (typeof ip === 'string' && ip.startsWith('::ffff:127.0.0.1'));
  if (!allowed) return sendJson(res, { success: false, message: 'Forbidden' }, 403);

  try {
    await initDb();
    return sendJson(res, { success: true, dbConnected: Boolean(dbConnected) });
  } catch (err) {
    return sendJson(res, { success: false, error: (err && err.message) || String(err) }, 500);
  }
});

app.get('/api/results', (req, res) => {
  const visibility = state.settings.resultsVisibility || 'live';
  const status = getElectionStatus();
  if (visibility === 'hidden' || (!state.settings.publicResults && status !== 'closed')) {
    return sendJson(res, { success: true, public: false, message: 'Results are currently hidden.' });
  }

  return sendJson(res, {
    success: true,
    public: true,
    status: status === 'closed' ? 'FINAL RESULTS' : 'LIVE / UNOFFICIAL RESULTS',
    results: computeResults(),
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  const requestedPath = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  const filePath = path.join(__dirname, 'public', requestedPath);
  const fileExists = require('fs').existsSync(filePath) && !require('fs').statSync(filePath).isDirectory();

  if (fileExists) {
    return res.sendFile(filePath);
  }

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async function start() {
  try {
    await initDb();
  } catch (e) {
    console.warn('initDb() error:', e && e.message ? e.message : e);
  }

  app.listen(port, () => {
    console.log(`Kumasi STEM JHS Student Election Portal is running on http://localhost:${port} (dbConnected=${Boolean(dbConnected)})`);
  });
})();

// If DB not connected at startup, attempt periodic reconnects in background
let _reconnectAttempts = 0;
const _maxReconnectAttempts = 60; // ~10 minutes if interval 10s
const _reconnectIntervalMs = 10000;
if (!dbConnected) {
  const _timer = setInterval(async () => {
    if (dbConnected || _reconnectAttempts >= _maxReconnectAttempts) {
      clearInterval(_timer);
      return;
    }
    _reconnectAttempts += 1;
    try {
      console.log(`Reconnect attempt ${_reconnectAttempts}...`);
      await initDb();
      if (dbConnected) console.log('DB connected after reconnect.');
    } catch (e) {
      console.warn('Reconnect attempt failed:', e && e.message ? e.message : e);
    }
  }, _reconnectIntervalMs);
}
