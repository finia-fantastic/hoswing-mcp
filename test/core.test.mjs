import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.HOSWING_DATA_DIR=path.resolve(new URL('../test-output', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),randomUUID());
const {normalizeRows,safeName,id,reserve,loadStoryboard,quoteCredits,buildNode,readJob,saveJob,lockJob,ROOT}=await import('../src/core.mjs');
const {Pipeline}=await import('../src/pipeline.mjs');

test('中文分镜字段、路径和时长解析',()=>{
 const [s]=normalizeRows([{'镜号':'01','画面描述':'雨中的街道','时长':'6秒','参考素材':'a.png；b.jpg'}],{baseDir:'I:/assets'});
 assert.equal(s.durationSeconds,6);assert.equal(s.references.length,2);assert.equal(s.prompt,'雨中的街道');
});
test('镜号重复、空提示词及错误时长拒绝',()=>{
 assert.throws(()=>normalizeRows([{id:1,prompt:'a'},{id:1,prompt:'b'}]),/DUPLICATE/);
 assert.throws(()=>normalizeRows([{prompt:' '}]),/PROMPT/);
 assert.throws(()=>normalizeRows([{prompt:'a',duration:'NaN'}]),/DURATION/);
});
test('标识和 Windows 文件名防路径穿越',()=>{
 assert.throws(()=>id('../x'),/INVALID/);assert.throws(()=>id('x/y'),/INVALID/);
 assert(!safeName('../CON:a').includes('/'));assert.match(safeName('CON'),/^asset_/);
});
test('拒绝不确定或负数报价，预算预留不超限',()=>{
 assert.throws(()=>quoteCredits({}),/INVALID/);assert.throws(()=>quoteCredits({quotedCredits:-1}),/INVALID/);
 const j={reservedCredits:5,approvedMaxCredits:10};reserve(j,5);assert.equal(j.reservedCredits,10);
 assert.throws(()=>reserve(j,1),/BUDGET/);assert.equal(j.reservedCredits,10);
});
test('视频节点带参考图、首帧和稳定 ID',()=>{
 const j={id:'job-abcdefghijkl',projectId:'project',mode:'video',provider:'p',modelId:'m',operation:'video.generate',parameters:{resolution:'720p'},origin:{x:500,y:0}};
 const s={title:'镜头',prompt:'测试',references:['a.png'],referenceAssetVersionIds:[],firstFrame:'a.png',durationSeconds:5,aspectRatio:'16:9'};
 const n=buildNode(j,s,0,{'a.png':{assetVersionId:'asset-1',kind:'IMAGE'}});
 assert.equal(n.data.firstFrameAssetVersionId,'asset-1');assert.deepEqual(n.data.referenceAssetVersionIds,['asset-1']);assert.equal(n.data.modelParameters.durationSeconds,5);
});
test('CSV 支持引号内逗号和中文',async()=>{
 await fs.mkdir(ROOT,{recursive:true});const file=path.join(ROOT,'story.csv');await fs.writeFile(file,'镜号,画面描述,时长\n01,"a,b",5\n');
 const rows=await loadStoryboard(file,'video');assert.equal(rows[0].prompt,'a,b');
});
test('任务锁拒绝并发',async()=>{
 await lockJob('lock-test',async()=>{await assert.rejects(()=>lockJob('lock-test',async()=>{}),/LOCKED/);});
});

