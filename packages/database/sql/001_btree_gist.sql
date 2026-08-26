-- Required so EXCLUDE USING gist can mix scalar equality (tenant_id, staff_id)
-- with range overlap. This file is the version-controlled source for btree_gist.

CREATE EXTENSION IF NOT EXISTS btree_gist;
