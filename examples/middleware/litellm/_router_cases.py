"""Native Router retries/fallbacks, using the public selected-deployment callback."""
import asyncio
import copy
import json
import re
from dataclasses import asdict
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import litellm
from litellm.integrations.custom_logger import CustomLogger
from caveman_cloud.middleware import MiddlewareError, Scope
from caveman_middleware.litellm import CavemanLiteLLM
from _certification_native import CapturedRuntime, NativeFixture, params, source_text, settled, record, digest
from _provider import SOURCE, FACT, definitions, history


def _attempt_evidence(test, cell, mode, runtime, server):
    # Retain the actual decisions separately from the replay invariants. A
    # deadline can preserve an original failed retry without changing the
    # successful compressed journey; its report must still describe its wire.
    print('CAVEMAN_MIDDLEWARE_ROUTER_ATTEMPTS ' + json.dumps({
        'cell_id': cell['id'], 'mode': mode,
        'reports': [asdict(report) for report in runtime.reports],
        'plans': [{'attempt_id': options['attempt_id'], 'logical_call_id': options['logical_call_id'],
                   'model': options['model'], 'candidates': [asdict(candidate) for candidate in options['candidates']],
                   'optimization': asdict(result)} for options, result in runtime.plans],
        'receipts': runtime.receipts,
        'provider_requests': [{key: call[key] for key in ('method', 'path', 'raw')} for call in server.calls],
    }, ensure_ascii=False), flush=True)
    if mode != 'off':
        ids = [options['attempt_id'] for options, _ in runtime.plans]
        reports = {report.attempt_id: report for report in runtime.reports}
        test.assertEqual(len(ids), len(set(ids)))
        test.assertEqual(len(ids), len(server.calls))
        test.assertEqual(len(reports), len(runtime.reports))
        test.assertEqual(set(reports), set(ids))
        for (options, result), call in zip(runtime.plans, server.calls):
            report = reports[options['attempt_id']]
            receipts = [receipt for receipt in runtime.receipts if receipt['attempt_id'] == report.attempt_id]
            test.assertEqual([receipt['event_kind'] for receipt in receipts],
                             ['dispatch_intent', 'failed' if call['body']['model'] == 'failure' else 'completed'])
            test.assertTrue(all(receipt['logical_call_id'] == options['logical_call_id'] for receipt in receipts))
            test.assertTrue(all(receipt['plan_id'] == (result.plan['replacement_set_id'] if result.plan else None) for receipt in receipts))
            test.assertEqual(report.logical_call_id, options['logical_call_id'])
            test.assertEqual(options['model']['id'], f"{cell['provider']}/{call['body']['model']}")
            test.assertEqual(report.reason, result.reason)
            test.assertEqual(report.replacement_count, len(result.replacements))
            test.assertEqual(report.reused_count, sum(bool(item.get('reused')) for item in result.replacements))
            test.assertEqual(report.transform_ids, tuple(sorted({item['transform_id'] for item in result.replacements})))
            candidates = options['candidates']
            test.assertIn(len(candidates), (0, 1))
            test.assertTrue(all(candidate.content == SOURCE for candidate in candidates))
            expected = SOURCE if candidates else None
            if result.replacements:
                test.assertEqual(result.status, 'optimized')
                test.assertEqual(len(result.replacements), 1)
                test.assertEqual(result.replacements[0]['segment_id'], candidates[0].id)
                test.assertEqual(report.status, 'reused' if report.reused_count else 'applied')
                expected = result.replacements[0]['text']
            else:
                test.assertEqual(report.status, 'skipped')
                if mode == 'compress' and candidates:
                    test.assertEqual(call['body']['model'], 'failure', 'Successful source calls must remain compressed')
                    test.assertEqual(result.reason, 'deadline', 'Only a deadline may bypass this failed retry')
            wire_protocol = 'anthropic-messages' if cell['provider'] == 'anthropic' else 'openai-chat'
            test.assertEqual(source_text(call['body'], wire_protocol), expected)
    return [digest(re.sub(r'cmw_[a-f0-9]{48}', 'cmw_OPAQUE_HANDLE', call['raw']))
            for call in server.calls if call['body']['model'] != 'failure']


