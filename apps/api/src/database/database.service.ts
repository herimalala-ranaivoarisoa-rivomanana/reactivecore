
import {
  Injectable,
  OnModuleDestroy,
} from "@nestjs/common";

import {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "pg";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }

    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on("error", (error) => {
      console.error("Idle PostgreSQL client error:", error);
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await callback(client);

      await client.query("COMMIT");

      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError);
      }

      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    const result = await this.query(
      "SELECT 1 AS connected",
    );

    return result.rows[0]?.connected === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
