export { useCommand as useHandoverCommand } from "../request/useCommand.js";

/** @typedef {{id:string,code:string,name:string}} Option */
/** @typedef {{id:string,code:string,modelName:string,bomRevision:number,bomVersionId:string,warehouseId:string,warehouseName:string,lineId:string,lineName:string,count:number,version:number,status:"open"|"partial"|"fulfilled"|"cancelled",at:string,needs:{skuId:string,skuCode:string,required:string,issued:string}[],cancellationReason?:string}} Request */
/** @typedef {{id:string,code:string,issuerId:string,version:number,status:"issued"|"received"|"discrepancy"|"partial"|"returned",reason?:string}} Delivery */
/** @typedef {Delivery & {requestId:string,requestCode:string,modelName:string,warehouseName:string,lineName:string}} DeliveryEntry */
/** @typedef {{id:string,deliveryId:string,cartonCode:string,skuCode:string,issued:string,transit:string,line:string,basket:string,returned:string,lineName?:string}} Item */
/** @typedef {{request:Request,reservations:{id:string,cartonCode:string,skuId:string,quantity:string}[],deliveries:Delivery[],custody:Item[],stock:{id:string,cartonCode:string,skuCode:string,available:string,locationCode?:string}[],access:{transfer:boolean,cancel:boolean,approve:boolean,reject:boolean,actorId:string}}} Detail */

export const requestStatus = {
  open: "در انتظار آماده‌سازی",
  partial: "صدور جزئی",
  fulfilled: "حواله صادر شد",
  cancelled: "لغوشده",
};
export const deliveryStatus = {
  issued: "در راه",
  received: "دریافت‌شده",
  discrepancy: "مغایرت باز",
  partial: "دریافت جزئی",
  returned: "برگشت‌شده",
};
