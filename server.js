const express = require('express');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');
const multer = require('multer');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;
const serverStart = new Date();

// ── Uploads directory for candidate photos ────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `photo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const demoAdmin = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
};

let state = createInitialState();
let adminSession = { authenticated: false, username: null, token: null };
let electionResponseCache = { ts: 0, data: null };

// ── Database ──────────────────────────────────────────────────────────────────
let dbClient = null;  // pool, used as dbClient throughout
let dbConnected = false;

async function dbQuery(sql, params = []) {
  if (dbClient && dbConnected) return dbClient.query(sql, params);
  throw new Error('Database not connected.');
}

async function initDb() {
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;
  if (!dbUrl) {
    console.log('No DATABASE_URL provided; running in in-memory demo mode.');
    return;
  }

  // Use a Pool so concurrent queries don't conflict
  dbClient = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
  try {
    // Test the pool with a simple query
    await dbClient.query('SELECT 1');
    dbConnected = true;
    console.log('Connected to Postgres at', dbUrl.replace(/:\/\/.*@/, '://***@'));

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

    // Seed initial election row if none exists
    await seedElectionIfNeeded();
  } catch (err) {
    console.warn('Unable to connect to Postgres:', err.message || err);
    dbClient = null;
    dbConnected = false;
  }

  // Supabase REST client
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
          if (error) { console.warn(`Supabase test with key ${candidate.name} failed:`, error.message); continue; }
          global.supabase = client;
          global.supabaseKeyUsed = candidate.name;
          console.log(`Supabase REST connected using key: ${candidate.name}`);
          break;
        } catch (e) { console.warn(`Supabase init (${candidate.name}):`, e && e.message ? e.message : e); }
      }
      if (!global.supabase) console.warn('No valid Supabase key succeeded.');
    }
  } catch (e) { console.warn('Supabase init error:', e && e.message ? e.message : e); }
}

