"""Exact pinned LiteLLM SDK, Router and Proxy operation journeys."""
from __future__ import annotations
import asyncio
import copy
import hashlib
import json
import os
import re
from dataclasses import asdict
from pathlib import Path

import litellm
from caveman_cloud.middleware import MiddlewareRuntime, Scope
from caveman_middleware.litellm import CavemanLiteLLM
from _provider import Provider, SOURCE, FACT, history, definitions, results

TEST_FILE = 'examples/middleware/litellm/test_native.py'
CELLS = json.loads(Path(__file__).with_name('certification-cells.json').read_text())['cells']
ENDPOINT = os.environ['CAVEMAN_MIDDLEWARE_ENDPOINT']


def digest(value):
    return hashlib.sha256((value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))).encode()).hexdigest()


class CapturedRuntime(MiddlewareRuntime):
    def __init__(self, mode, report_callback=None, **kwargs):
        self.reports, self.plans, self.pages, self.receipts = [], [], [], []
        def report(value):
            self.reports.append(value)
            if report_callback:
                report_callback(value)
        super().__init__(endpoint='http://127.0.0.1:1' if mode == 'outage' else ENDPOINT, mode='off' if mode == 'off' else 'compress', deadline_ms=3000, on_report=report, **kwargs)
    def optimize(self, **options):
        result = super().optimize(**options)
        self.plans.append((options, result))
        return result
    def retrieve(self, scope, **args):
        page = super().retrieve(scope, **args)
        self.pages.append(page)
        return page
    def observe_background(self, receipt):
        self.receipts.append(receipt)
        return super().observe_background(receipt)


class NativeFixture(Provider):
    def __init__(self, protocol, *, structured=False, streaming=False):
        self.structured = structured
        super().__init__(protocol, pause='first' if streaming else None)
    def answer(self, body):
        text, call = super().answer(body)
        return json.dumps({'answer': FACT}) if self.structured and not call else text, call


def params(server, provider, **kwargs):
    return {'model': 'anthropic/claude-sonnet-4-20250514' if provider == 'anthropic' else 'openai/fixture-model',
            'api_key': 'local-fixture', 'api_base': server.url + '/v1', 'max_tokens': 100, 'max_retries': 0, **kwargs}


def source_text(body, protocol, call_id='read-1'):
    value = results(body, protocol).get(call_id)
    return ''.join(part.get('text', '') for part in value) if isinstance(value, list) else value


async def native_call(bridge, method, scope, kwargs):
    function = getattr(bridge, method)
    return await function(scope=scope, **kwargs) if method.startswith('a') else await asyncio.to_thread(function, scope=scope, **kwargs)


async def collect(test, stream, server, asynchronous, responses):
    test.assertTrue(callable(getattr(stream, '__aiter__' if asynchronous else '__iter__', None)))
    first = await asyncio.wait_for(anext(stream), 8) if asynchronous else await asyncio.wait_for(asyncio.to_thread(next, stream), 8)
    test.assertFalse(server.release.is_set(), 'Native first event must arrive before provider EOF')
    test.assertFalse(server.stream_done.is_set(), 'Provider must still be paused when the native event arrives')
    server.release.set()
    chunks = [first] + ([chunk async for chunk in stream] if asynchronous else await asyncio.to_thread(list, stream))
    if responses:
        events = [chunk.type for chunk in chunks]
        test.assertIn('response.completed', events)
        completed = next(chunk.response for chunk in chunks if chunk.type == 'response.completed')
        text = completed.output[0].content[0].text
    else:
        test.assertIsInstance(stream, litellm.CustomStreamWrapper)
        test.assertTrue(all(isinstance(chunk, litellm.ModelResponseStream) for chunk in chunks))
        events = [chunk.choices[0].finish_reason or ('text' if chunk.choices[0].delta.content else 'metadata') for chunk in chunks if chunk.choices]
        text = ''.join(chunk.choices[0].delta.content or '' for chunk in chunks if chunk.choices)
    test.assertEqual(text, FACT)
    return text, events, type(stream).__name__


