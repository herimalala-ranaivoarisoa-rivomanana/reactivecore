BEGIN;

CREATE TABLE public.reactive_commit_clock (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    last_seq BIGINT NOT NULL CHECK (last_seq >= 0)
);

INSERT INTO public.reactive_commit_clock VALUES (1, 0);

CREATE TABLE public.reactive_change_log (
    seq BIGINT NOT NULL CHECK (seq > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    event_id UUID NOT NULL UNIQUE,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id),
    table_name TEXT NOT NULL,
    document_id UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
    before_data JSONB,
    after_data JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (seq, ordinal)
);

CREATE INDEX idx_change_log_tenant_seq
    ON public.reactive_change_log (tenant_id, seq, ordinal);

ALTER TABLE public.reactive_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactive_change_log FORCE ROW LEVEL SECURITY;

CREATE POLICY change_log_tenant_read ON public.reactive_change_log
    FOR SELECT TO reactivecore_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON public.reactive_commit_clock, public.reactive_change_log TO reactivecore_app;

CREATE FUNCTION public.reactive_append_changes(changes JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    tenant UUID := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
    boundary BIGINT;
BEGIN
    IF tenant IS NULL THEN
        RAISE EXCEPTION 'Tenant context is required';
    END IF;
    IF changes IS NULL OR jsonb_typeof(changes) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Expected an array of changes';
    END IF;
    IF jsonb_array_length(changes) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Expected between 1 and 100 changes';
    END IF;

    UPDATE public.reactive_commit_clock
    SET last_seq = last_seq + 1
    WHERE id = 1
    RETURNING last_seq INTO STRICT boundary;

    INSERT INTO public.reactive_change_log
        (seq, ordinal, event_id, tenant_id, table_name, document_id, operation, before_data, after_data)
    SELECT boundary, position - 1, (change->>'eventId')::uuid, tenant,
           change->>'table', (change->>'documentId')::uuid, change->>'operation',
           NULLIF(change->'before', 'null'::jsonb), NULLIF(change->'after', 'null'::jsonb)
    FROM jsonb_array_elements(changes) WITH ORDINALITY AS entries(change, position);

    RETURN boundary;
END;
$$;

REVOKE ALL ON FUNCTION public.reactive_append_changes(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reactive_append_changes(JSONB) TO reactivecore_app;

COMMIT;
