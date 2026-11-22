import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import { assertContractResponse } from "./support/release-contract.js";

const userId = "65bf00000000000000000001";
const branchId = "65bf00000000000000000002";
const groupId = "65bf00000000000000000003";
const profileId = "65bf00000000000000000004";
const externalRefs = new Map([
  [JSON.stringify(["ROVAL", "User", userId]), profileId],
  [JSON.stringify(["ROVAL", "UserGroup", groupId]), branchId],
]);
const actions = new Map([
  ["read", "view"],
  ["update", "edit"],
]);

function lookup(entity, externalId) {
  if (!/^[a-f0-9]{24}$/i.test(externalId)) return null;
  return (
    externalRefs.get(JSON.stringify(["ROVAL", entity, externalId])) ?? null
  );
}

function mappedPermission({ subject, actions: source, conditions }) {
  const keys = Object.keys(conditions);
  if (subject !== "materials" || keys.length !== 1 || keys[0] !== "branchId")
    return [];
  const mapped = lookup("UserGroup", conditions.branchId);
  if (!mapped || source.some((action) => !actions.has(action))) return [];
  return source.map((action) => ({
    permission: "inventory:" + actions.get(action),
    scope: { branchId: mapped },
  }));
}

test("offline ROVAL fixtures preserve IDs, pagination and explicit permission scopes", () => {
  const row = {
    _id: new ObjectId(userId),
    username: "fixture",
    name: "Fixture",
    isActive: true,
  };
  const versionOne = {
    statusCode: 200,
    message: "OK",
    result: {
      data: [
        {
          id: lookup("User", String(row._id)),
          username: row.username,
          name: row.name,
          roleId: "fixture-role",
        },
      ],
      count: 2,
    },
  };
  assert.ok(
    assertContractResponse("GET", "/users?page=0&size=1", 200, versionOne),
  );
  assert.equal(versionOne.result.data[0].id, profileId);
  assert.equal(
    externalRefs.get(JSON.stringify(["ROVAL", "User", userId])),
    profileId,
  );
  assert.equal(lookup("Branch", groupId), null);
  assert.deepEqual(
    mappedPermission({
      subject: "materials",
      actions: ["read", "update"],
      conditions: { branchId: groupId },
    }),
    [
      { permission: "inventory:view", scope: { branchId } },
      { permission: "inventory:edit", scope: { branchId } },
    ],
  );
  assert.deepEqual(
    mappedPermission({
      subject: "materials",
      actions: ["read", "delete"],
      conditions: { branchId: groupId },
    }),
    [],
  );
  assert.deepEqual(
    mappedPermission({
      subject: "materials",
      actions: ["read"],
      conditions: { branchId: groupId, extra: true },
    }),
    [],
  );
  const skuMap = new Map([
    [String(row._id), { modelId: branchId, skuId: profileId }],
  ]);
  assert.notEqual(skuMap.get(userId).modelId, skuMap.get(userId).skuId);
  assert.throws(
    () =>
      assertContractResponse("GET", "/users", 200, {
        ...versionOne,
        result: { items: [], count: 1 },
      }),
    /missing data/,
  );
  assert.throws(
    () =>
      assertContractResponse("GET", "/health/live", 200, {
        statusCode: 200,
        message: "OK",
        result: { status: "ready" },
      }),
    /invalid choice/,
  );
});

test("offline event example rejects unknown versions, and does one effect per event ID", () => {
  const seen = new Map(),
    effects = [];
  function receive(event) {
    if (event.schemaVersion !== 1 || event.type !== "ShipmentReceived")
      throw Error("Unknown event contract");
    const canonical = JSON.stringify([
      event.type,
      event.schemaVersion,
      event.aggregateId,
      event.occurredAt,
    ]);
    if (seen.has(event.eventId)) {
      if (seen.get(event.eventId) !== canonical)
        throw Error("Changed event payload");
      return false;
    }
    seen.set(event.eventId, canonical);
    effects.push(event.aggregateId);
    return true;
  }
  const event = {
    eventId: "shipment-receipt-fixture",
    schemaVersion: 1,
    type: "ShipmentReceived",
    aggregateId: userId,
    occurredAt: "2026-11-20T12:00:00.000Z",
  };
  assert.equal(receive(event), true);
  assert.equal(receive({ ...event }), false);
  assert.throws(
    () => receive({ ...event, aggregateId: branchId }),
    /Changed event payload/,
  );
  assert.throws(
    () => receive({ ...event, schemaVersion: 2 }),
    /Unknown event contract/,
  );
  assert.deepEqual(effects, [userId]);
});