// ── Seed a default election record ───────────────────────────────────────────
async function seedElectionIfNeeded() {
  try {
    const res = await dbClient.query('SELECT id FROM elections LIMIT 1');
    if (res.rows.length > 0) {
      state.dbElectionId = res.rows[0].id;
      console.log('Using existing DB election id:', state.dbElectionId);

      // Sync positions & candidates from DB into memory state
      await syncElectionFromDb();
      return;
    }

    // ── Create election ────────────────────────────────────────────────────────
    const now = new Date();
    const start = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const end   = new Date(now.getTime() + 28 * 60 * 60 * 1000);
    const ins = await dbClient.query(
      `INSERT INTO elections (name, subtitle, school_name, start_time, end_time, status, results_visibility)
       VALUES ($1,$2,$3,$4,$5,'live','live') RETURNING id`,
      [state.settings.electionTitle, state.settings.electionSubtitle, state.settings.schoolName, start, end]
    );
    state.dbElectionId = ins.rows[0].id;
    console.log('Seeded new DB election id:', state.dbElectionId);

    // ── Seed positions ─────────────────────────────────────────────────────────
    for (const pos of state.positions) {
      const pr = await dbClient.query(
        `INSERT INTO positions (election_id, name, display_order, status)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
        [state.dbElectionId, pos.name, pos.displayOrder, pos.status]
      );
      if (pr.rows.length > 0) pos.id = String(pr.rows[0].id);
    }
    console.log('Seeded', state.positions.length, 'positions to DB.');

    // ── Seed candidates ────────────────────────────────────────────────────────
    for (const cand of state.candidates) {
      // Match position by name since IDs have changed
      const pos = state.positions.find(p => p.id === cand.positionId);
      if (!pos) continue;
      const cr = await dbClient.query(
        `INSERT INTO candidates (election_id, position_id, full_name, class_name, photo_url, manifesto, slogan, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
        [state.dbElectionId, pos.id, cand.fullName, cand.className, cand.photo, cand.manifesto, cand.slogan, cand.status]
      );
      if (cr.rows.length > 0) cand.id = String(cr.rows[0].id);
      cand.positionId = pos.id; // update positionId to DB id
    }
    console.log('Seeded', state.candidates.length, 'candidates to DB.');

  } catch (e) {
    console.warn('seedElectionIfNeeded error:', e.message);
  }
}

// ── In-memory state (demo / fallback) ────────────────────────────────────────
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
    { id: 'stu-1', studentId: 'STU-1001', firstName: 'Kofi', lastName: 'Mensah', className: 'JHS 1A', sectionName: 'A', active: true, pin: '1234' },
    { id: 'stu-2', studentId: 'STU-1002', firstName: 'Ama', lastName: 'Owusu', className: 'JHS 1B', sectionName: 'B', active: true, pin: '1234' },
    { id: 'stu-3', studentId: 'STU-1003', firstName: 'Kwame', lastName: 'Boateng', className: 'JHS 2A', sectionName: 'A', active: true, pin: '1234' },
    { id: 'stu-4', studentId: 'STU-1004', firstName: 'Efua', lastName: 'Sarpong', className: 'JHS 2B', sectionName: 'B', active: true, pin: '1234' },
    { id: 'stu-5', studentId: 'STU-1005', firstName: 'Nana', lastName: 'Asare', className: 'JHS 3A', sectionName: 'A', active: true, pin: '1234' },
    { id: 'stu-6', studentId: 'STU-1006', firstName: 'Akosua', lastName: 'Akoto', className: 'JHS 3B', sectionName: 'B', active: true, pin: '1234' },
    { id: 'stu-7', studentId: 'STU-1007', firstName: 'Yaw', lastName: 'Annan', className: 'JHS 1A', sectionName: 'A', active: true, pin: '1234' },
    { id: 'stu-8', studentId: 'STU-1008', firstName: 'Abena', lastName: 'Ampah', className: 'JHS 2A', sectionName: 'A', active: true, pin: '1234' },
    { id: 'stu-9', studentId: 'STU-1009', firstName: 'Kojo', lastName: 'Amoah', className: 'JHS 3A', sectionName: 'A', active: true, pin: '1234' },
    { id: 'stu-10', studentId: 'STU-1010', firstName: 'Adwoa', lastName: 'Frimpong', className: 'JHS 3C', sectionName: 'C', active: true, pin: '1234' },
  ];

  const votes = [
    { id: 'vote-1', electionId: 'election-1', positionId: 'pos-1', candidateId: 'cand-1', studentId: 'STU-1001', submittedAt: new Date().toISOString() },
    { id: 'vote-2', electionId: 'election-1', positionId: 'pos-2', candidateId: 'cand-3', studentId: 'STU-1001', submittedAt: new Date().toISOString() },
    { id: 'vote-3', electionId: 'election-1', positionId: 'pos-3', candidateId: 'cand-5', studentId: 'STU-1002', submittedAt: new Date().toISOString() },
    { id: 'vote-4', electionId: 'election-1', positionId: 'pos-4', candidateId: 'cand-7', studentId: 'STU-1002', submittedAt: new Date().toISOString() },
    { id: 'vote-5', electionId: 'election-1', positionId: 'pos-1', candidateId: 'cand-2', studentId: 'STU-1003', submittedAt: new Date().toISOString() },
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
    dbElectionId: null,
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
    requestLog: [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeStudentId(value) { return (value || '').trim().toUpperCase(); }

function randomPin() {
  return String(Math.floor(Math.random() * 90000) + 10000); // 10000–99999
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
  return state.votes.filter((v) => v.candidateId === candidateId).length;
}

function computeResults() {
  const positionResults = state.positions.map((position) => {
    const candidateEntries = state.candidates
      .filter((c) => c.positionId === position.id && c.status !== 'inactive')
      .map((c) => ({ ...c, votes: computeVotesForCandidate(c.id) }));

    const totalVotes = candidateEntries.reduce((s, c) => s + c.votes, 0);
    const leader = candidateEntries.reduce((w, c) => (!w || c.votes > w.votes ? c : w), null);

    return {
      positionId: position.id,
      positionName: position.name,
      totalVotes,
      leader: leader ? { id: leader.id, fullName: leader.fullName, votes: leader.votes, photo: leader.photo, className: leader.className } : null,
      candidates: candidateEntries.map((c) => ({
        ...c,
        percentage: totalVotes > 0 ? ((c.votes / totalVotes) * 100).toFixed(1) : '0.0',
      })),
    };
  });

  const uniqueVoters = new Set(state.votes.map((v) => v.studentId));
  const totalEligible = state.eligibleStudents.filter((s) => s.active).length;
  const totalVoted = uniqueVoters.size;

  return {
    totalEligible,
    totalVoted,
    turnoutPercentage: totalEligible > 0 ? ((totalVoted / totalEligible) * 100).toFixed(1) : '0.0',
    positions: positionResults,
  };
}

// Vote breakdown by class and section
function computeClassSectionAnalytics() {
  const classMap = {};
  for (const vote of state.votes) {
    const voter = state.eligibleStudents.find((s) => s.studentId === vote.studentId);
    if (!voter) continue;
    const key = voter.className || 'Unknown';
    const secKey = voter.sectionName || '-';
    if (!classMap[key]) classMap[key] = { className: key, sections: {}, totalVotes: 0, voterIds: new Set() };
    if (!classMap[key].sections[secKey]) classMap[key].sections[secKey] = { sectionName: secKey, totalVotes: 0, voterIds: new Set() };
    classMap[key].totalVotes++;
    classMap[key].voterIds.add(vote.studentId);
    classMap[key].sections[secKey].totalVotes++;
    classMap[key].sections[secKey].voterIds.add(vote.studentId);
  }

  return Object.values(classMap).map((cls) => ({
    className: cls.className,
    uniqueVoters: cls.voterIds.size,
    totalVotesCast: cls.totalVotes,
    sections: Object.values(cls.sections).map((sec) => ({
      sectionName: sec.sectionName,
      uniqueVoters: sec.voterIds.size,
      totalVotesCast: sec.totalVotes,
    })),
  })).sort((a, b) => a.className.localeCompare(b.className));
}

function addAuditLog(action, actor, details) {
  state.auditLog.unshift({
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    action, actor, details,
    date: new Date().toISOString(),
  });

  // Persist to DB if connected
  if (dbConnected && dbClient && state.dbElectionId) {
    dbClient.query(
      'INSERT INTO audit_log (election_id, action, actor, details) VALUES ($1,$2,$3,$4)',
      [state.dbElectionId, action, actor, details ? JSON.stringify(details) : null]
    ).catch(() => {});
  }
}

function sendJson(res, payload, status = 200) { return res.status(status).json(payload); }

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (adminSession.authenticated && adminSession.token === token) return next();
  return sendJson(res, { success: false, message: 'Unauthorized access.' }, 401);
}

// ── Request logging middleware ─────────────────────────────────────────────────
app.use((req, res, next) => {
  try {
    state.requestLog.unshift({ time: new Date().toISOString(), method: req.method, path: req.path, ip: req.ip || req.connection.remoteAddress, ua: req.headers['user-agent'] || '' });
    if (state.requestLog.length > 1000) state.requestLog.pop();
  } catch (e) {}
  next();
});

// ── Rate limiter ──────────────────────────────────────────────────────────────
const rateMap = {};
const RATE_WINDOW_MS = 1000;
const RATE_MAX_REQ = 20; // relaxed for bulk CSV uploads

app.use((req, res, next) => {
  try {
    if (!req.path.startsWith('/api/')) return next();
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    rateMap[ip] = (rateMap[ip] || []).filter((ts) => now - ts < RATE_WINDOW_MS);
    rateMap[ip].push(now);
    if (rateMap[ip].length > RATE_MAX_REQ) {
      return sendJson(res, { success: false, message: 'Too many requests — temporarily rate limited.' }, 429);
    }
  } catch (e) {}
  return next();
});

// ── DB sync helpers ───────────────────────────────────────────────────────────
async function syncElectionFromDb() {
  if (!dbConnected || !dbClient || !state.dbElectionId) return;
  try {
    const eid = state.dbElectionId;

    const [elecRes, posRes, candRes, voterRes, voteRes] = await Promise.all([
      dbClient.query('SELECT * FROM elections WHERE id=$1', [eid]),
      dbClient.query('SELECT * FROM positions WHERE election_id=$1 ORDER BY display_order', [eid]),
      dbClient.query('SELECT * FROM candidates WHERE election_id=$1 ORDER BY id', [eid]),
      dbClient.query('SELECT * FROM eligible_voters WHERE election_id=$1 ORDER BY id', [eid]),
      dbClient.query('SELECT * FROM vote_records WHERE election_id=$1', [eid]),
    ]);

    // Sync election timing & status from DB
    if (elecRes.rows.length > 0) {
      const e = elecRes.rows[0];
      if (e.start_time) state.settings.electionStartDate = new Date(e.start_time).toISOString();
      if (e.end_time)   state.settings.electionEndDate   = new Date(e.end_time).toISOString();
      if (e.status)     state.settings.electionState     = e.status;
    }

    state.positions        = posRes.rows.map((r) => ({ id: String(r.id), name: r.name, displayOrder: r.display_order, status: r.status }));
    state.candidates       = candRes.rows.map((r) => ({ id: String(r.id), positionId: String(r.position_id), studentId: r.student_id || '', fullName: r.full_name, className: r.class_name || '', photo: r.photo_url || '', manifesto: r.manifesto || '', slogan: r.slogan || '', status: r.status }));
    state.eligibleStudents = voterRes.rows.map((r) => ({ id: String(r.id), studentId: r.student_id, firstName: r.first_name || '', middleName: r.middle_name || '', lastName: r.last_name || '', dateOfBirth: r.date_of_birth || null, gender: r.gender || '', email: r.email || '', phone: r.phone || '', className: r.class_name || '', sectionName: r.section_name || '', active: r.active, pin: r.pin || '', hasVoted: r.has_voted || false, votedAt: r.voted_at || null }));
    state.votes            = voteRes.rows.map((r) => ({ id: String(r.id), electionId: String(r.election_id), positionId: String(r.position_id), candidateId: String(r.candidate_id), studentId: r.student_id, submittedAt: r.submitted_at }));
    electionResponseCache  = { ts: 0, data: null };
  } catch (e) {
    console.warn('syncElectionFromDb error:', e.message);
  }
}

// ── API: health ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  sendJson(res, { ok: true, electionStatus: getElectionStatus(), timestamp: new Date().toISOString(), dbConnected: Boolean(dbConnected) });
});

