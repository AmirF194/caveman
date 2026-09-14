import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startRuntime } from './runtime-fixture.mjs';

const family=process.env.CAVEMAN_MIDDLEWARE_TEST_FAMILY;
const certificationMinimums={google:12,langchain:13,'pydantic-ai':21,'llama-index':23,crewai:19,litellm:8,agno:13,strands:3,autogen:8,asgi:6,mcp:9};
test(`installed Python ${family??'framework'} native conformance`, {timeout:family==='litellm'?180000:90000}, async t => {
  const python=process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
  if(!python||!family||!/^[a-z-]+$/.test(family))throw new Error('Set exact CAVEMAN_MIDDLEWARE_TEST_PYTHON and CAVEMAN_MIDDLEWARE_TEST_FAMILY');
  const runtime=await startRuntime();t.after(runtime.stop);
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const hasCertification=existsSync(`${root}examples/middleware/${family}/certification-evidence.mjs`);
  if(process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY&&!hasCertification)throw new Error(`Missing exact native certification helper for ${family}`);
  if(hasCertification){
    const {beginPythonCertification}=await import(`../../../examples/middleware/${family}/certification-evidence.mjs`);
    await beginPythonCertification(t,runtime.endpoint);
  }
  let stdout='',stderr='',pending='',control=Promise.resolve();
  const child=spawn(python,[`${root}examples/middleware/${family}/test_native.py`],{
    env:{...process.env,CAVEMAN_MIDDLEWARE_ENDPOINT:runtime.endpoint,
      PYTHONPATH:['packages/sdk/python','packages/middleware/python','packages/middleware/conformance','examples/middleware/python-provider-sdks'].map(p=>root+p).join(delimiter)},
    stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  child.stdout.on('data',chunk=>{
    stdout+=chunk;pending+=chunk;
    while(pending.includes('\n')){
      const i=pending.indexOf('\n'),line=pending.slice(0,i);pending=pending.slice(i+1);
      try{if(JSON.parse(line).caveman_control==='restart')control=control.then(async()=>{await runtime.restart();child.stdin.write('runtime-ready\n');});}catch{/* ordinary test output */}
    }
  });
  child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  await control;
  if(code!==0)throw new Error(`${family} native tests exited ${code}\n${stderr}\n${stdout}`);
  for (const line of (stderr+'\n'+stdout).split('\n')) if (line) t.diagnostic(line);
  if(hasCertification){
    const results=stdout.split('\n').filter(line=>line.startsWith('CAVEMAN_MIDDLEWARE_TEST_RESULT ')).map(line=>JSON.parse(line.slice('CAVEMAN_MIDDLEWARE_TEST_RESULT '.length)));
    const minimum=family==='langchain'&&['F05','F06'].includes(process.env.CAVEMAN_MIDDLEWARE_CERT_FAMILY)?11:(certificationMinimums[family]??1);
    assert.ok(results.length>=minimum,`Missing executed ${family} native test results`);
    assert.equal(new Set(results.map(result=>result.name)).size,results.length,'Duplicate executed native test names');
    for(const result of results)await t.test(result.name,()=>{
      assert.equal(result.test_id,`examples/middleware/${family}/test_native.py::${result.name}`);
      assert.equal(result.result,'passed');
    });
  }
});
