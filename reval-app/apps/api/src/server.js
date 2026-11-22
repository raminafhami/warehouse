import { initializeFinished } from "./finished/store.js";
import { initializeDefects } from "./defects/store.js";
import { assemblyStore, initializeAssembly } from "./assembly/store.js";
import { basketStore, initializeBasket } from "./basket/store.js";
import { createApp } from "./app.js";
import { catalogStore, initializeCatalog } from "./catalog/store.js";
import { readConfig, readIdentityOptions } from "./config.js";
import { migrate } from "./database/bootstrap.js";
import { connectDatabase, isDatabaseReady } from "./database/connection.js";
import { identityRouter } from "./identity/routes.js";
import { identityStore, initializeIdentity } from "./identity/store.js";
import { initializeShipments, shipmentStore } from "./shipments/store.js";
import { initializeInventory, inventoryStore } from "./inventory/store.js";
import { imeiStore, initializeImei } from "./imei/store.js";
import { handoverStore, initializeHandover } from "./handover/store.js";

async function start() {
  const config = readConfig(process.env);
  const identityOptions = readIdentityOptions(process.env);
  const database = await connectDatabase(config.uri);
  try {
    await migrate(database);
    const store = identityStore(database);
    await initializeIdentity(store, process.env);
    await initializeCatalog(catalogStore(database));
    await initializeShipments(shipmentStore(database));
    await initializeInventory(inventoryStore(database));
    await initializeHandover(handoverStore(database));
    await initializeImei(imeiStore(database));
    await initializeBasket(basketStore(database));
    const assembly = assemblyStore(database);
    await initializeAssembly(assembly);
    await initializeDefects(assembly);
    await initializeFinished(assembly);
    const app = createApp({
      isReady: () => isDatabaseReady(database),
      identity: identityRouter(store, {
        ...identityOptions,
        demo: config.allowDemoSeed,
      }),
    });
    const server = app.listen(config.port, config.host);
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    console.info(`REVAL API listening at http://${config.host}:${config.port}`);

    let stopping = false;
    function shutdown() {
      if (stopping) return;
      stopping = true;
      const timer = setTimeout(() => server.closeAllConnections(), 5000);
      timer.unref();
      server.close(async (error) => {
        clearTimeout(timer);
        try {
          await database.close();
        } catch {
          process.exitCode = 1;
        }
        if (error) process.exitCode = 1;
      });
    }
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await database.close().catch(() => {});
    if (
      error instanceof Error &&
      error.message.startsWith("First startup requires")
    )
      throw error;
    throw new Error(
      "API startup failed during migration or while opening the listen address.",
      { cause: error },
    );
  }
}

try {
  await start();
} catch (error) {
  console.error(error instanceof Error ? error.message : "API startup failed.");
  process.exitCode = 1;
}