app.get('/api/uptime', (req, res) => {
  sendJson(res, { ok: true, uptimeSeconds: process.uptime(), serverStart: serverStart.toISOString(), timestamp: new Date().toISOString() });
});

app.get('/api/request-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  sendJson(res, { success: true, logs: state.requestLog.slice(0, limit) });
});

// ── API: election public ──────────────────────────────────────────────────────
app.get('/api/election', async (req, res) => {
  const now = Date.now();
  if (electionResponseCache.data && now - electionResponseCache.ts < 2000) {
    return sendJson(res, electionResponseCache.data);
  }

  if (dbConnected) await syncElectionFromDb();

  const summary = computeResults();
  const payload = {
    success: true,
    schoolName: state.settings.schoolName,
    title: state.settings.electionTitle,
    subtitle: state.settings.electionSubtitle,
    description: state.settings.electionDescription,
    status: getElectionStatus(),
    settings: state.settings,
    timer: { start: state.settings.electionStartDate, end: state.settings.electionEndDate, timezone: state.settings.timezone },
    positions: state.positions.map((p) => ({ ...p, candidates: state.candidates.filter((c) => c.positionId === p.id && c.status !== 'inactive') })),
    eligibleStudents: state.eligibleStudents.length,
    summary,
  };

  electionResponseCache = { ts: now, data: payload };
  return sendJson(res, payload);
});

