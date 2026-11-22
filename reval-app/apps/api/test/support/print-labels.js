import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, unlink, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient, ObjectId } from "mongodb";
import { preview } from "vite";
import { readConfig } from "../../src/config.js";
import { prepareReceiptFixture } from "./receipt-fixture.js";

const {
  REVAL_QA_PLAYWRIGHT,
  REVAL_QA_CHROME,
  REVAL_QA_PYTHON,
  TEST_MONGODB_URI,
} = process.env;
assert.ok(
  REVAL_QA_PLAYWRIGHT && REVAL_QA_CHROME,
  "Set paths to playwright-core and Chrome.",
);
const { chromium } = createRequire(import.meta.url)(REVAL_QA_PLAYWRIGHT);
const { uri } = readConfig({ NODE_ENV: "test", MONGODB_URI: TEST_MONGODB_URI });
const databaseName = "reval_test_" + randomBytes(8).toString("hex");
const fixtureUri = uri.replace(
  /\/reval_test(?:_[a-z0-9]+)?(?=\?)/,
  "/" + databaseName,
);
assert.notEqual(fixtureUri, uri);
const mongo = new MongoClient(fixtureUri);
const database = mongo.db();
assert.equal(database.databaseName, databaseName);
const python =
  REVAL_QA_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const checkPdf = fileURLToPath(
  new URL("./check-label-pdf.py", import.meta.url),
);
const webRoot = fileURLToPath(new URL("../../../web/", import.meta.url));
const apiSource = fileURLToPath(
  new URL("../../src/server.js", import.meta.url),
);
const temp = await mkdtemp(join(tmpdir(), "reval-label-qa-"));
const files = [];
let vite, api, apiExit, browser;

try {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port: apiPort } = socket.address();
  await new Promise((done) => socket.close(done));
  const apiOrigin = "http://127.0.0.1:" + apiPort;
  vite = await preview({
    configFile: false,
    root: webRoot,
    preview: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": apiOrigin },
    },
  });
  const origin = "http://127.0.0.1:" + vite.httpServer.address().port;
  const secret = () => randomBytes(24).toString("hex");
  const password = secret();
  api = spawn(process.execPath, [apiSource], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      APP_ORIGIN: origin,
      MONGODB_URI: fixtureUri,
      ALLOW_DEMO_SEED: "false",
      REVAL_ADMIN_USERNAME: "print-lab",
      REVAL_ADMIN_PASSWORD: password,
    },
    stdio: "inherit",
    windowsHide: true,
  });
  apiExit = once(api, "exit");
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(apiOrigin + "/api/v1/health/ready", {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    await response?.text();
    if (response?.ok) break;
    assert.ok(
      attempt < 100 && api.exitCode === null,
      "Print test API failed readiness.",
    );
    await delay(200);
  }
  browser = await chromium.launch({ executablePath: REVAL_QA_CHROME });
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  async function result(path, { body, idempotencyKey } = {}, expected = 200) {
    const response = body
      ? await context.request.post("/api/v1" + path, {
          data: body,
          headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
        })
      : await context.request.get("/api/v1" + path);
    assert.equal(response.status(), expected, path);
    if (expected !== 204) return (await response.json()).result;
  }
  await result("/auth/login", { body: { username: "print-lab", password } });
  await result(
    "/auth/password",
    { body: { currentPassword: password, newPassword: secret() } },
    204,
  );
  const { warehouseId, receive } = await prepareReceiptFixture(result);
  const { shipmentPath, cartonCode } = await receive(63);

  const boxNumbers = ["998800000000001", "998800000000019"];
  const masterCode = "FG-PRINT-QA-62";
  const phone = new ObjectId(),
    master = new ObjectId(),
    basket = new ObjectId();
  const modelId = String(new ObjectId()),
    lineId = String(new ObjectId());
  const route = new ObjectId(),
    pairId = String(new ObjectId());
  // Fixture for issued labels. The production workflow itself runs in test:integration.
  await database.collection("reval_catalog_versions").insertOne({
    _id: route,
    type: "routing",
    modelId,
    lineId,
    revision: 1,
    steps: [
      {
        stationId: String(new ObjectId()),
        stationCode: "ST-LAB",
        testIds: [],
        configuration: {},
      },
    ],
  });
  await database.collection("reval_phone_units").insertOne({
    _id: phone,
    code: "PHONE-PRINT-QA",
    modelId,
    modelName: "Print lab",
    lineName: "Lab",
    state: "allocated",
    scope: { lineId },
    basketId: String(basket),
    qcPassedAt: new Date(),
    pairId,
    numbers: boxNumbers,
  });
  await database.collection("reval_baskets").insertOne({
    _id: basket,
    code: "BASKET-PRINT-QA",
    unitId: String(phone),
    modelId,
    lineId,
    status: "received",
    colorName: "Black",
    routingVersionId: String(route),
    needs: [],
  });
  await database
    .collection("reval_assembly_positions")
    .insertOne({ _id: phone, next: 1 });
  await database.collection("reval_final_records").insertOne({
    _id: phone,
    status: "packed",
    round: 1,
    version: 1,
    labelAt: new Date(),
    labelPairId: pairId,
  });
  await database.collection("reval_finished_cartons").insertOne({
    _id: master,
    code: masterCode,
    scope: { warehouseId },
    modelName: "Print lab",
    colorName: "Black",
    capacity: 9,
    status: "placed",
    version: 2,
    members: [
      {
        unitId: String(phone),
        unitCode: "PHONE-PRINT-QA",
        numbers: boxNumbers,
      },
    ],
    labelVersion: 1,
    locationName: "QA-SHELF",
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    window.print = () => {
      document.body.dataset.printRequested = "true";
    };
  });
  const cases = [
    {
      name: "logistic",
      path: shipmentPath,
      codes: [cartonCode],
      button: "بارکد کارتن",
    },
    {
      name: "box",
      path: "/final-qc/" + phone,
      codes: boxNumbers,
      button: "نمایش و چاپ مجدد برچسب جعبه",
    },
    {
      name: "master",
      path: "/finished/cartons/" + master,
      codes: [masterCode],
      button: "نمایش و چاپ مجدد برچسب کارتن",
    },
  ];
  for (const { name, path, codes, button } of cases) {
    await page.goto(path);
    await page.getByRole("button", { name: button, exact: true }).click();
    const dialog = page.locator("dialog.barcode-label[open]");
    assert.deepEqual(
      await dialog.locator("p[dir=ltr]").allTextContents(),
      codes,
      name,
    );
    await dialog.getByRole("button", { name: "چاپ بارکد" }).click();
    assert.equal(
      await page.locator("body").getAttribute("data-print-requested"),
      "true",
    );
    await page.emulateMedia({ media: "print" });
    assert.equal(await dialog.isVisible(), true, name + " label is hidden");
    const pdf = join(temp, name + ".pdf");
    files.push(pdf);
    await page.pdf({ path: pdf, format: "A4", printBackground: true });
    const { stdout } = await promisify(execFile)(python, [
      checkPdf,
      pdf,
      ...codes,
    ]);
    console.log(name + ": " + stdout.trim());
    await page.emulateMedia({ media: "screen" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
} finally {
  try {
    await browser?.close();
    if (vite) await new Promise((done) => vite.httpServer.close(done));
  } finally {
    if (api?.exitCode === null && api.signalCode === null) api.kill();
    try {
      await apiExit;
      await database.dropDatabase();
    } finally {
      await mongo.close();
      await Promise.allSettled(files.map((file) => unlink(file)));
      await rmdir(temp);
    }
  }
}
