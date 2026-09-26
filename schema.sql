CREATE TABLE IF NOT EXISTS elections (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  subtitle VARCHAR(255),
  description TEXT,
  school_name VARCHAR(255),
  timezone VARCHAR(64) DEFAULT 'Africa/Accra',
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  status VARCHAR(32) DEFAULT 'upcoming',
  results_visibility VARCHAR(32) DEFAULT 'live',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  election_id INT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  display_order INT DEFAULT 0,
  status VARCHAR(32) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS candidates (
  id SERIAL PRIMARY KEY,
  election_id INT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  position_id INT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  student_id VARCHAR(128),
  full_name VARCHAR(255) NOT NULL,
  class_name VARCHAR(64),
  photo_url TEXT,
  manifesto TEXT,
  slogan VARCHAR(255),
  display_order INT DEFAULT 0,
  status VARCHAR(32) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eligible_voters (
  id SERIAL PRIMARY KEY,
  election_id INT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  student_id VARCHAR(128) NOT NULL,
  first_name VARCHAR(128),
  middle_name VARCHAR(128),
  last_name VARCHAR(128),
  date_of_birth DATE,
  gender VARCHAR(16),
  email VARCHAR(255),
  phone VARCHAR(32),
  class_name VARCHAR(64),
  section_name VARCHAR(64),
  pin VARCHAR(64),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (election_id, student_id)
);

CREATE TABLE IF NOT EXISTS vote_records (
  id SERIAL PRIMARY KEY,
  election_id INT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  position_id INT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  candidate_id INT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  student_id VARCHAR(128) NOT NULL,
  voter_reference VARCHAR(128),
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (election_id, position_id, student_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  election_id INT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  action VARCHAR(255) NOT NULL,
  actor VARCHAR(255),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  election_id INT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  school_name VARCHAR(255),
  school_logo VARCHAR(255),
  election_title VARCHAR(255),
  election_description TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  timezone VARCHAR(64) DEFAULT 'Africa/Accra',
  results_visibility VARCHAR(32) DEFAULT 'live',
  live_results_interval INT DEFAULT 5,
  student_auth_method VARCHAR(32) DEFAULT 'student_id',
  require_pin BOOLEAN DEFAULT FALSE,
  enable_public_results BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add new eligible_voters columns if they don't already exist (safe migration)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='first_name') THEN
    ALTER TABLE eligible_voters ADD COLUMN first_name VARCHAR(128);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='middle_name') THEN
    ALTER TABLE eligible_voters ADD COLUMN middle_name VARCHAR(128);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='last_name') THEN
    ALTER TABLE eligible_voters ADD COLUMN last_name VARCHAR(128);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='date_of_birth') THEN
    ALTER TABLE eligible_voters ADD COLUMN date_of_birth DATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='gender') THEN
    ALTER TABLE eligible_voters ADD COLUMN gender VARCHAR(16);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='email') THEN
    ALTER TABLE eligible_voters ADD COLUMN email VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='phone') THEN
    ALTER TABLE eligible_voters ADD COLUMN phone VARCHAR(32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='section_name') THEN
    ALTER TABLE eligible_voters ADD COLUMN section_name VARCHAR(64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='has_voted') THEN
    ALTER TABLE eligible_voters ADD COLUMN has_voted BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='eligible_voters' AND column_name='voted_at') THEN
    ALTER TABLE eligible_voters ADD COLUMN voted_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vote_records_student_position ON vote_records(election_id,student_id,position_id);
CREATE INDEX IF NOT EXISTS idx_candidates_position ON candidates(position_id);
CREATE INDEX IF NOT EXISTS idx_positions_election ON positions(election_id);
CREATE INDEX IF NOT EXISTS idx_voters_class ON eligible_voters(election_id, class_name, section_name);