// ── API: student login ────────────────────────────────────────────────────────
app.post('/api/student/login', async (req, res) => {
  const studentId = normalizeStudentId(req.body.studentId || '');
  const pin = (req.body.pin || '').toString().trim();

  if (dbConnected) await syncElectionFromDb();

  const eligibleStudent = state.eligibleStudents.find((s) => s.studentId === studentId && s.active);
  if (!eligibleStudent) {
    return sendJson(res, { success: false, message: 'Student ID not recognised. Please contact the election administrator.' }, 401);
  }

  const electionStatus = getElectionStatus();
  if (electionStatus === 'upcoming') return sendJson(res, { success: false, message: 'The election has not started yet.' }, 403);
  if (electionStatus === 'closed')   return sendJson(res, { success: false, message: 'The election has ended. Voting is no longer available.' }, 403);

  // PIN check — always enforced when requirePin is true (regardless of auth method)
  if (state.settings.requirePin) {
    if (!pin || pin !== eligibleStudent.pin) {
      state.failedLogins.push({ studentId, reason: 'invalid-pin', timestamp: new Date().toISOString() });
      return sendJson(res, { success: false, message: 'Student ID or PIN is incorrect.' }, 401);
    }
  }

  // ── One-vote-per-student enforcement ──────────────────────────────────────
  // Check the has_voted flag first (fastest), then fall back to vote_records count
  if (eligibleStudent.hasVoted) {
    return sendJson(res, {
      success: false,
      alreadyVoted: true,
      message: 'You have already cast your vote. Each student may only vote once. Thank you for participating.',
    }, 403);
  }

  // Secondary check against actual vote records (catches edge cases where flag may be stale)
  const allPositions = state.positions.filter((p) => p.status !== 'inactive');
  const votedPositions = allPositions.filter((p) => state.votes.some((v) => v.studentId === studentId && v.positionId === p.id));
  if (votedPositions.length >= allPositions.length && allPositions.length > 0) {
    // Flag wasn't set — fix it now
    eligibleStudent.hasVoted = true;
    eligibleStudent.votedAt = new Date().toISOString();
    if (dbConnected && dbClient) {
      dbClient.query('UPDATE eligible_voters SET has_voted=TRUE, voted_at=NOW() WHERE id=$1', [eligibleStudent.id]).catch(() => {});
    }
    return sendJson(res, {
      success: false,
      alreadyVoted: true,
      message: 'You have already cast your vote. Each student may only vote once. Thank you for participating.',
    }, 403);
  }

  const sessionId = `session-${studentId}-${Date.now()}`;
  state.studentSessions = state.studentSessions || {};
  state.studentSessions[studentId] = { sessionId, loggedInAt: new Date().toISOString() };
  return sendJson(res, { success: true, studentId, sessionId, message: 'Login successful.' });
});

// ── API: student ballot ───────────────────────────────────────────────────────
app.get('/api/student/ballot', async (req, res) => {
  const studentId = normalizeStudentId(req.query.studentId || '');
  const sessionId = req.query.sessionId || '';
  const session = state.studentSessions && state.studentSessions[studentId];
  if (!session || session.sessionId !== sessionId) return sendJson(res, { success: false, message: 'Session expired. Please log in again.' }, 401);
  if (getElectionStatus() === 'closed') return sendJson(res, { success: false, message: 'The election has ended.' }, 403);

  if (dbConnected) await syncElectionFromDb();

  const ballot = state.positions
    .filter((p) => p.status !== 'inactive')
    .map((p) => ({ ...p, alreadyVoted: state.votes.some((v) => v.studentId === studentId && v.positionId === p.id), candidates: state.candidates.filter((c) => c.positionId === p.id && c.status !== 'inactive') }));

  return sendJson(res, { success: true, ballot, studentId });
});

