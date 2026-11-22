import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { readConfig } from "../src/config.js";
import { migrate, seedDemo } from "../src/database/bootstrap.js";
import {
  connectDatabase,
  isDatabaseReady,
} from "../src/database/connection.js";

test("replica-set transactions, repeatable bootstrap and persistence across connections", async () => {
  const source = readConfig({
    NODE_ENV: "test",
    MONGODB_URI: process.env.TEST_MONGODB_URI,
  });
  const sandbox = `reval_test_${randomBytes(8).toString("hex")}`;
  const uri = source.uri.replace(
    /\/reval_test(?:_[a-z0-9]+)?(?=\?)/,
    `/${sandbox}`,
  );
  assert.notEqual(uri, source.uri);
  let database = await connectDatabase(uri);
  try {
    assert.equal(await isDatabaseReady(database), true);
    await assert.rejects(seedDemo(database, false), /ALLOW_DEMO_SEED/);
    const demo = database.collection("reval_demo_metadata");
    assert.equal(await demo.countDocuments(), 0);
    await migrate(database);
    await migrate(database);
    assert.equal(await demo.countDocuments(), 0);
    await seedDemo(database, true);
    const firstSeed = await demo.findOne({});
    await seedDemo(database, true);
    assert.deepEqual(await demo.findOne({}), firstSeed);

    const records = database.collection("reval_test_records");
    await database.transaction(async (session) => {
      await records.insertOne({ type: "committed" }, { session });
    });
    await assert.rejects(
      database.transaction(async (session) => {
        await records.insertOne({ type: "rolled_back" }, { session });
        throw new Error("rollback test");
      }),
      /rollback test/,
    );
    await database.close();
    database = await connectDatabase(uri);
    assert.equal(
      await database.collection("reval_schema_migrations").countDocuments(),
      1,
    );
    assert.equal(
      await database.collection("reval_demo_metadata").countDocuments(),
      1,
    );
    assert.equal(
      await database
        .collection("reval_test_records")
        .countDocuments({ type: "committed" }),
      1,
    );
    assert.equal(
      await database
        .collection("reval_test_records")
        .countDocuments({ type: "rolled_back" }),
      0,
    );
  } finally {
    if (database.readyState !== 1) database = await connectDatabase(uri);
    try {
      assert.equal(database.name, sandbox);
      await database.dropDatabase();
    } finally {
      await database.close();
    }
  }
});
