import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const client=new Client({name:'hoswing-smoke',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],stderr:'pipe'});
try {
 await client.connect(transport);
 const {tools}=await client.listTools();assert.equal(tools.length,11);
 console.log('MCP handshake passed; tools:',tools.map(t=>t.name).join(', '));
 const state=await client.callTool({name:'hoswing_status',arguments:{}});
 assert(!state.isError);console.log('Browser status:',state.content[0].text);
 if(process.argv.includes('--open-login')){
  const open=await client.callTool({name:'hoswing_open_login',arguments:{}});
  assert(!open.isError);console.log('Login tab:',open.content[0].text);
 }
 const bad=await client.callTool({name:'hoswing_get_job',arguments:{jobId:'../invalid'}});
 assert.equal(bad.isError,true);console.log('Invalid job path correctly rejected.');
} finally {await client.close();}