// ── API: submit vote ──────────────────────────────────────────────────────────
app.post('/api/submit-vote', async (req, res) => {
  const { studentId, sessionId, selections } = req.body || {};
  const normalizedStudentId = normalizeStudentId(studentId || '');
  const session = state.studentSessions && state.studentSessions[normalizedStudentId];
  if (!session || session.sessionId !== sessionId) return sendJson(res, { success: false, message: 'Session expired. Please log in again.' }, 401);
  if (getElectionStatus() !== 'live') return sendJson(res, { success: false, message: 'Voting is not open at the moment.' }, 403);
  if (!selections || !Object.keys(selections).length) return sendJson(res, { success: false, message: 'Please select a candidate for each available position.' }, 400);

  const positionIds = state.positions.filter((p) => p.status !== 'inactive').map((p) => p.id);
  const submitted = Object.entries(selections);

  for (const [positionId, candidateId] of submitted) {
    if (!positionIds.includes(positionId)) return sendJson(res, { success: false, message: 'Invalid position submission.' }, 400);
    const candidate = state.candidates.find((c) => c.id === candidateId && c.positionId === positionId && c.status !== 'inactive');
    if (!candidate) return sendJson(res, { success: false, message: 'Missing candidate. Please review your choices.' }, 400);
    if (state.votes.some((v) => v.studentId === normalizedStudentId && v.positionId === positionId)) {
      return sendJson(res, { success: false, message: 'You have already voted for this position.' }, 409);
    }
  }

  const savedVotes = [];
  for (const [positionId, candidateId] of submitted) {
    const vote = {
      id: `vote-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      electionId: state.electionId,
      positionId, candidateId,
      studentId: normalizedStudentId,
      voterReference: `anon-${normalizedStudentId}`,
      submittedAt: new Date().toISOString(),
    };
    state.votes.push(vote);
    savedVotes.push({ positionId, candidateId });

    // Persist to DB
    if (dbConnected && dbClient && state.dbElectionId) {
      dbClient.query(
        `INSERT INTO vote_records (election_id, position_id, candidate_id, student_id, voter_reference)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [state.dbElectionId, positionId, candidateId, normalizedStudentId, `anon-${normalizedStudentId}`]
      ).catch(() => {});
    }
  }

  // ── Mark student as voted and destroy their session ───────────────────────
  const voter = state.eligibleStudents.find((s) => s.studentId === normalizedStudentId);
  if (voter) {
    voter.hasVoted = true;
    voter.votedAt = new Date().toISOString();
    if (dbConnected && dbClient) {
      dbClient.query(
        'UPDATE eligible_voters SET has_voted=TRUE, voted_at=NOW() WHERE id=$1',
        [voter.id]
      ).catch(() => {});
    }
  }
  // Invalidate session so PIN cannot be reused
  if (state.studentSessions && state.studentSessions[normalizedStudentId]) {
    delete state.studentSessions[normalizedStudentId];
  }

  addAuditLog('Vote submitted', normalizedStudentId, { voteCount: savedVotes.length });
  electionResponseCache = { ts: 0, data: null };
  return sendJson(res, { success: true, message: 'Vote Successfully Recorded', votes: savedVotes, electionName: state.settings.electionTitle, submittedAt: new Date().toISOString() });
});

// ── API: admin login ──────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === demoAdmin.username && password === demoAdmin.password) {
    adminSession = { authenticated: true, username, token: `admin-${Date.now()}` };
    return sendJson(res, { success: true, token: adminSession.token, username });
  }
  return sendJson(res, { success: false, message: 'Invalid administrator credentials.' }, 401);
});

// ── API: admin summary ────────────────────────────────────────────────────────
app.get('/api/admin/summary', requireAdmin, async (req, res) => {
  if (dbConnected) await syncElectionFromDb();

  const uniqueVoters = new Set(state.votes.map((v) => v.studentId));
  const totalEligible = state.eligibleStudents.filter((s) => s.active).length;
  const votedCount = uniqueVoters.size;
  const notVoted = Math.max(totalEligible - votedCount, 0);
  const turnout = totalEligible > 0 ? ((votedCount / totalEligible) * 100).toFixed(1) : '0.0';

  sendJson(res, {
    success: true,
    summary: { totalEligible, votedCount, notVoted, totalVotesCast: state.votes.length, turnout, electionStatus: getElectionStatus(), positions: state.positions.length, candidates: state.candidates.length },
    results: computeResults(),
    analytics: computeClassSectionAnalytics(),
    positions: state.positions,
    candidates: state.candidates,
    students: state.eligibleStudents,
    auditLog: state.auditLog.slice(0, 20),
    settings: state.settings,
  });
});

// ── API: admin positions ──────────────────────────────────────────────────────
app.post('/api/admin/positions', requireAdmin, async (req, res) => {
  const { name, status = 'active', displayOrder = state.positions.length + 1 } = req.body || {};
  if (!name) return sendJson(res, { success: false, message: 'Position name is required.' }, 400);

  const newPosition = { id: `pos-${Date.now()}`, name, status, displayOrder: Number(displayOrder) };

  if (dbConnected && dbClient && state.dbElectionId) {
    try {
      const r = await dbClient.query(
        'INSERT INTO positions (election_id, name, display_order, status) VALUES ($1,$2,$3,$4) RETURNING id',
        [state.dbElectionId, name, Number(displayOrder), status]
      );
      newPosition.id = String(r.rows[0].id);
    } catch (e) { console.warn('DB insert position error:', e.message); }
  }

  state.positions.push(newPosition);
  addAuditLog('Position added', adminSession.username, { position: name });
  sendJson(res, { success: true, position: newPosition });
});

app.put('/api/admin/positions/:id', requireAdmin, async (req, res) => {
  const position = state.positions.find((p) => p.id === req.params.id);
  if (!position) return sendJson(res, { success: false, message: 'Position not found.' }, 404);
  Object.assign(position, { name: req.body.name || position.name, status: req.body.status || position.status, displayOrder: Number(req.body.displayOrder || position.displayOrder) });

  if (dbConnected && dbClient) {
    dbClient.query('UPDATE positions SET name=$1, status=$2, display_order=$3 WHERE id=$4', [position.name, position.status, position.displayOrder, req.params.id]).catch(() => {});
  }
  addAuditLog('Position updated', adminSession.username, { positionId: position.id });
  sendJson(res, { success: true, position });
});

