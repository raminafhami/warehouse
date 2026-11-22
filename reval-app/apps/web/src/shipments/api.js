import { request } from "../request/identity.js";

/** @typedef {{id:string, code:string, supplierName:string, warehouseName:string, scope:Record<string,string>, waybillNumber:string, purchaseOrder:string, notes:string, expectedCartons:number, scannedCartons:number, receivedCartons:number, quarantinedCartons:number, palletCount:number, status:"receiving"|"discrepancy"|"approved", version:number, createdAt:string, waybill?:{fileId:string,name:string,size:number}, discrepancy?:{reason:string,countDifference:number}, resolution?:{reason:string}}} Shipment */
/** @typedef {{id:string,code:string,name:string}} Choice */
/** @typedef {{id:string,code:string}} Pallet */
/** @typedef {{id:string,palletId:string,code:string,skuCode:string,lot?:string,quantity:string,condition:"accepted"|"quarantine",state:"scanned"|"received"}} Carton */
/** @typedef {{id:string,at:string,cartonCount:number,quarantinedCount:number,totalReceived:number,reason:string}} Receipt */
/** @typedef {{shipment:Shipment,pallets:Pallet[],cartons:Carton[],receipts:Receipt[],skus:Choice[]}} ShipmentDetail */
export const statusLabels = {
  receiving: "در حال ثبت",
  discrepancy: "مغایرت باز",
  approved: "تأییدشده",
};
export const dateLabel = new Intl.DateTimeFormat("fa-IR", {
  dateStyle: "short",
  timeZone: "Asia/Tehran",
});

/** @param {string} id @param {File} file */
export function uploadWaybill(id, file) {
  return request("/shipments/" + id + "/waybill", {
    method: "PUT",
    body: file,
    headers: { "X-Filename": encodeURIComponent(file.name) },
  });
}

/** @param {import("../request/identity.js").Profile} profile @param {Shipment} shipment @param {string} action */
export function allowShipmentAction(profile, shipment, action) {
  return (
    profile.permissions.includes("shipments:" + action) &&
    (profile.organizationWide ||
      profile.scopes.some(
        (scope) =>
          Object.keys(scope).length > 0 &&
          Object.entries(scope).every(
            ([key, value]) => shipment.scope[key] === value,
          ),
      ))
  );
}
