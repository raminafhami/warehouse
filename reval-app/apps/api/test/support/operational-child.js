import { once } from "node:events";
import { createApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import {
  connectDatabase,
  isDatabaseReady,
} from "../../src/database/connection.js";
import { identityRouter } from "../../src/identity/routes.js";
import { identityStore } from "../../src/identity/store.js";

const config = readConfig({
  NODE_ENV: "test",
  MONGODB_URI: process.env.REVAL_TEST_CHILD_URI,
});
const origin = process.env.REVAL_TEST_CHILD_ORIGIN;
if (!origin || !process.send)
  throw Error("QA process requires IPC and a test origin.");
const database = await connectDatabase(config.uri);
const app = createApp({
  isReady: () => isDatabaseReady(database),
  identity: identityRouter(identityStore(database), { origin, ttl: 3600 }),
});
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string")
  throw Error("QA process did not bind TCP.");
process.on("message", async (message) => {
  if (message === "sample")
    process.send?.({ rss: process.memoryUsage().rss, cpu: process.cpuUsage() });
  if (message === "hold") {
    await database.transaction(async (session) => {
      await database
        .collection("reval_test_crash")
        .insertOne({ state: "uncommitted" }, { session });
      process.send?.({ event: "staged", id: session.id.id.toString("hex") });
      await new Promise(() => {});
    });
  }
});
process.send({ port: address.port });
