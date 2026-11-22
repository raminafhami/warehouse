import mongoose from "mongoose";

/** @param {string} uri */
export async function connectDatabase(uri) {
  const database = mongoose.createConnection(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 3000,
  });
  try {
    await database.asPromise();
    if (!(await isDatabaseReady(database))) {
      throw new Error("MongoDB replica set has no writable primary.");
    }
    return database;
  } catch {
    await database.close().catch(() => {});
    throw new Error(
      "Cannot connect to a writable MongoDB replica set. Check the database and MONGODB_URI.",
    );
  }
}

/** @param {import('mongoose').Connection} database */
export async function isDatabaseReady(database) {
  if (database.readyState !== 1 || !database.db) return false;
  try {
    const hello = await database.db.command({ hello: 1 }, { timeoutMS: 1000 });
    return Boolean(hello.setName && hello.isWritablePrimary);
  } catch {
    return false;
  }
}
