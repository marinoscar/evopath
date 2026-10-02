-- Coach "Start over" (#323): a soft clear of the coach chat. The timeline, the
-- chat history sent to the model and the nudge context read only messages
-- created after `chat_cleared_at`; earlier rows are kept. NULL: never cleared.

-- AlterTable
ALTER TABLE "coach_states" ADD COLUMN     "chat_cleared_at" TIMESTAMPTZ;