async def router_case(test, cell, mode):
    provider, asynchronous = cell['provider'], cell['execution'] == 'async'
    wire_protocol = 'anthropic-messages' if provider == 'anthropic' else 'openai-chat'
    with NativeFixture(wire_protocol) as server, CapturedRuntime(mode) as runtime:
        scope = Scope('litellm-router-exact', digest(cell['id'] + mode))
        binding = runtime.recovery(scope)
        schema = {'type': 'function', 'function': {'name': binding.name, 'description': binding.description, 'parameters': dict(binding.input_schema)}}
        router = litellm.Router(model_list=[{'model_name': 'primary', 'litellm_params': params(server, provider) | {'model': f'{provider}/failure'}},
                                           {'model_name': 'backup', 'litellm_params': params(server, provider)}],
                               fallbacks=[{'primary': ['backup']}], num_retries=1, retry_after=0)
        messages, original_tool_outputs, recovery_outputs, native_types = [{'role': 'user', 'content': 'Read logs and return exact retained row 70.'}], [], [], []
        guarded = []
        class OriginalGuard(CustomLogger):
            async def async_pre_call_deployment_hook(self, kwargs, call_type):
                value = source_text(kwargs, 'openai-chat')
                if value is not None:
                    guarded.append(value)
                return kwargs
            def log_pre_api_call(self, model, messages, kwargs):
                body = kwargs.get('additional_args', {}).get('complete_input_dict', {})
                value = source_text(body, wire_protocol)
                if value is not None and not asynchronous:
                    guarded.append(value)
        guard = OriginalGuard(turn_off_message_logging=True)
        litellm.callbacks.append(guard)
        try:
            with CavemanLiteLLM(runtime=runtime, client=router, operator_recovery=lambda actual: (binding, json.dumps(schema)) if actual == scope else None) as bridge:
                method = bridge.acompletion if asynchronous else bridge.completion
                for step in range(5):
                    original = copy.deepcopy(messages)
                    options = {'model': 'primary', 'messages': messages, 'tools': definitions('openai-chat') + [schema]}
                    response = await method(scope=scope, **options) if asynchronous else await asyncio.to_thread(method, scope=scope, **options)
                    test.assertIsInstance(response, litellm.ModelResponse); native_types.append(type(response).__name__)
                    test.assertEqual(messages, original)
                    message = response.choices[0].message.model_dump(exclude_none=True)
                    messages.append(message)
                    calls = message.get('tool_calls') or []
                    if not calls:
                        answer = message.get('content'); break
                    for call in calls:
                        name, args = call['function']['name'], json.loads(call['function']['arguments'])
                        if name == 'read_logs':
                            test.assertEqual(args, {}); original_tool_outputs.append(SOURCE); value = SOURCE
                        else:
                            test.assertEqual(name, binding.name)
                            page = await asyncio.to_thread(binding.execute, args)
                            recovery_outputs.append(page); value = json.dumps(page, ensure_ascii=False)
                        messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': value})
                else:
                    test.fail('Application tool loop exceeded five native calls')
                test.assertEqual(answer, FACT); test.assertEqual(original_tool_outputs, [SOURCE])
                test.assertEqual(source_text({'messages': messages}, 'openai-chat'), SOURCE)
                # The first native Router call genuinely retries its primary
                # deployment before invoking the configured fallback.
                models = [call['body']['model'] for call in server.calls]
                test.assertEqual(models[:3], ['failure', 'failure', params(server, provider)['model'].split('/', 1)[1]])
                success_calls = [call for call in server.calls if call['body']['model'] != 'failure']
                test.assertEqual(len(success_calls), 3 if mode == 'compress' else 2)
                view = source_text(success_calls[1]['body'], wire_protocol)
                if mode == 'compress':
                    test.assertNotIn(FACT, view); test.assertIsNotNone(re.search(r'cmw_[a-f0-9]{48}', view))
                    test.assertEqual(len(recovery_outputs), 1)
                    test.assertEqual(recovery_outputs[0]['text'].encode(), SOURCE.encode()); test.assertTrue(recovery_outputs[0]['complete'])
                    selected = [options['model']['id'] for options, _ in runtime.plans]
                    test.assertEqual(selected, [f'{provider}/{model}' for model in models])
                    test.assertTrue(guarded); test.assertTrue(all(value == SOURCE for value in guarded))
                else:
                    test.assertEqual(view, SOURCE); test.assertEqual(recovery_outputs, [])
                await settled(test, runtime)
                successful_requests = _attempt_evidence(test, cell, mode, runtime, server)
                reports = len(native_types) if mode == 'off' else len(server.calls)
                observation = record(test, runtime, server, native_type='ModelResponse', value=answer, source_calls=1, report_calls=reports,
                                     extra={'native_api': 'Router.acompletion' if asynchronous else 'Router.completion', 'native_tool_loop_calls': len(native_types),
                                            'selected_models': models, 'native_retry_observed': True, 'native_fallback_observed': True,
                                            'view_sha256': digest(re.sub(r'cmw_[a-f0-9]{48}', 'cmw_OPAQUE_HANDLE', view)),
                                            'successful_request_sha256s': successful_requests,
                                            'recovered_sha256': digest(recovery_outputs[0]['text']) if recovery_outputs else None,
                                            'earlier_public_guard_saw_originals': True})
                # These exact values remain in the raw attempt diagnostics.
                # Replay compares the verified request/report relationship and
                # every successful request, allowing a failed retry's deadline.
                del observation['replacements']
                del observation['native_reports']['statuses']
                del observation['native_reports']['replacement_count']
                observation['native_reports']['plan_and_dispatch_consistency'] = 'disabled_public_calls' if mode == 'off' else 'verified_per_attempt'
                return observation
        finally:
            litellm.logging_callback_manager.remove_callback_from_all_lists(guard)
            litellm.logging_callback_manager.remove_callback_from_list_by_object(litellm.input_callback, guard, require_self=False)
            router.reset()


