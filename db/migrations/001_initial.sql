BEGIN;

CREATE TABLE tenants (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pharmacies (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, id)
);

CREATE TABLE medicines (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, id)
);

CREATE TABLE stocks (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    pharmacy_id UUID NOT NULL,
    medicine_id UUID NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT stock_nonnegative
        CHECK (quantity >= 0),

    CONSTRAINT stock_unique
        UNIQUE (tenant_id, pharmacy_id, medicine_id),

    CONSTRAINT stock_pharmacy_fk
        FOREIGN KEY (tenant_id, pharmacy_id)
        REFERENCES pharmacies(tenant_id, id),

    CONSTRAINT stock_medicine_fk
        FOREIGN KEY (tenant_id, medicine_id)
        REFERENCES medicines(tenant_id, id)
);

CREATE TABLE sales (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    pharmacy_id UUID NOT NULL,
    medicine_id UUID NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (tenant_id, pharmacy_id)
        REFERENCES pharmacies(tenant_id, id),

    FOREIGN KEY (tenant_id, medicine_id)
        REFERENCES medicines(tenant_id, id)
);

CREATE TABLE mutation_receipts (
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    idempotency_key UUID NOT NULL,
    request_hash TEXT NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE event_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    event_type TEXT NOT NULL,
    aggregate_id UUID NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token UUID,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stocks_pharmacy
    ON stocks(tenant_id, pharmacy_id);

CREATE INDEX idx_sales_pharmacy_date
    ON sales(tenant_id, pharmacy_id, created_at DESC);

CREATE INDEX idx_outbox_pending
    ON event_outbox(id)
    WHERE published_at IS NULL;

COMMIT;
