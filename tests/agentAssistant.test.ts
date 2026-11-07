import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {PluginContext} from '@netcatty/plugin-sdk';
import {AgentAssistant} from '../src/AgentAssistant';
import {translator} from '../src/i18n';
test('Agent panel initial render never invokes host permissions, discovery or model',()=>{
 let calls=0;
 const agent=new Proxy({}, {get(){return ()=>{calls++;throw new Error('Unexpected host call');};}});
 const context={agent,enabledFeatures:new Set(['ai.agent-sessions'])} as unknown as PluginContext;
 const html=renderToStaticMarkup(React.createElement(AgentAssistant,{context,schema:null,sql:'SELECT 1',label:'Sample',disabled:false,insert:()=>assert.fail('Never execute or insert at mount'),t:translator('en')}));
 assert.equal(calls,0);assert.match(html,/Check Agent backends/);assert.match(html,/tools are disabled/);assert.match(html,/Conversation history is stored by the host/);
});
test('unsupported host exposes unavailability without calling APIs',()=>{
 const context={enabledFeatures:new Set(),agent:{}} as unknown as PluginContext;
 const html=renderToStaticMarkup(React.createElement(AgentAssistant,{context,schema:null,sql:'',label:'',disabled:false,insert:()=>{},t:translator('en')}));
 assert.match(html,/Agent unavailable on this host/);assert.match(html,/disabled=""/);
});
