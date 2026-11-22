/** @param {import('mongoose').Connection} database */
export async function migrate(database) {
  const migrations =
    /** @type {import('mongoose').Collection<{ _id: string, appliedAt: Date }>} */ (
      database.collection("reval_schema_migrations")
    );
  await migrations.updateOne(
    { _id: "001-initialize" },
    { $setOnInsert: { appliedAt: new Date() } },
    { upsert: true },
  );
}

/** @param {import('mongoose').Connection} database @param {boolean} allowed @param {string} [password] */
export async function seedDemo(database, allowed, password) {
  if (!allowed) throw new Error("Demo seed requires ALLOW_DEMO_SEED=true.");
  if (password !== undefined) {
    if (!validPassword(password))
      throw new Error(
        "Demo seed password must be between 12 and 256 characters.",
      );
    await seedDemoAccounts(database, password);
  }
  const demo =
    /** @type {import('mongoose').Collection<{ _id: string, label: string, createdAt: Date }>} */ (
      database.collection("reval_demo_metadata")
    );
  await demo.updateOne(
    { _id: "p02-demo" },
    { $setOnInsert: { label: "دادهٔ نمونهٔ محیط توسعه", createdAt: new Date() } },
    { upsert: true },
  );
}
import { hashPassword } from "../identity/password.js";
import { identityStore } from "../identity/store.js";
import { validPassword } from "../identity/validation.js";

const accounts = [
  ["demo-reval", "لیلا محمدی", "superadmin"],
  ["demo-warehouse", "حسین نوری", "whManager"],
  ["demo-basket", "علی کریمی", "basketOperator"],
  ["demo-assembly", "امیر صادقی", "assemblyOperator"],
  ["demo-quality", "نگار احمدی", "qcManager"],
  ["demo-production", "مریم رضایی", "productionManager"],
  ["demo-finished", "رضا موسوی", "fgOfficer"],
  ["demo-system", "بهروز تقوی", "sysadmin"],
  ["demo-warehouse-op", "پویا رحیمی", "whOperator"],
  ["demo-handover", "کامران صالحی", "handoverOfficer"],
  ["demo-defects", "سارا یوسفی", "defectsOfficer"],
  ["demo-reports", "محمد زارعی", "reportsManager"],
  ["demo-st01", "فاطمه حسینی", "stOp01"],
  ["demo-st02", "سعید قاسمی", "stOp02"],
  ["demo-st03", "آرزو رضایی", "stOp03"],
  ["demo-st04", "پیمان کریمی", "stOp04"],
  ["demo-st05", "الهام محمدی", "stOp05"],
  ["demo-st06", "شیما جلالی", "stOp06"],
  ["demo-st07", "کیوان صادقی", "stOp07"],
  ["demo-st08", "سحر ابراهیمی", "stOp08"],
];

/** @param {import('mongoose').Connection} database @param {string} password */
async function seedDemoAccounts(database, password) {
  const { users } = identityStore(database);
  const passwordHash = await hashPassword(password);
  for (const [username, name, roleId] of accounts) {
    await users.updateOne(
      { username, demoAccount: true },
      {
        $setOnInsert: {
          username,
          name,
          roleId,
          unit: "کارخانه نمونه",
          organizationWide: !roleId.startsWith("stOp"),
          scopes: [],
          active: true,
          mustChangePassword: false,
          demoAccount: true,
          passwordHash,
          version: 0,
        },
      },
      { upsert: true },
    );
  }
}
