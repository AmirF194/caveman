"""Actual native calls retain passive behavior and isolate logger registrations."""
import asyncio
import copy
from unittest.mock import patch

import litellm
from caveman_cloud.middleware import MiddlewareError, Scope
from caveman_middleware.litellm import CavemanLiteLLM
from _provider import SOURCE, FACT, history
from _certification_native import CapturedRuntime, NativeFixture, params, settled


async def passive_cases(test):
    class OpaqueHistory(list):
        pass
    def rejected_report(report):
        raise RuntimeError('diagnostic callback cannot replace native outcome')
    for mode in ('off', 'unsupported', 'opaque'):
        with NativeFixture('openai-chat') as server, CapturedRuntime('off' if mode=='off' else 'compress', report_callback=rejected_report) as runtime:
            source = OpaqueHistory(history('openai-chat')) if mode=='opaque' else history('openai-chat')
            before = copy.deepcopy(source)
            native = await litellm.acompletion(**params(server,'openai',messages=source))
            baseline = server.calls[-1]['body']
            test.assertEqual(native.choices[0].message.content,FACT)
            error_options = params(server, 'openai', messages=source) | {'model': 'openai/fixture-native-error', 'num_retries': 0}
            with test.assertRaises(litellm.BadRequestError) as native_error:
                await litellm.acompletion(**error_options)
            error_baseline = server.calls[-1]['body']
            previous = list(litellm.callbacks)
            with patch('caveman_middleware.litellm.matches_framework',return_value=mode!='unsupported'):
                bridge = CavemanLiteLLM(runtime=runtime)
            with bridge:
                if mode!='opaque':
                    test.assertEqual(litellm.callbacks,previous)
                for method in ('completion','acompletion'):
                    function = getattr(bridge,method)
                    result = await function(scope=Scope('passive',mode+method),**params(server,'openai',messages=source)) if method.startswith('a') else await asyncio.to_thread(function,scope=Scope('passive',mode+method),**params(server,'openai',messages=source))
                    test.assertIsInstance(result,litellm.ModelResponse);test.assertEqual(result.choices[0].message.content,FACT)
                    test.assertEqual(server.calls[-1]['body'],baseline);test.assertEqual(source,before)
                with test.assertRaises(type(native_error.exception)) as wrapped_error:
                    await bridge.acompletion(scope=Scope('passive',mode+'error'), **error_options)
                test.assertIn('deterministic native input error', str(wrapped_error.exception))
                test.assertEqual(server.calls[-1]['body'], error_baseline); test.assertEqual(source, before)
                test.assertEqual(runtime.plans,[]);test.assertEqual(runtime.receipts,[])
                test.assertEqual(len(runtime.reports),3)
                test.assertEqual([report.status for report in runtime.reports],['disabled']*3 if mode=='off' else ['skipped']*3)
                test.assertTrue(all(report.reason==('disabled' if mode=='off' else 'unsupported_version' if mode=='unsupported' else 'unsupported_shape') for report in runtime.reports),str([(mode,report.status,report.reason) for report in runtime.reports]))
                test.assertNotIn(SOURCE,str(runtime.reports))
            for callback in previous:
                test.assertIn(callback, litellm.callbacks)
            test.assertNotIn(bridge, litellm.callbacks)
            test.assertNotIn(bridge,litellm.input_callback)
            test.assertNotIn(bridge,litellm.logging_callback_manager.get_custom_loggers_for_type(CavemanLiteLLM))
    with CapturedRuntime('compress',strict=True) as runtime,patch('caveman_middleware.litellm.matches_framework',return_value=False):
        with test.assertRaises(MiddlewareError) as error:
            CavemanLiteLLM(runtime=runtime)
        test.assertEqual(str(error.exception),'Caveman middleware: unsupported_version')
        test.assertEqual(runtime.plans,[]);test.assertEqual(runtime.receipts,[])
    with NativeFixture('openai-chat') as first,NativeFixture('openai-chat') as second,CapturedRuntime('compress') as one,CapturedRuntime('compress') as two:
        with CavemanLiteLLM(runtime=one) as a,CavemanLiteLLM(runtime=two) as b:
            result = await asyncio.gather(a.acompletion(scope=Scope('active','one'),**params(first,'openai',messages=history('openai-chat'))),b.acompletion(scope=Scope('active','two'),**params(second,'openai',messages=history('openai-chat'))))
            test.assertEqual([r.choices[0].message.content for r in result],[FACT,FACT])
            await settled(test,one);await settled(test,two)
            test.assertEqual(len(one.plans),1);test.assertEqual(len(two.plans),1)
            test.assertEqual(len(one.reports),1);test.assertEqual(len(two.reports),1)
            test.assertNotEqual(a.registration_id,b.registration_id)
            test.assertEqual({r['scope']['session_id'] for r in one.receipts},{'one'})
            test.assertEqual({r['scope']['session_id'] for r in two.receipts},{'two'})
        test.assertNotIn(a,litellm.input_callback);test.assertNotIn(b,litellm.input_callback)
        test.assertNotIn(a,litellm.logging_callback_manager.get_custom_loggers_for_type(CavemanLiteLLM))
        test.assertNotIn(b,litellm.logging_callback_manager.get_custom_loggers_for_type(CavemanLiteLLM))