async def settled(test, runtime):
    for _ in range(500):
        events = [receipt['event_kind'] for receipt in runtime.receipts]
        if events.count('completed') + events.count('failed') >= events.count('dispatch_intent'):
            return
        await asyncio.sleep(.01)
    test.fail('Native success/failure callbacks did not settle: ' + str([r['event_kind'] for r in runtime.receipts]))


def reporting(test, runtime, *, expected=None, allow_unscoped=False):
    if expected is not None:
        test.assertEqual(len(runtime.reports), expected, 'One report per owned dispatch or disabled public call')
    test.assertTrue(runtime.reports)
    attempt_ids = [report.attempt_id for report in runtime.reports if report.attempt_id is not None]
    test.assertEqual(len(set(attempt_ids)), len(attempt_ids))
    if not allow_unscoped:
        test.assertEqual(len(attempt_ids), len(runtime.reports))
    test.assertIs(runtime.last_report, runtime.reports[-1])
    test.assertNotIn(SOURCE, json.dumps([asdict(report) for report in runtime.reports]))
    test.assertEqual(sum(report.replacement_count for report in runtime.reports), sum(len(result.replacements) for _, result in runtime.plans))
    if runtime.mode == 'off':
        test.assertEqual(runtime.plans, []); test.assertEqual(runtime.receipts, [])
        test.assertTrue(all(report.status == 'disabled' for report in runtime.reports))
    return {'count': len(runtime.reports), 'statuses': sorted(report.status for report in runtime.reports), 'replacement_count': sum(report.replacement_count for report in runtime.reports), 'unique_attempt_ids': True, 'attempt_id_count': len(attempt_ids), 'calls_without_attempt_id': len(runtime.reports)-len(attempt_ids), 'source_content_absent': True,
            'scope': 'public_method_when_disabled' if runtime.mode == 'off' else 'owned_provider_dispatch'}


def record(test, runtime, server, *, native_type, value, source_calls, history_original=True, events=None, extra=None, report_calls=None, allow_unscoped_reports=False):
    test.assertEqual(server.errors, [])
    dispatch = [r for r in runtime.receipts if r['event_kind'] == 'dispatch_intent']
    completed = [r for r in runtime.receipts if r['event_kind'] == 'completed']
    failed = [r for r in runtime.receipts if r['event_kind'] == 'failed']
    test.assertEqual(len(dispatch), len(runtime.plans))
    test.assertEqual(len(completed) + len(failed), len(dispatch))
    return {'provider_calls': len(server.calls), 'source_executions': source_calls, 'source_sha256': digest(SOURCE), 'source_utf8_bytes': len(SOURCE.encode()),
            'recovery_requests': len(runtime.pages), 'replacements': sum(len(result.replacements) for _, result in runtime.plans),
            'native_type': native_type, 'native_value': value, 'original_history': history_original, 'native_events': events or [],
            'dispatch_receipts': len(dispatch), 'completed_receipts': len(completed), 'failed_receipts': len(failed),
            'native_reports': reporting(test, runtime, expected=report_calls, allow_unscoped=allow_unscoped_reports), **(extra or {})}


