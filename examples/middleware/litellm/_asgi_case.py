"""Real user ASGI middleware owns the request above native LiteLLM."""
import re
from composition_test import Provider, NativeApplication, SOURCE, FACT, tool_text, digest
from caveman_cloud.middleware import Scope
from caveman_middleware.litellm import CavemanLiteLLM
from _certification_native import CapturedRuntime, settled, record


async def asgi_case(test, cell, mode):
    provider = cell['provider']
    with Provider(provider) as server, CapturedRuntime(mode) as sync:
        runtime = sync.as_async()
        with CavemanLiteLLM(runtime=runtime) as bridge:
            scope = Scope('asgi-litellm-exact', digest(cell['id']+mode))
            host = NativeApplication(provider, server, runtime, bridge, scope)
            answer, incoming = await host.run_loop(host.with_middleware())
            test.assertEqual(answer, FACT)
            test.assertEqual(tool_text({'messages': incoming}, provider, 'read-1'), SOURCE)
            test.assertEqual(host.executions, ['read_logs','caveman_retrieve'] if mode=='compress' else ['read_logs'])
            expected = 3 if mode=='compress' else 2
            test.assertEqual(len(server.calls), expected); test.assertEqual(len(host.native_calls), expected)
            view = tool_text(server.calls[1]['body'], provider, 'read-1')
            if mode == 'compress':
                test.assertNotIn(FACT, view); test.assertIsNotNone(re.search(r'cmw_[a-f0-9]{48}', view))
                test.assertEqual(host.recovered[0]['text'].encode(), SOURCE.encode()); test.assertTrue(host.recovered[0]['complete'])
                test.assertTrue(all(options['adapter'].id=='asgi' for options,_ in sync.plans))
                test.assertTrue(all(request['owner'] is not None for request in host.native_calls))
            else:
                test.assertEqual(view,SOURCE); test.assertEqual(host.recovered,[])
            guarded_models = [body for body in host.guarded_bodies if 'messages' in body]
            test.assertEqual(len(guarded_models), expected)
            test.assertTrue(all(tool_text(body,provider,'read-1') in (None,SOURCE) for body in guarded_models))
            test.assertEqual(len(host.guarded_bodies), expected + len(host.executions))
            await settled(test,sync)
            observation = record(test,sync,server,native_type='Native ASGI app and LiteLLM '+host.native_types[-1],value=answer,source_calls=1,report_calls=len(host.guarded_bodies),allow_unscoped_reports=True,
                          extra={'native_api':'bridge.acompletion' if provider=='openai' else 'litellm.anthropic_messages',
                                 'optimizer_owner':'asgi','single_owner_reports':True,'source_sha256':digest(SOURCE),'source_utf8_bytes':len(SOURCE.encode()),
                                 'view_sha256':digest(re.sub(r'cmw_[a-f0-9]{48}','cmw_OPAQUE_HANDLE',view)),
                                 'recovered_sha256':digest(host.recovered[0]['text']) if host.recovered else None,
                                 'authentication_before_original_guard':True,'original_guard_before_projection':True})
            observation['native_reports']['scope'] = 'asgi_http_request_including_tool_routes'
            return observation
