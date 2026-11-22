/** @typedef {{id:string,name:string,code:string}} Option */
/** @typedef {Option & {imeiSlots:number,colorIds:string[]}} Model */
/** @typedef {{models:Model[],lines:Option[],colors:Option[],canImport:boolean,canViewImports:boolean,demo:boolean}} Options */
/** @typedef {{id:string,modelName:string,numbers:string[],row:number,status:"free"|"allocated"|"void",hamtaStatus?:HamtaStatus,hasError?:boolean}} Pair */
/** @typedef {{id:string,code:string,modelName:string,colorName:string,lineName:string,count:number,allocated:number,replacementDue:number,bomRevision:number,routingRevision:number}} Order */
/** @typedef {"pending"|"submitted"|"activated"|"error"} HamtaStatus */
/** @typedef {{id:string,code:string,orderCode:string,modelName:string,lineName:string,numbers:string[],state:"allocated"|"released"|"void",printedAt?:string,qcPassedAt?:string,imeiError?:string,hamtaStatus?:HamtaStatus,trackingCode?:string,evidenceFile?:{id:string,name:string},hamtaReason?:string,canApprove?:boolean,version:number}} Unit */
/** @typedef {{id:string,source:string,modelName:string,accepted:number,errors:{row:number,code:string}[]}} ImportReport */
/** @typedef {{id:string,action:string,actorId:string,detail:Record<string,unknown>,at:string}} History */
/** @typedef {{order:Order,data:Unit[],count:number,access:{allocate:boolean,release:boolean,void:boolean,error:boolean}}} OrderDetail */

export const emptyOptions = /** @type {Options} */ ({
  models: [],
  lines: [],
  colors: [],
  canImport: false,
  canViewImports: false,
  demo: false,
});
export const hamtaLabels = {
  pending: "در انتظار همتا",
  submitted: "ارسال‌شده، نتیجه نامعلوم",
  activated: "فعال در همتا",
  error: "خطا",
};
export const pairLabels = {
  free: "آزاد",
  allocated: "تخصیص‌یافته",
  void: "ابطال‌شده",
  ...hamtaLabels,
};
export const unitLabels = {
  allocated: "تخصیص‌یافته",
  released: "آزادشده",
  void: "ابطال‌شده",
};
export const errorLabels = /** @type {Record<string,string>} */ ({
  SLOTS: "تعداد شناسه با تعداد سیم‌کارت مدل سازگار نیست.",
  CHECK_DIGIT: "شناسه باید ۱۵ رقم و دارای رقم کنترلی معتبر باشد.",
  SAME_PAIR: "دو شناسهٔ گوشی یکسان‌اند.",
  DUPLICATE: "حداقل یک شناسه قبلاً ثبت شده است.",
});
