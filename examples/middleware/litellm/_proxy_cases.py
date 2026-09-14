"""Actual LiteLLM FastAPI proxy endpoints and application-owned recovery tools."""
import asyncio
import copy
import json
import re
from contextlib import contextmanager

import litellm
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy import proxy_server
from litellm.proxy._types import UserAPIKeyAuth
from caveman_cloud.middleware import Scope
from caveman_middleware.litellm import CavemanLiteLLM
from _provider import SOURCE, FACT, definitions, history
from _certification_native import CapturedRuntime, NativeFixture, params, source_text, settled, record, digest
from composition_test import invoke

MASTER_KEY = 'sk-caveman-local-proxy-fixture'


@contextmanager
def configured_proxy(server, provider):
    names = ('master_key', 'llm_router', 'llm_model_list', 'general_settings')
    previous = {name: getattr(proxy_server, name) for name in names}
    models = [{'model_name': 'selected', 'litellm_params': params(server, provider)}]
    router = litellm.Router(model_list=models, num_retries=0)
    proxy_server.master_key = MASTER_KEY
    proxy_server.llm_router = router
    proxy_server.llm_model_list = models
    proxy_server.general_settings = {}
    try:
        yield proxy_server.app
    finally:
        router.reset()
        for name, value in previous.items():
            setattr(proxy_server, name, value)


def parsed_events(sent):
    status = next(event['status'] for event in sent if event['type'] == 'http.response.start')
    body = b''.join(event.get('body', b'') for event in sent)
    return status, body


def streamed_response(body, responses):
    payloads = []
    for line in body.decode().splitlines():
        if line.startswith('data: ') and line[6:] != '[DONE]':
            payloads.append(json.loads(line[6:]))
    if responses:
        complete = next(event['response'] for event in payloads if event.get('type') == 'response.completed')
        return complete, [event.get('type') for event in payloads]
    chunks = [litellm.ModelResponseStream(**payload) for payload in payloads]
    value = litellm.stream_chunk_builder(chunks)
    return value.model_dump(exclude_none=True), [chunk.choices[0].finish_reason or ('text' if chunk.choices[0].delta.content else 'metadata') for chunk in chunks if chunk.choices]


