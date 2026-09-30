-- Lab reference-range context on a measurement (#187). All nullable, so existing
-- rows are untouched. `flag` is a plain string validated in the API
-- (low | normal | high | critical | unknown), not a PG enum.
ALTER TABLE "measurements"
  ADD COLUMN "reference_low" DOUBLE PRECISION,
  ADD COLUMN "reference_high" DOUBLE PRECISION,
  ADD COLUMN "reference_text" TEXT,
  ADD COLUMN "flag" TEXT;
