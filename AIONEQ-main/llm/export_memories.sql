-- Export your EchoMind memories as training text for llm/train.py
--
-- HOW TO USE
--   1. Supabase dashboard -> your project -> SQL Editor -> New query
--   2. Paste this whole file, press Run
--   3. Copy the single value from the `corpus` column
--   4. Save it as  llm/data/memories.txt  (UTF-8, one file)
--
-- WHY SQL EDITTER AND NOT THE APP
--   Your memories are protected by row-level security: the anon key can only
--   read rows for a signed-in user, and a script has no session. The SQL editor
--   runs as the project owner, so it can read every row. Nothing here is shared
--   with anyone - the result stays on your machine.
--
-- TEXT FIELD ORDER matches backend/src/services/memoryRetrieval.js:
--   content -> transcript -> extracted_text -> ai_summary
-- so the model trains on the same words the app retrieves.

select string_agg(block, E'\n\n' order by created_at) as corpus
from (
  select
    m.created_at,
    '=== ' || upper(m.type)
      || ' | ' || coalesce(to_char(m.event_date, 'YYYY-MM-DD'), to_char(m.created_at, 'YYYY-MM-DD'))
      || ' | ' || coalesce(nullif(m.title, ''), 'untitled')
      || ' ==='
      || E'\n'
      || trim(coalesce(
           nullif(m.content, ''),
           nullif(m.transcript, ''),
           nullif(m.extracted_text, ''),
           m.ai_summary
         )) as block
  from memories m
  where nullif(trim(coalesce(
           nullif(m.content, ''),
           nullif(m.transcript, ''),
           nullif(m.extracted_text, ''),
           m.ai_summary
         )), '') is not null
) t;

-- Optional sanity check before you export: how much usable text do you have?
-- select m.type,
--        count(*) as memories,
--        sum(length(coalesce(nullif(m.content,''), nullif(m.transcript,''),
--                            nullif(m.extracted_text,''), m.ai_summary))) as chars
-- from memories m
-- group by m.type
-- order by chars desc;