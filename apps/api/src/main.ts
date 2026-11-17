
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  app.enableCors({
    origin: ["http://localhost:3000"],
    credentials: true,
  });

  app.setGlobalPrefix("api");

  const port = Number(process.env.PORT ?? 4000);

  await app.listen(port, "127.0.0.1");

  console.log(
    `ReactiveCore API: http://127.0.0.1:${port}/api`,
  );
}

bootstrap().catch((error: unknown) => {
  console.error("Application startup failed:", error);
  process.exitCode = 1;
});
