-- ============================================================
-- TaxIntakeFlow — Preparer Login Migration
-- Run this ONCE in Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Add user_id column to preparers (links a preparer to a Supabase auth account)
ALTER TABLE preparers
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Index for fast lookup when preparer logs in
CREATE INDEX IF NOT EXISTS idx_preparers_user_id ON preparers(user_id);

-- 3. Index for lookup by email (used during first login to link account)
CREATE INDEX IF NOT EXISTS idx_preparers_email ON preparers(email);

-- ============================================================
-- DONE. That's all — no other schema changes needed.
-- After running this, deploy the 3 updated HTML files to GitHub.
-- ============================================================
