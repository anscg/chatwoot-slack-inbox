-- 0010 added the column as NULL, which reads as "check turned off", so bridges that already
-- existed got the feature switched off by default. Nobody can have chosen that yet, so turn it on.
UPDATE "bridges" SET "followup_prompt_message" = 'You asked something here a few minutes ago. Is this a separate question, or more about that one? Nothing has been sent to the helpers yet.' WHERE "followup_prompt_message" IS NULL;
