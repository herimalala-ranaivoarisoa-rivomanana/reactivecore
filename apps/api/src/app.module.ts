
import { Module } from "@nestjs/common";

import { DatabaseModule } from "./database/database.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { HealthModule } from "./health/health.module.js";

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {}
