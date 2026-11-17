
import { Controller, Get } from "@nestjs/common";

import { DatabaseService } from "../database/database.service";
import { RedisService } from "../redis/redis.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    const [postgres, redis] = await Promise.allSettled([
      this.database.ping(),
      this.redis.ping(),
    ]);

    const postgresOk =
      postgres.status === "fulfilled" &&
      postgres.value === true;

    const redisOk =
      redis.status === "fulfilled" &&
      redis.value === "PONG";

    return {
      status:
        postgresOk && redisOk
          ? "healthy"
          : "degraded",

      services: {
        postgres: postgresOk ? "up" : "down",
        redis: redisOk ? "up" : "down",
      },

      timestamp: new Date().toISOString(),
    };
  }
}
