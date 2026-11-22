/** @typedef {{id:string,code:string,name:string,lineId:string,lineName:string}} Station */
/** @typedef {{id:string,name:string}} Option */
/** @typedef {{id:string,unitCode:string,modelName:string,orderCode:string,status:string,visitId?:string}} QueueItem */
/** @typedef {{items:QueueItem[],count:number,models:Option[],access:{scan:boolean,pdf:boolean}}} Queue */
/** @typedef {{id:string,unitCode:string,stationCode:string,stationName:string,lineName:string,modelName:string,status:"installing"|"testing"|"transferred",version:number,index:number,enteredName?:string,entryAt:string,completedAt?:string,exitAt?:string}} Visit */
/** @typedef {{id:string,code:string,name:string,results:string[]}} Test */
/** @typedef {{id:string,visitId:string,unitCode:string,testId:string,testName:string,stationName:string,answer:string,outcome:keyof typeof outcomes,attempt:number,revision:number,replacesId?:string,reason?:string,at:string}} Result */
/** @typedef {{_id:{testId:string,name:string,routingVersionId:string},total:number,failed:number,review:number}} Rate */
/** @typedef {{visit:Visit,routeLength:number,history:Visit[],defects:import('../pages/DefectActions.jsx').Defect[],canOpenDefect:boolean,settings:{operation:string,requirements:string[],tests:Test[],maxRetests:number},needs:import('../basket/api.js').Need[],parts:import('../basket/api.js').Part[],results:Result[],access:{install:boolean,complete:boolean,test:boolean,correct:boolean,transfer:boolean}}} VisitDetail */
export const outcomes = { pass: "قبول", fail: "رد", review: "نیازمند بررسی" };
/** @type {Record<string,string>} */
export const stages = {
  queued: "آمادهٔ ورود",
  installing: "در حال مونتاژ",
  testing: "در کنترل کیفیت",
  transferred: "منتقل‌شده",
};
