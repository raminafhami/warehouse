/** @typedef {{id:string,code:string,unitCode:string,orderCode:string,modelName:string,colorName:string,lineName:string,bomRevision:number,status:keyof typeof basketStatus,version:number,handedAt?:string,receivedAt?:string,needs:Need[]}} Basket */
/** @typedef {{skuId:string,skuCode:string,quantity:string,stationCode:string}} Need */
/** @typedef {{id:string,code:string,skuId:string,skuCode:string,cartonCode:string,quantity:string,state:keyof typeof partStatus,reason?:string}} Part */
/** @typedef {{id:string,numbers:string[],labelVersion:string,printed:boolean,confirmed:boolean,state:"allocated"|"released"|"void",imeiError?:string}} Unit */
/** @typedef {{basket:Basket,unit:Unit,parts:Part[],coverage:Record<string,{allocated:string,remaining:string}>,access:{create:boolean,scan:boolean,edit:boolean,approve:boolean,transfer:boolean,receive:boolean,pdf:boolean,demo:boolean}}} Detail */
/** @typedef {{id:string,code:string,modelName:string,colorName:string,lineName:string}} OrderOption */
/** @typedef {{id:string,cartonCode:string,line:string}} Stock */
export const basketStatus = {
  preparing: "در حال آماده‌سازی",
  ready: "تکمیل‌شده",
  handed_over: "در انتظار دریافت مونتاژ",
  received: "دریافت‌شده در مونتاژ",
  cancelled: "لغوشده",
};
export const partStatus = {
  printed: "در انتظار اسکن",
  allocated: "داخل سبد",
  installed: "نصب‌شده",
  defective: "معیوب",
  defect_store: "قرنطینهٔ معیوبی",
  supplier_return: "تحویل تأمین‌کننده",
  replacement_reserved: "جایگزین رزروشده",
  void: "برچسب ابطال‌شده",
  returned: "برگشت به خط",
};
