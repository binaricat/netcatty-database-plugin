import {useEffect,useMemo,useState} from 'react';
import type {PluginContext} from '@netcatty/plugin-sdk';
import {connectRedis,RedisSessionError,type RedisConnectOptions,type RedisSession} from './redisSession';
import {createRedisBrowser,RedisBrowserError,type RedisBinary} from './redisBrowser';
import {planRedisEndpoint,RedisEndpointPlanError,type RedisHostSelection} from './redisEndpointPlan';
type Browser=ReturnType<typeof createRedisBrowser>;
export type RedisScanPage=Awaited<ReturnType<Browser['scan']>>;
export type RedisValuePage=Awaited<ReturnType<Browser['readPage']>>;
export interface RedisWorkbenchState {status:'disconnected'|'connecting'|'connected'|'closed';busy:boolean;endpoint:string|null;hostLabel:string|null;error:string|null;info:Awaited<ReturnType<Browser['serverInfo']>>|null;scan:RedisScanPage|null;selected:RedisBinary|null;page:RedisValuePage|null;}
type Session=Pick<RedisSession,'request'|'close'|'isClosed'>;
export interface RedisWorkbenchDependencies {connect:(options:RedisConnectOptions)=>Promise<Session>;}
const initial=():RedisWorkbenchState=>({status:'disconnected',busy:false,endpoint:null,hostLabel:null,error:null,info:null,scan:null,selected:null,page:null});
function safeError(error:unknown){return error instanceof RedisSessionError||error instanceof RedisBrowserError||error instanceof RedisEndpointPlanError?error.code:'unavailable';}
/** No automatic connection, reads or persistence. Polling checks local isClosed only. */
export function createRedisWorkbenchController(deps:RedisWorkbenchDependencies,declaredEndpoints:readonly string[],selectedHost?:RedisHostSelection){
 let state=initial(),generation=0,session:Session|null=null,browser:Browser|null=null,abort:AbortController|null=null;
 const listeners=new Set<()=>void>();const emit=(patch:Partial<RedisWorkbenchState>)=>{state={...state,...patch};for(const listener of listeners)listener();};
 const disconnect=()=>{generation++;abort?.abort();abort=null;const old=session;session=null;browser=null;state=initial();for(const listener of listeners)listener();if(old)void old.close().catch(()=>{});};
 const checkClosed=()=>{if(session?.isClosed){generation++;abort?.abort();abort=null;session=null;browser=null;emit({status:'closed',busy:false,error:'closed',info:null,scan:null,selected:null,page:null});}};
 const action=async<T,>(run:(client:Browser)=>Promise<T>,apply:(value:T)=>Partial<RedisWorkbenchState>)=>{
  checkClosed();if(state.busy||!browser||state.status!=='connected')return;const rev=generation,client=browser;emit({busy:true,error:null});
  try{const value=await run(client);if(rev===generation){checkClosed();if(rev===generation)emit({...apply(value),busy:false});}}
  catch(error){if(rev===generation){checkClosed();if(rev===generation)emit({busy:false,error:safeError(error)});}}
 };
 return {
  getSnapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},disconnect,dispose:disconnect,checkClosed,
  async connect(endpoint:string,authentication?:RedisConnectOptions['authentication']){
   if(state.busy||state.status==='connected')return;
   let plan;try{plan=planRedisEndpoint({endpoint,declaredEndpoints,selectedHost});}catch(error){emit({error:safeError(error)});return;}
   disconnect();const rev=generation;abort=new AbortController();emit({status:'connecting',busy:true,endpoint:plan.endpoint,hostLabel:plan.hostLabel,error:null});
   try{const opened=await deps.connect({endpoint:plan.endpoint,authentication,signal:abort.signal});if(rev!==generation){void opened.close().catch(()=>{});return;}session=opened;browser=createRedisBrowser(opened);emit({status:opened.isClosed?'closed':'connected',busy:false,error:opened.isClosed?'closed':null});checkClosed();}
   catch(error){if(rev===generation){abort?.abort();abort=null;emit({status:'disconnected',busy:false,error:safeError(error)});}}
  },
  serverInfo:()=>action(client=>client.serverInfo(),info=>({info})),
  scan:(next=false)=>{const cursor=next?state.scan?.nextCursor:'0';if(!cursor||next&&state.scan?.done)return Promise.resolve();return action(client=>client.scan({cursor,pageSize:50}),scan=>({scan,selected:null,page:null}));},
  select:(key:RedisBinary)=>{const selected={...key,bytes:key.bytes.slice()};return action(client=>client.readPage(selected.bytes,{pageSize:50}),page=>({selected,page}));},
  nextValue:()=>{const selected=state.selected,page=state.page;if(!selected||!page)return Promise.resolve();
   if(page.kind==='list'&&page.nextOffset!==null)return action(client=>client.readPage(selected.bytes,{offset:page.nextOffset!,pageSize:50}),page=>({page}));
   if((page.kind==='hash'||page.kind==='set'||page.kind==='zset')&&!page.done)return action(client=>client.readPage(selected.bytes,{cursor:page.nextCursor,pageSize:50}),page=>({page}));return Promise.resolve();},
 };
}
export function useRedisWorkbench(context:PluginContext,declaredEndpoints:readonly string[],selectedHost?:RedisHostSelection){
 const signature=JSON.stringify(declaredEndpoints);
 const controller=useMemo(()=>createRedisWorkbenchController({connect:options=>context.enabledFeatures.has('network.byte-streams')?connectRedis(context.network,options):Promise.reject(new RedisSessionError('transport'))},declaredEndpoints,selectedHost),[context,signature,selectedHost]);
 const [state,setState]=useState(controller.getSnapshot);
 useEffect(()=>{setState(controller.getSnapshot());const unsubscribe=controller.subscribe(()=>setState(controller.getSnapshot()));const timer=setInterval(controller.checkClosed,500);return()=>{clearInterval(timer);unsubscribe();controller.dispose();};},[controller]);
 return {...state,controller};
}
