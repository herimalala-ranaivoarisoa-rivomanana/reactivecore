BEGIN;

DO $$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'pharmacies',
        'medicines',
        'stocks',
        'sales',
        'mutation_receipts',
        'event_outbox'
    ]
    LOOP
        EXECUTE format(
            'ALTER TABLE %I ENABLE ROW LEVEL SECURITY',
            table_name
        );

        EXECUTE format(
            'ALTER TABLE %I FORCE ROW LEVEL SECURITY',
            table_name
        );

        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
             USING (
               tenant_id = NULLIF(
                 current_setting(''app.tenant_id'', true),
                 ''''
               )::uuid
             )
             WITH CHECK (
               tenant_id = NULLIF(
                 current_setting(''app.tenant_id'', true),
                 ''''
               )::uuid
             )',
            table_name
        );
    END LOOP;
END $$;

COMMIT;
