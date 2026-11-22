import { readConfig } from "../config.js";
import { migrate, seedDemo } from "./bootstrap.js";
import { connectDatabase } from "./connection.js";

try {
  const command = process.argv[2];
  if (command !== "migrate" && command !== "seed") {
    throw new Error("Expected the migrate or seed command.");
  }
  const config = readConfig(process.env);
  if (command === "seed" && !config.allowDemoSeed) {
    throw new Error("Demo seed requires ALLOW_DEMO_SEED=true.");
  }
  const database = await connectDatabase(config.uri);
  try {
    await migrate(database);
    if (command === "seed")
      await seedDemo(
        database,
        config.allowDemoSeed,
        process.env.REVAL_DEMO_PASSWORD,
      );
    console.info(
      command === "seed" ? "Demo seed applied." : "Migrations applied.",
    );
  } finally {
    await database.close();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const expected =
    /^(Expected|NODE_ENV|MONGODB_URI|HOST and PORT|ALLOW_DEMO_SEED|Demo seed|Cannot connect)/;
  console.error(expected.test(message) ? message : "Database command failed.");
  process.exitCode = 1;
}
