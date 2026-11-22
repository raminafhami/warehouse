/** @typedef {{id:string,kind:string,code:string,name:string,parentId?:string|null,purpose?:string,placement?:{cartons:number,skuCode?:string}}} Choice */
/** @typedef {{id:string,cartonId:string,cartonCode:string,skuCode:string,warehouseId:string,shipmentCode:string,supplierName:string,locationCode?:string,account:"receiving"|"storage"|"quarantine",quantity:string,reserved:string,available:string,version:number}} Balance */
/** @typedef {{id:string,code:string,cartonCount:number,source:string,locations:string[],items:{cartonId:string,version:number}[],hasQuarantine:boolean}} Pallet */
/** @typedef {{skuId:string,skuCode:string,supplierId:string,supplierName:string,receiving:string,storage:string,quarantine:string,reserved:string}} Summary */
/** @typedef {{id:string,documentId:string,cartonId:string,documentType:string,from:string,to:string,fromLocationCode?:string,toLocationCode?:string,quantity:string,reason?:string,reversesId?:string,reversed:boolean,at:string}} Movement */
/** @typedef {{id:string,quantity:string,reason:string}} Reservation */
/** @typedef {{actual:string,expected:string,reserved:string,expectedReserved:string,basket?:string,nonAllocatable?:Record<string,string>,balanced:boolean}} Reconciliation */
/** @type {Record<string,string>} */
export const accountLabels = {
  basket: "در سبد",
  consumed: "مصرف‌شده در گوشی",
  defective: "معیوب در خط",
  defect_store: "قرنطینهٔ معیوبی",
  supplier_return: "تحویل تأمین‌کننده",
  replacement_reserved: "رزرو جایگزین",
  transit: "در راه",
  production: "در اختیار تولید",
  line: "در خط",
  receiving: "محل دریافت",
  storage: "جانمایی‌شده",
  quarantine: "قرنطینه",
  external: "ورود از خارج",
  adjustment: "اصلاح موجودی",
};
export const clock = new Intl.DateTimeFormat("fa-IR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Tehran",
});
