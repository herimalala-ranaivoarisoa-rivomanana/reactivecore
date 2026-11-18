BEGIN;

CREATE TABLE public.mutation_execution_receipts (
    tenant_id UUID NOT NULL REFERENCES public.tenants(id),
    principal_id UUID NOT NULL,
    mutation_name TEXT NOT NULL,
    idempotency_key UUID NOT NULL,
    request_hash TEXT NOT NULL,
    response JSONB,
    commit_seq BIGINT CHECK (commit_seq > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, principal_id, mutation_name, idempotency_key),
    CHECK ((response IS NULL) = (commit_seq IS NULL))
);

ALTER TABLE public.mutation_execution_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mutation_execution_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY execution_receipt_scope ON public.mutation_execution_receipts
    TO reactivecore_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND principal_id = NULLIF(current_setting('app.principal_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND principal_id = NULLIF(current_setting('app.principal_id', true), '')::uuid
    );

GRANT SELECT, INSERT ON public.mutation_execution_receipts TO reactivecore_app;
GRANT UPDATE (response, commit_seq) ON public.mutation_execution_receipts TO reactivecore_app;

ALTER TABLE public.event_outbox ADD COLUMN commit_seq BIGINT CHECK (commit_seq > 0);

COMMIT;
