// All inference stays on deterministic loopback fixtures. See README.md.
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createMiddlewareRuntime } from '../../../packages/sdk/typescript/dist/middleware/index.js';
import { withCavemanOpenAI, withCavemanOpenAITools } from '../../../packages/middleware/typescript/dist/openai.js';
import { withCavemanAnthropic } from '../../../packages/middleware/typescript/dist/anthropic.js';
import { startRuntime } from '../../../packages/middleware/conformance/runtime-fixture.mjs';
import { SOURCE, FACT, api, args, definitions, providerFixture, scope, textOf } from './native-fixture.mjs';

const service=await startRuntime();
const runtime=createMiddlewareRuntime({endpoint:service.endpoint,deadlineMs:1000});
const providers=[];
try {
  await runtime.ready();
  for(const protocol of ['openai-chat','openai-responses']){
    const provider=await providerFixture(protocol);providers.push(provider);
    const existingClient=new OpenAI({apiKey:'local-fixture',baseURL:provider.url+'/v1',maxRetries:0});
    const options={runtime,scope:scope('example-'+protocol),fetch};

    // The original application performs its auth/content guards before this call.
    // The return value is still the official client, including its raw helpers.
    const client=withCavemanOpenAI(existingClient,options);
    const {data,response}=await api(client,protocol).create(args(protocol)).withResponse();
    assert.equal(textOf(data,protocol),'native');assert.equal(response.status,200);

    // The application owns scheduling and dispatch; Caveman supplies one function.
    const loop=withCavemanOpenAITools(existingClient,{...options,protocol,tools:definitions(protocol),functions:{read_logs:async()=>SOURCE}});
    const messages=[{role:'user',content:'Read source and recover row 70'}];
    let final;
    for(let step=0;step<5;step++){
      const result=await api(loop.client,protocol).create({...args(protocol,'loop',messages),tools:loop.tools});
      const calls=protocol==='openai-chat'?(result.choices[0].message.tool_calls??[]).map(call=>({id:call.id,name:call.function.name,arguments:call.function.arguments})):
        result.output.filter(item=>item.type==='function_call').map(call=>({id:call.call_id,name:call.name,arguments:call.arguments}));
      if(!calls.length){final=textOf(result,protocol);break;}
      messages.push(...(protocol==='openai-chat'?[result.choices[0].message]:result.output));
      for(const call of calls){
        const result=await loop.functions[call.name](JSON.parse(call.arguments));
        const text=typeof result==='string'?result:JSON.stringify(result);
        messages.push(protocol==='openai-chat'?{role:'tool',tool_call_id:call.id,content:text}:{type:'function_call_output',call_id:call.id,output:text});
      }
    }
    assert.equal(final,FACT);assert.deepEqual(provider.errors,[]);
    console.log(JSON.stringify({protocol,modelOnlyNativeResult:data.object,applicationLoopFinal:final}));
  }

  const provider=await providerFixture('anthropic-messages');providers.push(provider);
  const existingClient=new Anthropic({apiKey:'local-fixture',baseURL:provider.url,maxRetries:0});
  const client=withCavemanAnthropic(existingClient,{runtime,scope:scope('example-anthropic'),fetch});
  const {data}=await client.messages.create(args('anthropic-messages')).withResponse();
  assert.equal(data.content[0].text,'native');
  const runner=client.beta.messages.toolRunner({model:'loop',max_tokens:100,max_iterations:5,messages:[{role:'user',content:'Read source and recover row 70'}],
    tools:[{...definitions('anthropic-messages')[0],parse:input=>input,run:async()=>SOURCE}]});
  const final=await runner;
  assert.equal(final.content[0].text,FACT);assert.deepEqual(provider.errors,[]);
  console.log(JSON.stringify({protocol:'anthropic-messages',modelOnlyNativeResult:data.type,nativeRunnerFinal:final.content[0].text}));
} finally {
  for(const provider of providers)await provider.close();
  runtime.close();await service.stop();
}
