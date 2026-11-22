import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function prepareReceiptFixture(result) {
  const add = (kind, code, data = {}, parentId) =>
    result(
      "/master/" + kind,
      { body: { code, name: code, data, parentId } },
      201,
    );
  const branch = await add("branches", "BR-LAB");
  const warehouse = await add("warehouses", "WH-LAB", {}, branch.id);
  const unit = await add("units", "PCS");
  const partType = await add("partTypes", "BAT", { unitId: unit.id });
  const supplier = await add("suppliers", "SUP-LAB");
  const sku = await add("skus", "BAT-LAB", {
    partTypeId: partType.id,
    supplierId: supplier.id,
    specification: "Release rehearsal",
  });

  async function receive(sequence) {
    const suffix = String(sequence).padStart(4, "0");
    const shipment = await result(
      "/shipments",
      {
        body: {
          warehouseId: warehouse.id,
          supplierId: supplier.id,
          waybillNumber: "LAB-" + suffix,
          expectedCartons: 1,
        },
      },
      201,
    );
    const shipmentPath = "/shipments/" + shipment.id;
    const pallet = await result(
      shipmentPath + "/pallets",
      { body: { code: "PLT-1405-" + suffix } },
      201,
    );
    const carton = await result(
      shipmentPath + "/cartons",
      {
        body: {
          palletId: pallet.id,
          code: "CTN-1405-" + suffix,
          skuId: sku.id,
          quantity: "5",
        },
      },
      201,
    );
    const draft = await result(shipmentPath);
    const receiptCommand = {
      body: { version: draft.shipment.version },
      idempotencyKey: randomUUID(),
    };
    const receiptPath = shipmentPath + "/receipts";
    const receipt = await result(receiptPath, receiptCommand, 201);
    const balancesPath = "/inventory/balances?q=" + carton.code;
    const reconcilePath = "/inventory/cartons/" + carton.id + "/reconciliation";
    const balances = await result(balancesPath);
    assert.equal(balances.count, 1);
    assert.equal(balances.data[0].quantity, "5");
    assert.equal((await result(reconcilePath)).balanced, true);

    async function verify(options = {}) {
      assert.deepEqual(await result(balancesPath, options), balances);
      const shipment = await result(shipmentPath, options);
      assert.deepEqual(
        shipment.receipts.map((row) => row.id),
        [receipt.id],
      );
    }

    async function replay() {
      assert.equal((await result(receiptPath, receiptCommand)).id, receipt.id);
      assert.equal((await result(reconcilePath)).balanced, true);
      await verify();
    }
    return { verify, replay, shipmentPath, cartonCode: carton.code };
  }

  return { warehouseId: warehouse.id, receive };
}
