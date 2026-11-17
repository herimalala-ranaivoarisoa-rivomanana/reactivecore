BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reactivecore_app') THEN
        CREATE ROLE reactivecore_app NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reactivecore_worker') THEN
        CREATE ROLE reactivecore_worker NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO reactivecore_app, reactivecore_worker;
GRANT SELECT ON pharmacies, medicines, stocks, sales, mutation_receipts TO reactivecore_app;
GRANT UPDATE (quantity, version, updated_at) ON stocks TO reactivecore_app;
GRANT INSERT ON sales, mutation_receipts, event_outbox TO reactivecore_app;
GRANT UPDATE (result) ON mutation_receipts TO reactivecore_app;
GRANT USAGE ON SEQUENCE event_outbox_id_seq TO reactivecore_app;

GRANT SELECT ON event_outbox TO reactivecore_worker;
GRANT UPDATE (lease_token, available_at, attempts, published_at)
    ON event_outbox TO reactivecore_worker;
CREATE POLICY worker_outbox ON event_outbox TO reactivecore_worker
    USING (true) WITH CHECK (true);

COMMIT;