app.delete('/api/admin/positions/:id', requireAdmin, async (req, res) => {
  const before = state.positions.length;
  state.positions = state.positions.filter((p) => p.id !== req.params.id);
  state.candidates = state.candidates.filter((c) => c.positionId !== req.params.id);
  if (state.positions.length === before) return sendJson(res, { success: false, message: 'Position not found.' }, 404);

  if (dbConnected && dbClient) {
    dbClient.query('DELETE FROM positions WHERE id=$1', [req.params.id]).catch(() => {});
  }
  addAuditLog('Position removed', adminSession.username, { positionId: req.params.id });
  sendJson(res, { success: true, message: 'Position removed.' });
});

// ── API: admin candidates (with photo upload) ─────────────────────────────────
app.post('/api/admin/candidates/upload-photo', requireAdmin, photoUpload.single('photo'), (req, res) => {
  if (!req.file) return sendJson(res, { success: false, message: 'No image file received.' }, 400);
  const photoUrl = `/uploads/${req.file.filename}`;
  sendJson(res, { success: true, photoUrl });
});

app.post('/api/admin/candidates', requireAdmin, async (req, res) => {
  const { positionId, fullName, className, photo, manifesto, slogan, status = 'active', studentId = '' } = req.body || {};
  if (!positionId || !fullName) return sendJson(res, { success: false, message: 'Position and full name are required.' }, 400);

  const photoUrl = photo || '';
  const newCandidate = { id: `cand-${Date.now()}`, positionId, studentId, fullName, className, photo: photoUrl, manifesto: manifesto || 'Candidate manifesto not provided.', slogan: slogan || 'Vote for change', status };

  if (dbConnected && dbClient && state.dbElectionId) {
    try {
      const r = await dbClient.query(
        `INSERT INTO candidates (election_id, position_id, student_id, full_name, class_name, photo_url, manifesto, slogan, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [state.dbElectionId, positionId, studentId, fullName, className, photoUrl, manifesto || '', slogan || '', status]
      );
      newCandidate.id = String(r.rows[0].id);
    } catch (e) { console.warn('DB insert candidate error:', e.message); }
  }

  state.candidates.push(newCandidate);
  addAuditLog('Candidate added', adminSession.username, { fullName, positionId });
  sendJson(res, { success: true, candidate: newCandidate });
});

app.put('/api/admin/candidates/:id', requireAdmin, async (req, res) => {
  const candidate = state.candidates.find((c) => c.id === req.params.id);
  if (!candidate) return sendJson(res, { success: false, message: 'Candidate not found.' }, 404);
  Object.assign(candidate, {
    positionId: req.body.positionId || candidate.positionId,
    fullName: req.body.fullName || candidate.fullName,
    className: req.body.className || candidate.className,
    photo: req.body.photo !== undefined ? req.body.photo : candidate.photo,
    manifesto: req.body.manifesto || candidate.manifesto,
    slogan: req.body.slogan || candidate.slogan,
    status: req.body.status || candidate.status,
    studentId: req.body.studentId || candidate.studentId,
  });

  if (dbConnected && dbClient) {
    dbClient.query(
      'UPDATE candidates SET full_name=$1, class_name=$2, photo_url=$3, manifesto=$4, slogan=$5, status=$6, position_id=$7 WHERE id=$8',
      [candidate.fullName, candidate.className, candidate.photo, candidate.manifesto, candidate.slogan, candidate.status, candidate.positionId, req.params.id]
    ).catch(() => {});
  }
  addAuditLog('Candidate updated', adminSession.username, { candidateId: candidate.id });
  sendJson(res, { success: true, candidate });
});

app.delete('/api/admin/candidates/:id', requireAdmin, async (req, res) => {
  const candidate = state.candidates.find((c) => c.id === req.params.id);
  if (!candidate) return sendJson(res, { success: false, message: 'Candidate not found.' }, 404);
  state.candidates = state.candidates.filter((c) => c.id !== req.params.id);

  // Delete uploaded photo file if local
  if (candidate.photo && candidate.photo.startsWith('/uploads/')) {
    const filePath = path.join(__dirname, 'public', candidate.photo);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }

  if (dbConnected && dbClient) {
    dbClient.query('DELETE FROM candidates WHERE id=$1', [req.params.id]).catch(() => {});
  }
  addAuditLog('Candidate removed', adminSession.username, { candidateId: req.params.id });
  sendJson(res, { success: true, message: 'Candidate removed.' });
});

// ── API: admin students ───────────────────────────────────────────────────────

// Normalise date strings to YYYY-MM-DD.
// Handles: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY (tries DD/MM first if day ≤ 12 is ambiguous),
// DD-MM-YYYY, and ISO timestamps.
function normalizeDate(raw) {
  if (!raw || !raw.toString().trim()) return null;
  const s = raw.toString().trim();

  // Already ISO format YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const month = parseInt(m, 10);
    const day = parseInt(d, 10);
    // If month value > 12 it must be day — treat as MM/DD/YYYY
    if (month > 12) return `${y}-${String(day).padStart(2,'0')}-${String(month).padStart(2,'0')}`;
    return `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  // Fallback: try native Date parse
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

// ── IMPORTANT: bulk-import must be registered BEFORE /:id routes ──────────────
app.post('/api/admin/students/bulk-import', requireAdmin, async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return sendJson(res, { success: false, message: 'No student rows provided.' }, 400);
  }

  const imported = [];
  const skipped = [];

  for (const row of rows) {
    const normId = normalizeStudentId(row.student_id || '');
    if (!normId) { skipped.push({ id: row.student_id, reason: 'missing student_id' }); continue; }
    if (state.eligibleStudents.some((s) => s.studentId === normId)) { skipped.push({ id: normId, reason: 'duplicate' }); continue; }

    const dob = normalizeDate(row.date_of_birth);
    const pin = randomPin();
    const student = {
      id: `stu-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      studentId: normId,
      firstName: row.first_name || '',
      middleName: row.middle_name || '',
      lastName: row.last_name || '',
      dateOfBirth: dob,
      gender: row.gender || '',
      email: row.email || '',
      phone: row.phone || '',
      className: row.class_name || '',
      sectionName: row.section_name || '',
      active: true,
      pin,
    };

    if (dbConnected && dbClient && state.dbElectionId) {
      try {
        const r = await dbClient.query(
          `INSERT INTO eligible_voters
             (election_id, student_id, first_name, middle_name, last_name,
              date_of_birth, gender, email, phone, class_name, section_name, pin, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
           ON CONFLICT (election_id, student_id) DO NOTHING RETURNING id`,
          [state.dbElectionId, normId, student.firstName, student.middleName, student.lastName,
           dob || null, student.gender, student.email, student.phone,
           student.className, student.sectionName, pin]
        );
        if (r.rows.length > 0) { student.id = String(r.rows[0].id); }
        else { skipped.push({ id: normId, reason: 'duplicate in db' }); continue; }
      } catch (e) { skipped.push({ id: normId, reason: e.message }); continue; }
    }

    state.eligibleStudents.push(student);
    imported.push(student);
  }

  addAuditLog('Bulk student import', adminSession.username, { imported: imported.length, skipped: skipped.length });
  sendJson(res, { success: true, imported: imported.length, skipped: skipped.length, skippedRows: skipped });
});

app.post('/api/admin/students', requireAdmin, async (req, res) => {
  const { studentId, firstName = '', middleName = '', lastName = '', dateOfBirth = null, gender = '', email = '', phone = '', className = '', sectionName = '', active = true } = req.body || {};
  if (!studentId) return sendJson(res, { success: false, message: 'Student ID is required.' }, 400);

  const normId = normalizeStudentId(studentId);
  if (state.eligibleStudents.some((s) => s.studentId === normId)) return sendJson(res, { success: false, message: 'Student ID already exists.' }, 409);

  const dob = normalizeDate(dateOfBirth);
  const pin = randomPin();
  const student = { id: `stu-${Date.now()}`, studentId: normId, firstName, middleName, lastName, dateOfBirth: dob, gender, email, phone, className, sectionName, active, pin };

  if (dbConnected && dbClient && state.dbElectionId) {
    try {
      const r = await dbClient.query(
        `INSERT INTO eligible_voters (election_id, student_id, first_name, middle_name, last_name, date_of_birth, gender, email, phone, class_name, section_name, pin, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [state.dbElectionId, normId, firstName, middleName, lastName, dob || null, gender, email, phone, className, sectionName, pin, active]
      );
      student.id = String(r.rows[0].id);
    } catch (e) { console.warn('DB insert student error:', e.message); }
  }

  state.eligibleStudents.push(student);
  addAuditLog('Student added', adminSession.username, { studentId: normId });
  sendJson(res, { success: true, student });
});

app.put('/api/admin/students/:id', requireAdmin, async (req, res) => {
  const student = state.eligibleStudents.find((s) => s.id === req.params.id);
  if (!student) return sendJson(res, { success: false, message: 'Student not found.' }, 404);

  Object.assign(student, {
    studentId: normalizeStudentId(req.body.studentId || student.studentId),
    firstName: req.body.firstName !== undefined ? req.body.firstName : student.firstName,
    middleName: req.body.middleName !== undefined ? req.body.middleName : student.middleName,
    lastName: req.body.lastName !== undefined ? req.body.lastName : student.lastName,
    className: req.body.className || student.className,
    sectionName: req.body.sectionName || student.sectionName,
    active: req.body.active !== undefined ? Boolean(req.body.active) : student.active,
  });

  if (dbConnected && dbClient) {
    dbClient.query(
      'UPDATE eligible_voters SET student_id=$1, first_name=$2, middle_name=$3, last_name=$4, class_name=$5, section_name=$6, active=$7 WHERE id=$8',
      [student.studentId, student.firstName, student.middleName, student.lastName, student.className, student.sectionName, student.active, req.params.id]
    ).catch(() => {});
  }
  addAuditLog('Student updated', adminSession.username, { studentId: student.studentId });
  sendJson(res, { success: true, student });
});

app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  const student = state.eligibleStudents.find((s) => s.id === req.params.id);
  if (!student) return sendJson(res, { success: false, message: 'Student not found.' }, 404);
  state.eligibleStudents = state.eligibleStudents.filter((s) => s.id !== req.params.id);

  if (dbConnected && dbClient) {
    dbClient.query('DELETE FROM eligible_voters WHERE id=$1', [req.params.id]).catch(() => {});
  }
  addAuditLog('Student removed', adminSession.username, { studentId: student.studentId });
  sendJson(res, { success: true, message: 'Student removed.' });
});

// ── API: admin PIN list export ─────────────────────────────────────────────────
app.get('/api/admin/students/pins', requireAdmin, async (req, res) => {
  if (dbConnected) await syncElectionFromDb();
  const list = state.eligibleStudents
    .filter(s => s.active)
    .map(s => ({
      studentId: s.studentId,
      name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '),
      className: s.className,
      sectionName: s.sectionName,
      pin: s.pin,
    }))
    .sort((a, b) => a.className.localeCompare(b.className) || a.studentId.localeCompare(b.studentId));
  sendJson(res, { success: true, total: list.length, pins: list });
});

// ── API: admin regenerate all PINs ────────────────────────────────────────────
app.post('/api/admin/students/regenerate-pins', requireAdmin, async (req, res) => {
  if (dbConnected) await syncElectionFromDb();
  let updated = 0;
  for (const s of state.eligibleStudents) {
    const pin = randomPin();
    s.pin = pin;
    if (dbConnected && dbClient) {
      await dbClient.query('UPDATE eligible_voters SET pin=$1 WHERE id=$2', [pin, s.id]).catch(() => {});
    }
    updated++;
  }
  addAuditLog('All PINs regenerated', adminSession.username, { count: updated });
  sendJson(res, { success: true, message: `Regenerated PINs for ${updated} students.` });
});
app.post('/api/admin/election/control', requireAdmin, async (req, res) => {
  const { action } = req.body || {};
  if (!['start', 'pause', 'resume', 'close'].includes(action)) return sendJson(res, { success: false, message: 'Invalid election action.' }, 400);

  const stateMap = { start: 'live', pause: 'paused', resume: 'live', close: 'closed' };
  state.settings.electionState = stateMap[action];
  electionResponseCache = { ts: 0, data: null };

  if (dbConnected && dbClient && state.dbElectionId) {
    dbClient.query('UPDATE elections SET status=$1 WHERE id=$2', [stateMap[action], state.dbElectionId]).catch(() => {});
  }

  addAuditLog(`Election ${action}`, adminSession.username, { action });
  sendJson(res, { success: true, message: `Election ${action}.`, status: getElectionStatus() });
});

// ── API: settings ─────────────────────────────────────────────────────────────
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  state.settings = { ...state.settings, ...req.body };
  electionResponseCache = { ts: 0, data: null };
  addAuditLog('Election settings changed', adminSession.username, { summary: state.settings.electionTitle });
  sendJson(res, { success: true, settings: state.settings });
});

