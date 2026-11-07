import test from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@netcatty/plugin-sdk';
import {createVaultHostsController, type SelectedVaultHost} from '../src/useVaultHosts';
const host: SelectedVaultHost = {target:{kind:'host.selection',scope:'metadata',handle:'opaque',revision:'one',expiresAt:10000},metadata:{label:'Test',hostname:'example.test',username:'test',port:22,group:'Tests',tags:[],protocol:'ssh'}};
function setup(vault: Partial<PluginContext['vault']> = {}) {
  const calls: unknown[] = [];
  const context = {enabledFeatures:new Set(['vault.host-actions']),vault:{selectHosts:async(params:unknown)=>{calls.push(params);return {cancelled:false,hosts:[host],groups:[]};},requestConnect:async(params:unknown)=>{calls.push(params);return {cancelled:false,status:'requested'};},...vault}} as unknown as PluginContext;
  return {calls,controller:createVaultHostsController(context,()=>1000)};
}
test('no calls until explicit selection, connect passes opaque reference/revision only and never claims connected',async()=>{
  const {calls,controller}=setup();assert.equal(calls.length,0);
  await controller.select('Choose');assert.equal(calls.length,1);
  await controller.connect(controller.getSnapshot().hosts[0]);
  assert.deepEqual(calls[1],{target:host.target,expectedRevision:'one'});
  assert.equal(controller.getSnapshot().notice,'requested');assert.equal('connected' in controller.getSnapshot(),false);
  controller.clear();assert.equal(controller.getSnapshot().hosts.length,0);
});
test('expired or unselected handles never connect',async()=>{
  const {calls,controller}=setup();await controller.connect(host);assert.equal(calls.length,0);
  await controller.select('Choose');await controller.connect({...host,target:{...host.target,expiresAt:500}});
  assert.equal(calls.length,1);assert.equal(controller.getSnapshot().notice,'expired');
  const expired = {...host,target:{...host.target,expiresAt:500}};
  let connected = false;
  const selectedExpired = setup({selectHosts:async()=>({cancelled:false,hosts:[expired],groups:[]}),requestConnect:async()=>{connected=true;return {cancelled:false,status:'requested'};}});
  await selectedExpired.controller.select('Choose');await selectedExpired.controller.connect(expired);
  assert.equal(connected,false);assert.equal(selectedExpired.controller.getSnapshot().notice,'expired');
});
test('cancel and revoke are recoverable only through a later explicit action, without retries',async()=>{
  let attempts=0;
  const {controller}=setup({selectHosts:async()=>{attempts++;return {cancelled:true};}});
  await controller.select('Choose');assert.equal(attempts,1);assert.equal(controller.getSnapshot().notice,'cancelled');
  const revoked=setup({requestConnect:async()=>{throw Error('permission revoked');}});
  await revoked.controller.select('Choose');await revoked.controller.connect(host);
  assert.equal(revoked.controller.getSnapshot().notice,'connect-failed');assert.equal(revoked.controller.getSnapshot().hosts.length,0);
  await revoked.controller.select('Choose');assert.equal(revoked.controller.getSnapshot().hosts.length,1);
});
test('pending selection serializes calls and invalidation discards late metadata',async()=>{
  let resolve!: (value:any)=>void;let calls=0;
  const {controller}=setup({selectHosts:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const pending=controller.select('Choose');await controller.select('Choose');assert.equal(calls,1);
  controller.invalidate();resolve({cancelled:false,hosts:[host],groups:[]});await pending;
  assert.equal(controller.getSnapshot().hosts.length,0);assert.equal(controller.getSnapshot().busy,false);
});
