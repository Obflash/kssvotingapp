# Kumasi STEM JHS Student Election Portal

A responsive, secure election web application for school voting with student and admin workflows.

## Features

- Student login with Student ID validation
- Election status gating for upcoming/live/closed periods
- Candidate selection by position with one vote per position
- Review and submit flow
- Admin dashboard with summary cards, candidate management, live totals, and settings
- PostgreSQL/Supabase-ready schema and environment configuration
- Demo data for testing

## Quick Start

1. Install dependencies:
   npm install
2. Copy the environment file:
   cp .env.example .env
3. Update the environment variables as needed.
4. Start the app:
   npm start
5. Open http://localhost:3000

## Demo Admin Credentials

- Username: admin
- Password: admin123

## Student Example IDs

- STU-1001
- STU-1002
- STU-1003
- STU-1004
- STU-1005
- STU-1006
- STU-1007
- STU-1008
- STU-1009
- STU-1010

## Database Notes

The app uses PostgreSQL-compatible SQL and can connect to a local PostgreSQL database or a Supabase project by setting the `DATABASE_URL` and `SUPABASE_*` values in `.env`.

The schema is defined in `schema.sql`.

## Security Notes

This project is a demo implementation intended for school election workflows. In production, add real authentication, HTTPS, rate limiting, and proper hosting protections.
