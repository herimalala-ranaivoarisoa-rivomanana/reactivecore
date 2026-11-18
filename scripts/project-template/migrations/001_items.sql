CREATE TABLE public.items (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id),
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX items_tenant_created ON public.items (tenant_id, created_at DESC, id);
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items FORCE ROW LEVEL SECURITY;

CREATE POLICY items_scope ON public.items TO reactivecore_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON public.items TO reactivecore_app;