async def model_case(test, cell, mode):
    provider, streaming = cell['provider'], cell['streaming']
    responses, asynchronous = 'responses' in cell['method'], cell['execution'] == 'async'
    structured = cell['structured_output']
    wire_protocol = 'anthropic-messages' if provider == 'anthropic' else 'openai-responses' if responses else 'openai-chat'
    app_protocol = 'openai-responses' if responses else 'openai-chat'
    method = ('a' if asynchronous else '') + ('responses' if responses else 'completion')
    source_calls = []
    def read_logs():
        source_calls.append({}); return SOURCE
    source = read_logs()
    incoming = history(app_protocol)
    incoming[-1]['output' if responses else 'content'] = source
    test.assertEqual(source_text({'input' if responses else 'messages': incoming}, app_protocol), source)
    original = copy.deepcopy(incoming)
    with NativeFixture(wire_protocol, structured=structured, streaming=streaming) as server, CapturedRuntime(mode) as runtime:
        with CavemanLiteLLM(runtime=runtime) as bridge:
            options = params(server, provider, **{'input' if responses else 'messages': incoming}, stream=streaming)
            if structured:
                options['response_format'] = {'type': 'json_object'}
            output = await native_call(bridge, method, Scope('litellm-exact', digest(cell['id'] + mode)), options)
            if streaming:
                value, events, native_type = await collect(test, output, server, asynchronous, responses)
            else:
                value = output.output[0].content[0].text if responses else output.choices[0].message.content
                if structured:
                    value = json.loads(value); test.assertEqual(value, {'answer': FACT})
                else:
                    test.assertEqual(value, FACT)
                native_type, events = type(output).__name__, []
            test.assertEqual(incoming, original); test.assertEqual(source_calls, [{}]); test.assertEqual(len(server.calls), 1)
            test.assertEqual(source_text(server.calls[0]['body'], wire_protocol), SOURCE)
            test.assertEqual(runtime.pages, [])
            test.assertTrue(all(not result.replacements and options['binding'] is None for options, result in runtime.plans))
            await settled(test, runtime)
            outcome = record(test, runtime, server, native_type=native_type, value=value, source_calls=1, events=events, report_calls=1,
                             extra={'native_api': method, 'request_sha256': digest(server.calls[0]['body']), 'application_tool_result_supplied_to_native_model': True, 'first_event_before_provider_eof': streaming})
        test.assertNotIn(bridge, litellm.callbacks)
        return outcome


def emit(test, cell, assertion, observation):
    print('CAVEMAN_MIDDLEWARE_OBSERVATION ' + json.dumps({'cell_id': cell['id'], 'test_id': f'{TEST_FILE}::{type(test).__name__}.{test._testMethodName}', 'assertion': assertion, 'observation': observation}), flush=True)


async def certify_provider(test, provider):
    for cell in CELLS:
        if cell['provider'] != provider:
            continue
        modes = {}
        for mode in ('compress', 'off', 'outage'):
            try:
                if cell['method'] == 'router.retry_and_fallback':
                    from _router_cases import router_case
                    modes[mode] = await router_case(test, cell, mode)
                elif cell['method'].startswith('proxy.'):
                    from _proxy_cases import proxy_case
                    modes[mode] = await proxy_case(test, cell, mode)
                elif cell['method'] == 'asgi_composition':
                    from _asgi_case import asgi_case
                    modes[mode] = await asgi_case(test, cell, mode)
                else:
                    modes[mode] = await model_case(test, cell, mode)
            except BaseException as error:
                raise AssertionError(f"{cell['id']} ({mode}): {error}") from error
        if cell['recovery'] == 'model_only':
            test.assertEqual(modes['compress']['request_sha256'], modes['off']['request_sha256'])
            test.assertEqual(modes['compress']['request_sha256'], modes['outage']['request_sha256'])
        for assertion in ('native_application', 'real_tool_result', 'transformed_provider_request', 'omitted_fact_requested', 'host_executes_exact_recovery', 'native_result_history_events_and_call_count'):
            record = {'outcome': 'observed', **modes['compress']}
            if cell['recovery'] == 'model_only' and assertion in ('transformed_provider_request', 'omitted_fact_requested', 'host_executes_exact_recovery'):
                record.update(outcome='recovery_free', reason='structured_output' if cell['structured_output'] else 'model_only_no_executor')
            emit(test, cell, assertion, record)
        emit(test, cell, 'off_baseline', {'outcome': 'observed', **modes['off']})
        emit(test, cell, 'optimizer_unavailable', {'outcome': 'observed', **modes['outage']})
