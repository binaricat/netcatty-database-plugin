/** Serialize ADD/RENAME previews per adapter/handle, including close/reopen. */
const previewQueues=new WeakMap<object,Map<string,Promise<void>>>();
export async function serialPreview<T>(database:object,handleId:string,run:()=>Promise<T>):Promise<T>{
 let queues=previewQueues.get(database);if(!queues){queues=new Map();previewQueues.set(database,queues);}
 const previous=queues.get(handleId)??Promise.resolve();const current=previous.then(run);const tail=current.then(()=>{},()=>{});queues.set(handleId,tail);
 try{return await current;}finally{if(queues.get(handleId)===tail)queues.delete(handleId);}
}
