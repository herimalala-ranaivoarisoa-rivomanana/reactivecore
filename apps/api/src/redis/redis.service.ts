
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";

import {
  createClient,
  RedisClientType,
} from "redis";

@Injectable()
export class RedisService
  implements OnModuleInit, OnModuleDestroy {

  private readonly client: RedisClientType;

  constructor() {
    const url = process.env.REDIS_URL;

    if (!url) {
      throw new Error("REDIS_URL is required");
    }

    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) =>
          Math.min(retries * 200, 3000),
      },
    });

    this.client.on("error", (error) => {
      console.error("Redis error:", error);
    });
  }

  onModuleInit(): void {
    void this.client.connect().catch((error: unknown) => {
      console.error("Redis connection ended:", error);
    });
  }

  async ping(): Promise<string> {
    if (!this.client.isReady) {
      throw new ServiceUnavailableException(
        "Redis is not ready",
      );
    }

    return this.client.withCommandOptions({ timeout: 2000 }).ping();
  }

  async set(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, {
        EX: ttlSeconds,
      });
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async publish(
    channel: string,
    message: string,
  ): Promise<number> {
    return this.client.withCommandOptions({ timeout: 3000 }).publish(channel, message);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      this.client.destroy();
    }
  }
}