async def public_sync_guards(test):
    with NativeFixture('openai-chat') as server, CapturedRuntime('compress', strict=True) as runtime:
        router = litellm.Router(model_list=[{'model_name': 'selected', 'litellm_params': params(server, 'openai')}], num_retries=0)
        try:
            with CavemanLiteLLM(runtime=runtime, client=router) as bridge:
                with test.assertRaises(MiddlewareError) as error:
                    await asyncio.to_thread(bridge.completion, scope=Scope('strict', 'router'), model='selected', messages=history('openai-chat'))
                test.assertEqual(str(error.exception), 'Caveman middleware: unsupported_sync_router_strict')
                test.assertEqual(server.calls, []); test.assertEqual(runtime.plans, [])
        finally:
            router.reset()
    with NativeFixture('openai-chat') as server, CapturedRuntime('compress') as runtime:
        scope = Scope('router-isolation', 'owned'); binding = runtime.recovery(scope)
        tool = {'type': 'function', 'function': {'name': binding.name, 'description': binding.description, 'parameters': dict(binding.input_schema)}}
        router = litellm.Router(model_list=[{'model_name': 'selected', 'litellm_params': params(server, 'openai')}], num_retries=0)
        source = history('openai-chat'); before = copy.deepcopy(source)
        try:
            with CavemanLiteLLM(runtime=runtime, client=router, operator_recovery=lambda _: (binding, json.dumps(tool))) as bridge:
                owned, unrelated = await asyncio.gather(
                    asyncio.to_thread(bridge.completion, scope=scope, model='selected', messages=source, tools=definitions('openai-chat')+[tool]),
                    asyncio.to_thread(router.completion, model='selected', messages=source, tools=definitions('openai-chat')+[tool]))
                test.assertIsInstance(owned, litellm.ModelResponse); test.assertIsInstance(unrelated, litellm.ModelResponse)
                test.assertEqual(source, before); test.assertEqual(len(server.calls), 2); test.assertEqual(len(runtime.plans), 1)
                values = [source_text(call['body'], 'openai-chat') for call in server.calls]
                test.assertEqual(sum(value == SOURCE for value in values), 1)
                test.assertEqual(sum('cmw_' in value for value in values), 1)
                test.assertEqual(len(runtime.reports), 1)
        finally:
            router.reset()