async def proxy_case(test, cell, mode):
    provider, streaming = cell['provider'], cell['streaming']
    responses = 'responses' in cell['method']
    protocol = 'openai-responses' if responses else 'openai-chat'
    wire_protocol = 'anthropic-messages' if provider == 'anthropic' else protocol
    with NativeFixture(wire_protocol, streaming=streaming) as server, CapturedRuntime(mode) as runtime:
        scope = Scope('native-litellm-proxy', digest(cell['id'] + mode))
        binding = runtime.recovery(scope)
        native_schema = {'name': binding.name, 'description': binding.description, 'parameters': dict(binding.input_schema)}
        schema = {'type': 'function', **native_schema} if responses else {'type': 'function', 'function': native_schema}
        order, guarded, authenticated, executions, recovered, all_events, first_events = [], [], [], [], [], [], []
        class OriginalPolicy(CustomLogger):
            async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
                test.assertIsInstance(user_api_key_dict, UserAPIKeyAuth)
                authenticated.append(user_api_key_dict)
                order.append('authenticated_original_guard')
                guarded.append(copy.deepcopy(data.get('input' if responses else 'messages')))
                if 'BLOCK_ORIGINAL' in json.dumps(data.get('input' if responses else 'messages')):
                    raise HTTPException(status_code=403, detail='original source denied')
                return data
        guard = OriginalPolicy(turn_off_message_logging=True)
        litellm.callbacks.append(guard)
        def trusted_scope(auth, data):
            test.assertIsInstance(auth, UserAPIKeyAuth)
            test.assertIs(auth, authenticated[-1])
            test.assertEqual(order[-1], 'authenticated_original_guard')
            order.append('trusted_scope')
            # These fixture requests are authenticated with the native proxy's
            # master key. Spoofed request metadata never supplies this identity.
            test.assertTrue(auth.api_key)
            return scope
        try:
            with configured_proxy(server, provider) as app, CavemanLiteLLM(runtime=runtime, proxy_scope=trusted_scope, operator_recovery=lambda actual: (binding, json.dumps(schema)) if actual == scope else None) as bridge:
                path = '/v1/responses' if responses else '/v1/chat/completions'
                incoming = [{'role': 'user', 'content': 'Read logs and return exact retained row 70.'}]
                def request():
                    return {'model': 'selected', 'input' if responses else 'messages': incoming, 'tools': definitions(protocol)+[schema],
                            'stream': streaming, 'metadata': {'namespace': 'model-supplied-spoof', 'session_id': 'model-supplied-spoof'}}
                # Exercise real native auth and guard rejection before any
                # optimizer or provider work on the auth-order operation.
                if cell['method'] == 'proxy.auth_guardrail_order':
                    denied = await invoke(app, path, request(), authorization=b'Bearer sk-invalid-local-fixture')
                    denied_status, denied_body = parsed_events(denied)
                    # Pinned LiteLLM rejects an unknown virtual key with this
                    # native error when the proxy has no configured key DB.
                    test.assertEqual(denied_status, 400); test.assertIn(b'No connected db.', denied_body)
                    test.assertEqual(server.calls, []); test.assertEqual(runtime.plans, [])
                    test.assertEqual(authenticated, [])
                    rejected = request(); rejected['messages'] = [{'role': 'user', 'content': 'BLOCK_ORIGINAL'}]
                    blocked = await invoke(app, path, rejected, authorization=('Bearer '+MASTER_KEY).encode())
                    blocked_status, _ = parsed_events(blocked)
                    test.assertEqual(blocked_status, 403); test.assertEqual(server.calls, []); test.assertEqual(runtime.plans, [])
                    test.assertNotIn('trusted_scope', order)
                    order.clear(); guarded.clear(); authenticated.clear()
                for step in range(5):
                    before = copy.deepcopy(incoming)
                    if streaming:
                        server.release.clear()
                    first = False
                    async def on_send(event):
                        nonlocal first
                        if streaming and b'data: ' in event.get('body', b'') and not first:
                            test.assertFalse(server.release.is_set()); test.assertFalse(server.stream_done.is_set()); first = True; first_events.append(True); server.release.set()
                    sent = await asyncio.wait_for(invoke(app, path, request(), authorization=('Bearer '+MASTER_KEY).encode(), on_send=on_send), 12)
                    status, body = parsed_events(sent)
                    test.assertEqual(status, 200, body.decode()[:1000])
                    test.assertEqual(incoming, before)
                    if streaming:
                        value, events = streamed_response(body, responses); all_events.extend(events); test.assertTrue(first)
                    else:
                        value = json.loads(body)
                    if responses:
                        test.assertEqual(value['object'], 'response'); incoming.extend(value['output'])
                        calls = [(item['call_id'], item['name'], json.loads(item['arguments'])) for item in value['output'] if item['type'] == 'function_call']
                        answer = ''.join(part['text'] or '' for item in value['output'] if item['type'] == 'message' for part in item['content'] if part['type'] == 'output_text')
                    else:
                        test.assertEqual(value['object'], 'chat.completion'); message = value['choices'][0]['message']; incoming.append(message)
                        calls = [(call['id'], call['function']['name'], json.loads(call['function']['arguments'])) for call in message.get('tool_calls') or []]
                        answer = message.get('content')
                    if not calls:
                        break
                    for call_id, name, args in calls:
                        executions.append(name)
                        if name == 'read_logs':
                            test.assertEqual(args, {}); output = SOURCE
                        else:
                            test.assertEqual(name, binding.name); page = await asyncio.to_thread(binding.execute, args); recovered.append(page); output = json.dumps(page, ensure_ascii=False)
                        incoming.append({'type': 'function_call_output', 'call_id': call_id, 'output': output} if responses else {'role': 'tool', 'tool_call_id': call_id, 'content': output})
                else:
                    test.fail('Native proxy application loop exceeded five requests')
                if mode == 'compress' and 'caveman_retrieve' not in executions:
                    raise AssertionError(str({'executions':executions,'call_shape':incoming[:2],'plans':[(p.get('model'),r.reason,len(r.replacements)) for p,r in runtime.plans],'reports':[(r.reason,r.status) for r in runtime.reports],'order':order}))
                test.assertEqual(answer, FACT); test.assertEqual(executions, ['read_logs','caveman_retrieve'] if mode=='compress' else ['read_logs'])
                test.assertEqual(source_text({'input' if responses else 'messages': incoming}, protocol), SOURCE)
                test.assertEqual(len(server.calls), 3 if mode=='compress' else 2)
                view = source_text(server.calls[1]['body'], wire_protocol)
                if mode == 'compress':
                    test.assertNotIn(FACT, view); test.assertIsNotNone(re.search(r'cmw_[a-f0-9]{48}', view))
                    test.assertEqual(recovered[0]['text'].encode(), SOURCE.encode()); test.assertTrue(recovered[0]['complete'])
                    test.assertTrue(all(options['scope'] == scope for options, _ in runtime.plans))
                    test.assertEqual(order, ['authenticated_original_guard','trusted_scope']*len(server.calls))
                else:
                    test.assertEqual(view, SOURCE); test.assertEqual(recovered, [])
                test.assertTrue(all(source_text({'input' if responses else 'messages': item}, protocol) in (None, SOURCE) for item in guarded))
                await settled(test, runtime)
                return record(test, runtime, server, native_type='Native LiteLLM FastAPI response', value=answer, source_calls=1, events=all_events,
                              report_calls=len(server.calls), extra={
                                  'native_api': path, 'native_authentication': True, 'original_guard_before_projection': True,
                                  'trusted_scope_from_UserAPIKeyAuth': mode != 'off', 'spoofed_metadata_ignored': True, 'native_stream_first_events': len(first_events),
                                  **({'unknown_virtual_key_native_status': denied_status, 'original_policy_native_status': blocked_status} if cell['method']=='proxy.auth_guardrail_order' else {}),
                                  'view_sha256': digest(re.sub(r'cmw_[a-f0-9]{48}', 'cmw_OPAQUE_HANDLE', view)),
                                  'recovered_sha256': digest(recovered[0]['text']) if recovered else None})
        finally:
            litellm.logging_callback_manager.remove_callback_from_all_lists(guard)
            litellm.logging_callback_manager.remove_callback_from_list_by_object(litellm.input_callback, guard, require_self=False)
