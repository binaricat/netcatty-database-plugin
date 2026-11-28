import manifest from '../netcatty.plugin.json';
import {canonicalRedisTlsEndpoint} from './redisEndpointPlan';
/** Package data only, never a permission grant or editable network allowlist. */
export function declaredRedisEndpoints(value:unknown):readonly string[]{
  if(!value||typeof value!=='object')return [];
  const item=value as {features?:{required?:unknown;optional?:unknown};permissions?:{required?:unknown;optional?:unknown}};
  const features=[...(Array.isArray(item.features?.required)?item.features.required:[]),...(Array.isArray(item.features?.optional)?item.features.optional:[])];
  if(!features.includes('network.byte-streams'))return [];
  const declarations=[...(Array.isArray(item.permissions?.required)?item.permissions.required:[]),...(Array.isArray(item.permissions?.optional)?item.permissions.optional:[])];
  const result=new Set<string>();
  for(const declaration of declarations){
    if(!declaration||typeof declaration!=='object'||declaration.permission!=='network.stream')continue;
    if(!Array.isArray(declaration.resources)||declaration.resources.length>256)return [];
    for(const resource of declaration.resources){
      if(typeof resource!=='string')return [];
      if(!resource.startsWith('tls://'))continue;
      try{result.add(canonicalRedisTlsEndpoint(resource));}catch{return [];}
    }
  }
  return Object.freeze([...result].sort());
}
export const PACKAGED_REDIS_ENDPOINTS=declaredRedisEndpoints(manifest);
