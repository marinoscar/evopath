-- Remove stored per-user AI model choices (issue #173).
--
-- Model selection moved to the administrator (`system_settings.ai.assignments`).
-- The legacy `value->'ai'->'defaultModel'` and `value->'ai'->'taskModels'` keys
-- in `user_settings` are read by nothing; the product is not in production, so
-- they are deleted outright (no backward compatibility). The `ai` namespace is
-- optional, so it is removed entirely when nothing else (`training`) remains.
-- `version` is bumped only on rows that actually change (optimistic
-- concurrency), and `updated_at` is set because Prisma's @updatedAt has no
-- database default.
--
-- Data-only migration: no schema change. Idempotent (a second run matches no
-- rows).

UPDATE "user_settings" AS us
SET "value" = CASE
      WHEN c.stripped -> 'ai' = '{}'::jsonb THEN c.stripped #- '{ai}'
      ELSE c.stripped
    END,
    "version" = us."version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
FROM (
  SELECT "id",
         "value" #- '{ai,defaultModel}' #- '{ai,taskModels}' AS stripped
  FROM "user_settings"
  WHERE jsonb_typeof("value" -> 'ai') = 'object'
    AND ("value" -> 'ai') ?| ARRAY['defaultModel', 'taskModels']
) AS c
WHERE us."id" = c."id";
