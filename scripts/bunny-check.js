'use strict';

// Fake Bunny Stream API: checks the AURA integration without touching an account.
if (process.env.AURA_BUNNY_TEST_SERVER === '1') {
  const records = new Map();
  let ready = false;
  process.on('message', message => { if (message === 'finish-encoding') ready = true; });
  global.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.origin !== 'https://video.bunnycdn.com' || options.headers.AccessKey !== 'fake-private-library-key') throw new Error('Unexpected Bunny API request');
    const thumbnail = /^\/library\/123\/videos\/([a-f0-9-]{36})\/thumbnail$/.exec(url.pathname);
    if (thumbnail) {
      const video = records.get(thumbnail[1]);
      if (!video) return new Response('',{status:404});
      if (options.method !== 'POST' || options.headers['Content-Type'] !== 'application/octet-stream') throw new Error('Unexpected Bunny thumbnail request');
      video.thumbnail = url.searchParams.get('thumbnailUrl') || Buffer.from(options.body);
      process.send?.(url.searchParams.has('thumbnailUrl') ? {type:'thumbnail-reset',value:url.searchParams.get('thumbnailUrl')} : {type:'thumbnail-upload',isBuffer:Buffer.isBuffer(options.body),size:Buffer.byteLength(options.body)});
      return Response.json({success:true,statusCode:200});
    }
    const match = /^\/library\/123\/videos(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
    if (!match) return new Response('',{status:404});
    if (options.method === 'POST' && !match[1]) {
      const guid = '12345678-1234-4123-8123-123456789abc';
      records.set(guid,{guid,storageSize:100,status:2});
      return Response.json({guid,title:JSON.parse(options.body).title});
    }
    const video = records.get(match[1]);
    if (!video) return new Response('',{status:404});
    if (options.method === 'GET') return Response.json({...video,status:ready?4:2});
    if (options.method === 'DELETE') {records.delete(match[1]);return new Response(null,{status:204});}
    throw new Error('Unexpected API method');
  };
  require('../server');
} else {
  const assert=require('node:assert/strict');
  const {fork}=require('node:child_process');
  const fs=require('node:fs/promises');
  const os=require('node:os');
  const path=require('node:path');
  const net=require('node:net');
  const http=require('node:http');
  const vm=require('node:vm');
  const {backup,verify}=require('./backup');
  async function checkBrowserUpload(){
    const source=await fs.readFile(path.resolve(__dirname,'../js/app.js'),'utf8');
    const start=source.indexOf('// The browser sends 8 MiB TUS chunks');
    const end=source.indexOf('\nasync function doUpload()',start);
    assert.ok(start>0&&end>start);
    const stored=new Map(), requests=[],nodes=new Map();
    const $=selector=>{if(!nodes.has(selector))nodes.set(selector,{style:{},textContent:''});return nodes.get(selector);};
    let offset=0;
    class XHR{
      constructor(){this.upload={};this.headers={};}
      open(method,url){this.method=method;this.url=url;}
      setRequestHeader(name,value){this.headers[name]=value;}
      getResponseHeader(name){return this.responseHeaders[name]||null;}
      send(body){
        requests.push(this);
        if(this.method==='POST')this.responseHeaders={Location:'/tusupload/upload-id'};
        else if(this.method==='PATCH'){offset+=body.size;this.responseHeaders={'Upload-Offset':String(offset)};this.upload.onprogress?.({loaded:body.size});}
        else throw new Error('Unexpected upload request');
        this.status=this.method==='POST'?201:204;this.onload();
      }
    }
    const apiCalls=[];
    const context=vm.createContext({XMLHttpRequest:XHR,TextEncoder,URL,btoa,$,Math,Number,Promise,Error,setTimeout,
      localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
      api:async(path)=>{apiCalls.push(path);return path.endsWith('/complete')?{}:{guid:'12345678-1234-4123-8123-123456789abc',libraryId:'123',signature:'f'.repeat(64),expires:1234567890};},
      uploadCancelRequested:false,activeUploadRequest:null});
    vm.runInContext(source.slice(start,end),context);
    const file={name:'example.mp4',type:'video/mp4',size:9*1024*1024,lastModified:1,slice:(from,to)=>({size:to-from})};
    await context.sendBunnyUpload(file,9,'AURA test');
    assert.deepEqual(requests.map(request=>request.method),['POST','PATCH','PATCH']);
    assert.ok(requests.every(request=>new URL(request.url,'https://video.bunnycdn.com').hostname==='video.bunnycdn.com'));
    assert.equal(requests[1].headers['Upload-Offset'],'0');
    assert.equal(requests[2].headers['Upload-Offset'],String(8*1024*1024));
    assert.equal(stored.size,0);
    assert.ok(apiCalls.at(-1).endsWith('/complete'));
  }
  async function main(){
    await checkBrowserUpload();
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aura-bunny-check-'));
    const socket=net.createServer();
    await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
    const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
    const adminHost='admin.aura.test', siteHost='aura.test';
    const child=fork(__filename,[],{cwd:path.resolve(__dirname,'..'),env:{...process.env,AURA_BUNNY_TEST_SERVER:'1',PORT:String(port),HOST:'127.0.0.1',ADMIN_HOST:adminHost,
      ADMIN_EMAIL:'owner@example.test',ADMIN_PASSWORD:'test-password-strong-2026',SESSION_SECRET:'very-long-secret-for-bunny-integration-check',
      DATA_DIR:path.join(dir,'data'),VIDEO_DIR:path.join(dir,'videos'),BUNNY_LIBRARY_ID:'123',BUNNY_STREAM_API_KEY:'fake-private-library-key',BUNNY_TOKEN_KEY:'fake-private-token-key',BUNNY_PULL_ZONE:'test.b-cdn.net'},
      stdio:['ignore','ignore','pipe','ipc']});
    let logs='';child.stderr.on('data',chunk=>logs+=chunk);
    const bunnyObservations=[];child.on('message',message=>{if(message?.type?.startsWith('thumbnail-'))bunnyObservations.push(message);});
    async function call(url,{host=adminHost,cookie,method='GET',json,bytes,mime='application/octet-stream'}={}){
      const body=json===undefined?(bytes || null):Buffer.from(JSON.stringify(json));
      return new Promise((resolve,reject)=>{
        const headers={Host:`${host}:${port}`};
        if(cookie)headers.Cookie=cookie;
        if(body){headers['Content-Type']=json===undefined?mime:'application/json';headers['Content-Length']=body.length;}
        if(['POST','PUT','PATCH','DELETE'].includes(method))headers.Origin=`http://${host}:${port}`;
        const request=http.request({host:'127.0.0.1',port,path:url,method,headers},response=>{
          const chunks=[];response.on('data',chunk=>chunks.push(chunk));
          response.on('end',()=>{const bytes=Buffer.concat(chunks),raw=bytes.toString();resolve({status:response.statusCode,headers:response.headers,data:response.headers['content-type']?.includes('application/json')?JSON.parse(raw):raw,raw:bytes});});
        });
        request.on('error',reject);request.end(body);
      });
    }
    try{
      let started=false;
      for(let i=0;i<80;i++){
        if(child.exitCode!==null)throw new Error(`Server stopped: ${logs}`);
        try{if((await call('/api/health')).status===200){started=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!started)throw new Error(`Server unavailable: ${logs}`);
      assert.equal((await call('/api/admin/videos/1/bunny-upload',{method:'POST',json:{size:100,mime:'video/mp4'}})).status,401);
      const login=await call('/api/admin/login',{method:'POST',json:{email:'owner@example.test',password:'test-password-strong-2026'}});
      assert.equal(login.status,200,JSON.stringify(login.data));
      const cookie=login.headers['set-cookie'][0].split(';')[0];
      const auth={cookie};
      const draft=await call('/api/admin/videos',{...auth,method:'POST',json:{title:'Bunny test',category:'Cinematic',duration:10}});
      assert.equal(draft.status,201,JSON.stringify(draft.data));
      const id=draft.data.item.id;
      assert.equal((await call(`/api/admin/videos/${id}/bunny-upload`,{...auth,method:'POST',json:{size:0,mime:'video/mp4'}})).status,400);
      const start=await call(`/api/admin/videos/${id}/bunny-upload`,{...auth,method:'POST',json:{size:100,mime:'video/mp4'}});
      assert.equal(start.status,200,JSON.stringify(start.data));
      assert.match(start.data.signature,/^[a-f0-9]{64}$/);
      assert.equal((await call(`/api/admin/videos/${id}/bunny-upload`,{...auth,method:'POST',json:{size:100,mime:'video/mp4'}})).data.guid,start.data.guid);
      assert.equal((await call(`/api/videos/${id}/embed`,{host:siteHost})).status,404);
      const completed=await call(`/api/admin/videos/${id}/bunny-upload/complete`,{...auth,method:'POST',json:{}});
      assert.equal(completed.status,200,JSON.stringify(completed.data));
      assert.equal(completed.data.item.bunny,true);
      assert.equal((await call(`/api/admin/videos/${id}/file`,auth)).status,404);
      assert.equal((await call(`/api/admin/videos/${id}/publish`,{...auth,method:'PATCH',json:{published:true}})).status,409);
      const preview=await call(`/api/admin/videos/${id}/embed`,auth);
      assert.equal(preview.status,200);
      assert.match(preview.data.url,/token=[a-f0-9]{64}&expires=/);
      assert.equal((await call(`/api/admin/videos/${id}/embed`,{host:siteHost})).status,404);
      child.send('finish-encoding');
      let published;
      for(let i=0;i<10;i++){
        published=await call(`/api/admin/videos/${id}/publish`,{...auth,method:'PATCH',json:{published:true}});
        if(published.status===200)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(published.status,200,JSON.stringify(published.data));
      const publicEmbed=await call(`/api/videos/${id}/embed`,{host:siteHost});
      assert.equal(publicEmbed.status,200);
      const catalog=(await call('/api/catalog',{host:siteHost})).data;
      assert.equal(catalog.videos[0].bunny,true);
      const thumbnailBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
      const custom=await call(`/api/admin/videos/${id}/thumbnail`,{...auth,method:'PUT',bytes:thumbnailBytes,mime:'image/png'});
      assert.equal(custom.status,200,JSON.stringify(custom.data));
      assert.ok(custom.data.item.thumbnail);
      assert.deepEqual(bunnyObservations.at(-1),{type:'thumbnail-upload',isBuffer:true,size:thumbnailBytes.length},'AURA sends raw thumbnail bytes to Bunny on the server');
      const adminThumbnail=await call(custom.data.item.thumbnail,auth);
      assert.equal(adminThumbnail.status,200); assert.equal(adminThumbnail.headers['content-type'],'image/png');
      const publicCatalog=(await call('/api/catalog',{host:siteHost})).data;
      assert.match(publicCatalog.videos[0].thumbnail,/^\/api\/videos\//);
      assert.equal((await call(publicCatalog.videos[0].thumbnail,{host:siteHost})).status,200);
      const reset=await call(`/api/admin/videos/${id}/thumbnail`,{...auth,method:'DELETE'});
      assert.equal(reset.status,200,JSON.stringify(reset.data));
      assert.equal(reset.data.item.thumbnail,null);
      assert.deepEqual(bunnyObservations.at(-1),{type:'thumbnail-reset',value:'thumbnail_1.jpg'},'Reset asks Bunny to restore its generated thumbnail');
      const directory=path.join(dir,'backup');
      await backup({dataDir:path.join(dir,'data'),videoDir:path.join(dir,'videos'),destination:directory});
      await verify(directory);
      assert.equal((await call(`/api/admin/videos/${id}`,{...auth,method:'DELETE'})).status,200);
      assert.equal((await call(`/api/videos/${id}/embed`,{host:siteHost})).status,404);
      console.log('Bunny checks passed: admin-only signed upload, draft isolation, processing gate, embed tokens, custom thumbnail upload/reset, deletion, and metadata backup.');
    }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});}
  }
  main().catch(error=>{console.error(error);process.exitCode=1;});
}
