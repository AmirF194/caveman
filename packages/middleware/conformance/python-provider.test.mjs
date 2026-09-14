import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './runtime-fixture.mjs';

test('installed Python provider SDKs preserve native APIs and execute scoped recovery', {timeout:180000}, async t => {
  const python=process.env.CAVEMAN_MIDDLEWARE_TEST_PYTHON;
  if(!python)throw new Error('Set CAVEMAN_MIDDLEWARE_TEST_PYTHON to the locked provider SDK environment');
  const runtime=await startRuntime();t.after(runtime.stop);
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const { beginPythonCertification } = await import('../../../examples/middleware/python-provider-sdks/certification-evidence.mjs');
  await beginPythonCertification(t, runtime.endpoint);
  for(const file of ['test_native.py','test_providers.py']){
    let result;
    try {
      result=await promisify(execFile)(python,[root+'examples/middleware/python-provider-sdks/'+file],{
        env:{...process.env,CAVEMAN_MIDDLEWARE_ENDPOINT:runtime.endpoint,PYTHONPATH:root+'packages/sdk/python:'+root+'packages/middleware/python'},timeout:120000,maxBuffer:8*1024*1024});
    } catch(error) {
      for(const line of ((error.stdout??'')+'\n'+(error.stderr??'')).split('\n'))if(line)t.diagnostic(line);
      throw error;
    }
    const {stdout,stderr}=result;
    for (const line of (stdout+'\n'+stderr).split('\n')) if (line) t.diagnostic(line);
    const nativeResults=stdout.split('\n').filter(line=>line.startsWith('CAVEMAN_MIDDLEWARE_TEST_RESULT ')).map(line=>JSON.parse(line.slice('CAVEMAN_MIDDLEWARE_TEST_RESULT '.length)));
    assert.ok(nativeResults.length >= (file==='test_native.py'?17:8), `Missing executed native/legacy results from ${file}`);
    for(const entry of nativeResults)await t.test(entry.name,()=>{
      assert.equal(entry.test_id,`examples/middleware/python-provider-sdks/${file}::${entry.name}`);
      assert.equal(entry.result,'passed');
    });
  }
});
