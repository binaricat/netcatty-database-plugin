import type { VaultHostSelectedResult } from '@netcatty/plugin-contract';
export type RedisHostSelection = VaultHostSelectedResult['hosts'][number];
export class RedisEndpointPlanError extends Error {
  constructor(readonly code:'endpoint-required'|'invalid-endpoint'|'not-declared'|'invalid-declarations'|'unsupported-host-ref') {super(`Redis endpoint plan: ${code}`);}
}
/** Mirrors main byteStreamEndpoint syntax without DNS or Node APIs. This is only
 * lexical validation: the host still authorizes and rejects local/control peers.
 */
export function canonicalRedisTlsEndpoint(value:string):string {
  if(typeof value!=='string'||value.length>512)throw new RedisEndpointPlanError('invalid-endpoint');
  const match=/^tls:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(value);
  if(!match)throw new RedisEndpointPlanError('invalid-endpoint');
  let host=match[1].toLowerCase();const port=Number(match[2]);
  if(port<1||port>65535||String(port)!==match[2])throw new RedisEndpointPlanError('invalid-endpoint');
  if(host.startsWith('[')){
    try {host=new URL(`http://${host}`).hostname;} catch {throw new RedisEndpointPlanError('invalid-endpoint');}
    if(!host.startsWith('[')||!host.includes(':'))throw new RedisEndpointPlanError('invalid-endpoint');
  } else if(/^[0-9.]+$/.test(host)){
    const parts=host.split('.');
    if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255||String(Number(part))!==part))throw new RedisEndpointPlanError('invalid-endpoint');
  } else if(host.length>253||host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw new RedisEndpointPlanError('invalid-endpoint');
  return `tls://${host}:${port}`;
}
export interface RedisEndpointPlan {
  endpoint:string;
  /** Display context only. This neither discovers Redis nor grants a socket. */
  hostLabel:string|null;
  endpointSource:'explicit-user-input';
  databaseDiscovered:false;
  authorization:'host-permission-and-peer-validation-required';
}
/** Selection metadata includes hostname/username/port/protocol, but that port is
 * a saved-host service port, not a Redis discovery result. Never derive a DB
 * address from it. Opaque host refs are not network authorizations.
 */
export function planRedisEndpoint(input:{endpoint:string;declaredEndpoints:readonly string[];selectedHost?:RedisHostSelection},now=Date.now()):RedisEndpointPlan {
  if(typeof input.endpoint!=='string'||!input.endpoint)throw new RedisEndpointPlanError('endpoint-required');
  const endpoint=canonicalRedisTlsEndpoint(input.endpoint);
  if(!Array.isArray(input.declaredEndpoints)||input.declaredEndpoints.length>256)throw new RedisEndpointPlanError('invalid-declarations');
  let declared:string[];
  try {declared=input.declaredEndpoints.map(canonicalRedisTlsEndpoint);} catch {throw new RedisEndpointPlanError('invalid-declarations');}
  if(!declared.includes(endpoint))throw new RedisEndpointPlanError('not-declared');
  let hostLabel:string|null=null;
  if(input.selectedHost!==undefined){
    const host=input.selectedHost;
    if(!host||host.target?.kind!=='host.selection'||host.target.scope!=='metadata'||typeof host.target.handle!=='string'||!host.target.handle||typeof host.target.revision!=='string'||!host.target.revision||!Number.isSafeInteger(host.target.expiresAt)||host.target.expiresAt<=now||typeof host.metadata?.label!=='string')throw new RedisEndpointPlanError('unsupported-host-ref');
    hostLabel=host.metadata.label.replaceAll('\0','').slice(0,128);
  }
  return {endpoint,hostLabel,endpointSource:'explicit-user-input',databaseDiscovered:false,authorization:'host-permission-and-peer-validation-required'};
}
