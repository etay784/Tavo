-- Staff clarification is not service selection.

ALTER TYPE public.conversation_state ADD VALUE IF NOT EXISTS 'AWAITING_STAFF';