// ── API: audit log ────────────────────────────────────────────────────────────
app.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  sendJson(res, { success: true, logs: state.auditLog });
});

// ── API: public results ───────────────────────────────────────────────────────
app.get('/api/results', async (req, res) => {
  const visibility = state.settings.resultsVisibility || 'live';
  const status = getElectionStatus();
  if (visibility === 'hidden' || (!state.settings.publicResults && status !== 'closed')) {
    return sendJson(res, { success: true, public: false, message: 'Results are currently hidden.' });
  }

  if (dbConnected) await syncElectionFromDb();

  return sendJson(res, {
    success: true,
    public: true,
    status: status === 'closed' ? 'FINAL RESULTS' : 'LIVE / UNOFFICIAL RESULTS',
    results: computeResults(),
    analytics: computeClassSectionAnalytics(),
  });
});

// ── API: analytics (admin) ────────────────────────────────────────────────────
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  if (dbConnected) await syncElectionFromDb();
  sendJson(res, { success: true, analytics: computeClassSectionAnalytics(), results: computeResults() });
});

// ── API: reconnect DB ─────────────────────────────────────────────────────────
app.post('/api/reconnect-db', async (req, res) => {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  const allowed = ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.0.0.1');
  if (!allowed) return sendJson(res, { success: false, message: 'Forbidden' }, 403);
  try {
    await initDb();
    return sendJson(res, { success: true, dbConnected: Boolean(dbConnected) });
  } catch (err) {
    return sendJson(res, { success: false, error: (err && err.message) || String(err) }, 500);
  }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, message: 'Not found.' });
  const requestedPath = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  const filePath = path.join(__dirname, 'public', requestedPath);
  const fileExists = fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory();
  if (fileExists) return res.sendFile(filePath);
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async function start() {
  try { await initDb(); } catch (e) { console.warn('initDb() error:', e && e.message ? e.message : e); }
  app.listen(port, () => {
    console.log(`Kumasi STEM JHS Election Portal running on http://localhost:${port} (dbConnected=${Boolean(dbConnected)})`);
  });
})();

let _reconnectAttempts = 0;
if (!dbConnected) {
  const _timer = setInterval(async () => {
    if (dbConnected || _reconnectAttempts >= 60) { clearInterval(_timer); return; }
    _reconnectAttempts++;
    try { await initDb(); if (dbConnected) console.log('DB connected after reconnect.'); } catch (e) {}
  }, 10000);
}
