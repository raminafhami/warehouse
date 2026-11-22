import { MongoClient, ObjectId } from "mongodb";

const [uri] = process.argv.slice(2);
if (!uri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/\?replicaSet=[\w-]+$/.test(uri))
  throw new Error("Use a local MongoDB replica set.");

const client = new MongoClient(uri);
const source = client.db("reval_test_uiparityclean");
const target = client.db("reval_dev");
const marker = "reference-demo-on-5173-v1";
const collections = [
  "reval_catalog",
  "reval_catalog_versions",
  "reval_shipments",
  "reval_pallets",
  "reval_material_cartons",
  "reval_shipment_receipts",
  "reval_stock_balances",
  "reval_stock_ledger",
  "reval_reservations",
  "reval_material_custody",
  "reval_material_requests",
  "reval_material_deliveries",
  "reval_imei_imports",
  "reval_imei_pairs",
  "reval_imei_history",
  "reval_production_orders",
  "reval_phone_units",
  "reval_baskets",
  "reval_basket_parts",
  "reval_assembly_positions",
  "reval_station_visits",
  "reval_stage_results",
  "reval_final_records",
  "reval_final_checks",
  "reval_final_rejections",
  "reval_finished_cartons",
  "reval_defects",
  "reval_supplier_returns",
];

try {
  const manifests = target.collection("reval_local_imports");
  if (await manifests.findOne({ _id: marker })) {
    console.log("Operational reference data was already installed.");
  } else {
    const [originalAdmin, localAdmin, sampleUsers, counters, audit, snapshot] =
      await Promise.all([
        source
          .collection("reval_users")
          .findOne({ username: "demo-reval", demoAccount: true }),
        target
          .collection("reval_users")
          .findOne({
            username: "reval-admin",
            roleId: "superadmin",
            active: true,
          }),
        source
          .collection("reval_users")
          .find({ demoAccount: true, roleId: { $ne: "superadmin" } })
          .toArray(),
        source.collection("reval_counters").find().toArray(),
        source.collection("reval_audit").find({}).toArray(),
        source
          .collection("reval_reference_snapshot")
          .findOne({ _id: "_summary" }),
      ]);
    if (
      !originalAdmin ||
      !localAdmin ||
      snapshot?.operational?.shipments !== 15 ||
      snapshot.issues.length
    )
      throw new Error(
        "The verified reference and current local administrator are required.",
      );
    const originalId = String(originalAdmin._id);
    const targetId = String(localAdmin._id);
    function mapActor(value) {
      if (value === originalId) return targetId;
      if (value instanceof ObjectId && value.equals(originalAdmin._id))
        return localAdmin._id;
      if (Array.isArray(value)) return value.map(mapActor);
      if (value && Object.getPrototypeOf(value) === Object.prototype)
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, mapActor(item)]),
        );
      return value;
    }
    const data = await Promise.all(
      collections.map(async (name) => [
        name,
        await source.collection(name).find().toArray(),
      ]),
    );
    if (!data.find(([name]) => name === "reval_finished_cartons")[1].length)
      throw new Error("Sample product inventory is unavailable.");

    await client.withSession((session) =>
      session.withTransaction(async () => {
        for (const [name] of data) {
          if (
            await target
              .collection(name)
              .findOne({}, { session, projection: { _id: 1 } })
          )
            throw new Error(
              "Target operational collection is not empty: " + name,
            );
        }
        for (const [name, rows] of data) {
          if (rows.length)
            await target
              .collection(name)
              .insertMany(rows.map(mapActor), { session });
        }
        if (sampleUsers.length)
          await target
            .collection("reval_users")
            .insertMany(sampleUsers, { session });
        if (audit.length)
          await target
            .collection("reval_audit")
            .insertMany(audit.map(mapActor), { session });
        for (const row of counters)
          await target
            .collection("reval_counters")
            .updateOne(
              { _id: row._id },
              { $max: { value: row.value } },
              { session, upsert: true },
            );
        await manifests.insertOne(
          { _id: marker, at: new Date(), source: source.databaseName },
          { session },
        );
      }),
    );
    console.log(
      JSON.stringify(
        Object.fromEntries(data.map(([name, rows]) => [name, rows.length])),
        null,
        2,
      ),
    );
  }
} finally {
  await client.close();
}