class FakeApi {
 constructor({uncertain=false,failed=false,quote=2}={}){this.posts=0;this.uncertain=uncertain;this.failed=failed;this.quote=quote;this.node=null;this.downloads=0;}
 async selectPage(){}
 async request(route,options={}){
  if(route.endsWith('/auth/me'))return {id:'account'};
  if(route.includes('/providers/models'))return {items:[{provider:'p',modelId:'m',operation:'video.generate',enabled:true,mock:false}]};
  if(route.endsWith('/providers/quote'))return {quotedCredits:this.quote};
  if(route.endsWith('/canvas')){
   this.canvas??={revision:1,nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}};
   if(options.method==='PATCH')this.canvas={...structuredClone(options.body),revision:this.canvas.revision+1};
   return structuredClone(this.canvas);
  }
  if(route.endsWith('/node-executions')&&options.method==='POST'){
   this.posts++;this.node=options.body.node;
   if(this.uncertain)throw Error('network timeout');
   return this.result('queued');
  }
  if(route.includes('/node-execution-acceptance'))return this.result('queued');
  if(route.includes('/node-executions/'))return this.result(this.failed?'failed':'succeeded');
  throw Error('UNEXPECTED_ROUTE: '+route);
 }
 result(status){return {projectId:'project',nodeId:this.node.id,jobId:'remote-job',status,assetVersionIds:status==='succeeded'?['result-1']:[]};}
 async upload(){throw Error('No upload expected');}
 async download(assetVersionId,dir){this.downloads++;return {path:path.join(dir,'result.mp4'),bytes:10,sha256:'abc',assetVersionId};}
}
async function setup(api){
 const p=new Pipeline(api);const draft=await p.create({projectId:'project',shots:[{prompt:'test'}],mode:'video',provider:'p',modelId:'m'});
 await p.quote(draft.id);await p.prepareStart(draft.id,10);return {p,jobId:draft.id};
}
test('完整模拟：报价、提交、查询、下载和清单',async()=>{
 const api=new FakeApi();const {p,jobId}=await setup(api);const result=await p.run(jobId,{pollMs:1});
 assert.equal(result.status,'completed');assert.equal(api.posts,1);assert.equal(api.downloads,1);
 const saved=await readJob(jobId);assert.equal(saved.reservedCredits,2);assert.equal(saved.shots[0].status,'downloaded');
 assert.equal(JSON.parse(await fs.readFile(path.join(saved.outputDir,'manifest.json'),'utf8')).shots.length,1);
});
test('受理超时后恢复原任务，绝不二次 POST',async()=>{
 const api=new FakeApi({uncertain:true});const {p,jobId}=await setup(api);
 assert.equal((await p.run(jobId,{pollMs:1})).status,'paused');assert.equal(api.posts,1);
 await p.prepareStart(jobId,10);
 assert.equal((await p.run(jobId,{pollMs:1})).status,'completed');assert.equal(api.posts,1);
 assert.equal((await readJob(jobId)).reservedCredits,2);
});
test('原任务受理查询失败时暂停，不重新提交',async()=>{
 const api=new FakeApi({uncertain:true});const {p,jobId}=await setup(api);await p.run(jobId,{pollMs:1});
 const request=api.request.bind(api);api.request=async(route,options)=>{if(route.includes('acceptance'))throw Error('HTTP_404');return request(route,options);};
 await p.prepareStart(jobId,10);assert.equal((await p.run(jobId,{pollMs:1})).status,'paused');assert.equal(api.posts,1);
});
test('报价涨过上限时不提交',async()=>{
 const api=new FakeApi();const {p,jobId}=await setup(api);api.quote=11;
 const result=await p.run(jobId,{pollMs:1});assert.equal(result.status,'paused');assert.equal(api.posts,0);assert.match(result.error,/BUDGET/);
});
test('服务器失败停止后续镜头',async()=>{
 const api=new FakeApi({failed:true});const {p,jobId}=await setup(api);assert.equal((await p.run(jobId,{pollMs:1})).status,'failed');assert.equal(api.downloads,0);
 await assert.rejects(()=>p.prepareStart(jobId,10),/TERMINAL/);
});
test('保存画布发生版本冲突时不提交生成',async()=>{
 const api=new FakeApi();const {p,jobId}=await setup(api);const request=api.request.bind(api);
 api.request=async(route,options={})=>{if(route.endsWith('/canvas')&&options.method==='PATCH')throw Error('CANVAS_REVISION_CONFLICT');return request(route,options);};
 const result=await p.run(jobId,{pollMs:1});assert.equal(result.status,'paused');assert.equal(api.posts,0);assert.equal((await readJob(jobId)).reservedCredits,0);
});
test('保存画布回执丢失时读回原节点，不复制节点',async()=>{
 const api=new FakeApi();const {p,jobId}=await setup(api);const request=api.request.bind(api);let patches=0;
 api.request=async(route,options={})=>{const result=await request(route,options);if(route.endsWith('/canvas')&&options.method==='PATCH'){patches++;throw Error('transport interrupted');}return result;};
 assert.equal((await p.run(jobId,{pollMs:1})).status,'completed');assert.equal(patches,1);assert.equal(api.canvas.nodes.length,1);
});
test('未授权或账户变化时不提交',async()=>{
 const api=new FakeApi();const {p,jobId}=await setup(api);const j=await readJob(jobId);j.accountId='different';await saveJob(j);
 assert.match((await p.run(jobId,{pollMs:1})).error,/ACCOUNT_CHANGED/);assert.equal(api.posts,0);
});

test('画布读回的键顺序变化不算节点被改过', async () => {
  const { stable } = await import('../src/pipeline.mjs')
  const written = { aspectRatio: '16:9', count: 1 }
  const readBack = { count: 1, aspectRatio: '16:9' }
  assert.equal(stable(written), stable(readBack))
  // 真正的值变化必须仍然被发现
  assert.notEqual(stable(written), stable({ count: 2, aspectRatio: '16:9' }))
  assert.notEqual(stable({ a: [1, 2] }), stable({ a: [2, 1] }))
})

test('参考视频要放进 videoReferenceAssetVersionIds，不能混进图片参考', async () => {
  const { buildNode } = await import('../src/core.mjs')
  const job = { id:'job-test-123456789012', projectId:'p1', mode:'video', provider:'relay-x',
    modelId:'doubao-seedance-2-5-260628', operation:'video.generate', parameters:{}, origin:{x:0,y:0} }
  const shot = { id:'S1', title:'t', prompt:'换人', aspectRatio:'9:16', durationSeconds:5,
    references:['/a/vid.mp4','/a/img.jpg'], referenceAssetVersionIds:[], firstFrame:undefined, lastFrame:undefined }
  const assets = { '/a/vid.mp4':{assetVersionId:'vid-1',kind:'VIDEO'},
                   '/a/img.jpg':{assetVersionId:'img-1',kind:'IMAGE'} }
  const node = buildNode(job, shot, 0, assets)
  const d = node.data
  assert.deepEqual(d.videoReferenceAssetVersionIds, ['vid-1'])
  assert.deepEqual(d.referenceAssetVersionIds, ['img-1'])
  assert.equal(d.referenceMediaKinds['vid-1'], 'video')
})
