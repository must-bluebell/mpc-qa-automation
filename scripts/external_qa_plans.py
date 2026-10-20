"""Build portable QA plans and rank measured API latency. Does not send requests."""
import argparse
import copy
import csv
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

FOLDER = 'QA additions - 20 API cases'


def cases():
    rows = []
    def add(title, method, path, status, error=None, foreign=False, no_store=False, anonymous=False):
        rows.append(dict(title=title, method=method, path=path, status=status, error=error,
                         foreign=foreign, no_store=no_store, anonymous=anonymous))
    for title, path in [('Public home JSON', '/api/home'), ('Public quests JSON', '/api/quests'),
                        ('Public vote proposals JSON', '/api/vote/proposals')]:
        add(title, 'GET', path, 200)
    add('Anonymous session has no address', 'GET', '/api/auth/session', 200, no_store=True, anonymous=True)
    for title, path in [('Notifications', '/api/notifications'), ('Activities', '/api/activities'),
                        ('Energy balance', '/api/energy'), ('Energy history', '/api/energy/history'),
                        ('Energy deposits', '/api/energy/deposits'), ('Energy portfolio', '/api/energy/portfolio'),
                        ('Energy compensation', '/api/energy/compensation')]:
        add(title + ' rejects anonymous access', 'GET', path, 401, 'not_signed_in')
    for name in ['admins', 'quests', 'roles']:
        add('Admin ' + name + ' requires admin session', 'GET', '/api/admin/' + name, 401, 'not_admin')
    for name in ['relay-sweep', 'funnel-failures']:
        add('Cron ' + name + ' rejects missing bearer', 'GET', '/api/cron/' + name, [401, 403])
    for name in ['nonce', 'logout']:
        add('Foreign-origin ' + name + ' is refused', 'POST', '/api/auth/' + name, 403, foreign=True)
    for value in ['0', 'invalid']:
        add('Vote metadata rejects ID ' + value, 'GET', '/api/vote/metadata/' + value, 400, 'bad_proposal_id')
    for name in ['ledger/export', 'website-analytics', 'join-policy']:
        add('Admin ' + name + ' requires admin session', 'GET', '/api/admin/' + name, 401, 'not_admin')
    for name in ['energy-reconcile', 'quest-reconcile', 'checkin-reconcile']:
        add('Cron ' + name + ' rejects missing bearer', 'GET', '/api/cron/' + name, [401, 403])
    for method, path in [('PATCH', '/api/notifications'), ('POST', '/api/energy'), ('POST', '/api/energy/compensation')]:
        add('Foreign-origin ' + method + ' ' + path + ' is refused', method, path, 403, foreign=True)
    add('Session with invalid authorization remains anonymous', 'GET', '/api/auth/session', 200,
        no_store=True, anonymous=True)
    rows[-1]['invalid_bearer'] = True
    assert len(rows) == 30
    for i, row in enumerate(rows):
        row['id'] = f'LOAD-{i + 1:02}'
        row['statuses'] = row['status'] if isinstance(row['status'], list) else [row['status']]
        row['category'] = 'successful-read' if row['status'] == 200 else 'expected-rejection'
    return rows


def prop(parent, name, value, tag='stringProp'):
    ET.SubElement(parent, tag, name=name).text = str(value)


def component(parent, tag, name, gui, enabled=True):
    node = ET.SubElement(parent, tag, guiclass=gui, testclass=tag, testname=name, enabled=str(enabled).lower())
    tree = ET.SubElement(parent, 'hashTree')
    return node, tree


def thread(parent, name, enabled=True):
    node, tree = component(parent, 'ThreadGroup', name, 'ThreadGroupGui', enabled)
    prop(node, 'ThreadGroup.on_sample_error', 'continue')
    loop = ET.SubElement(node, 'elementProp', name='ThreadGroup.main_controller', elementType='LoopController',
                         guiclass='LoopControlPanel', testclass='LoopController', testname='Loop Controller', enabled='true')
    prop(loop, 'LoopController.continue_forever', 'false', 'boolProp')
    prop(loop, 'LoopController.loops', '${__P(loops,1)}')
    prop(node, 'ThreadGroup.num_threads', '${__P(users,2000)}' if enabled else '1')
    prop(node, 'ThreadGroup.ramp_time', '${__P(ramp_seconds,60)}' if enabled else '1')
    prop(node, 'ThreadGroup.scheduler', 'false', 'boolProp')
    prop(node, 'ThreadGroup.same_user_on_next_iteration', 'false', 'boolProp')
    return tree


def sampler(parent, name, method, path, body=None, enabled=True):
    node, tree = component(parent, 'HTTPSamplerProxy', name, 'HttpTestSampleGui', enabled)
    args = ET.SubElement(node, 'elementProp', name='HTTPsampler.Arguments', elementType='Arguments')
    coll = ET.SubElement(args, 'collectionProp', name='Arguments.arguments')
    if body is not None:
        arg = ET.SubElement(coll, 'elementProp', name='', elementType='HTTPArgument')
        prop(arg, 'HTTPArgument.always_encode', 'false', 'boolProp')
        prop(arg, 'Argument.value', body)
        prop(arg, 'Argument.metadata', '=')
        prop(node, 'HTTPSampler.postBodyRaw', 'true', 'boolProp')
    for key, value in dict(domain='${__P(host,127.0.0.1)}', port='${__P(port,3410)}',
                           protocol='${__P(protocol,http)}', path=path.split('?')[0], method=method,
                           connect_timeout='10000', response_timeout='30000').items():
        prop(node, 'HTTPSampler.' + key, value)
    for key, value in [('follow_redirects', 'false'), ('auto_redirects', 'false'), ('use_keepalive', 'true'), ('image_parser', 'false')]:
        prop(node, 'HTTPSampler.' + key, value, 'boolProp')
    return tree


def build_jmx(reference):
    root = ET.Element('jmeterTestPlan', version='1.2', properties='5.0', jmeter='5.6.3')
    outer = ET.SubElement(root, 'hashTree')
    plan, tree = component(outer, 'TestPlan', 'MPC - 30 additional load cases', 'TestPlanGui')
    prop(plan, 'TestPlan.functional_mode', 'false', 'boolProp')
    prop(plan, 'TestPlan.serialize_threadgroups', 'false', 'boolProp')
    ET.SubElement(ET.SubElement(plan, 'elementProp', name='TestPlan.user_defined_variables', elementType='Arguments'),
                  'collectionProp', name='Arguments.arguments')
    active = thread(tree, 'LOAD-01 to LOAD-30 - 2000 total users')
    timer, _ = component(active, 'ConstantTimer', '2 second pause before each request per user', 'ConstantTimerGui')
    prop(timer, 'ConstantTimer.delay', '${__P(pacing_ms,2000)}')
    for row in cases():
        scope = sampler(active, row['id'] + ' | ' + row['title'], row['method'], row['path'],
                        '{}' if row['method'] != 'GET' else None)
        manager, _ = component(scope, 'HeaderManager', 'JSON and explicit origin', 'HeaderPanel')
        headers = ET.SubElement(manager, 'collectionProp', name='HeaderManager.headers')
        values = {'Accept': 'application/json', 'Content-Type': 'application/json',
                  'Origin': 'https://attacker.example' if row['foreign'] else '${__P(protocol,http)}://${__P(host,127.0.0.1)}:${__P(port,3410)}'}
        if row.get('invalid_bearer'):
            values['Authorization'] = 'Bearer invalid-qa-token'
        for key, value in values.items():
            entry = ET.SubElement(headers, 'elementProp', name=key, elementType='Header')
            prop(entry, 'Header.name', key)
            prop(entry, 'Header.value', value)
        assertion, _ = component(scope, 'JSR223Assertion', 'Status, JSON and security assertions', 'TestBeanGUI')
        prop(assertion, 'scriptLanguage', 'groovy')
        prop(assertion, 'cacheKey', 'true')
        script = f'''def allowed = {json.dumps(row['statuses'])}
def code = prev.getResponseCode()
def failures = []
if (!(code ==~ /\\d{{3}}/) || !allowed.contains(code as Integer)) failures.add('Unexpected response status')
def data = null
try {{ data = new groovy.json.JsonSlurper().parseText(prev.getResponseDataAsString()) }}
catch (Exception ignored) {{ failures.add('Response must be valid JSON') }}
if (!prev.getContentType().toLowerCase().contains('application/json')) failures.add('Expected JSON content type')
'''
        if row['error']:
            script += f"if (!(data instanceof Map) || data.error != '{row['error']}') failures.add('Unexpected error contract')\n"
        if row['anonymous']:
            script += "if (!(data instanceof Map) || data.address != null) failures.add('Anonymous session disclosed an address')\n"
        if row['no_store']:
            script += "if (!prev.getResponseHeaders().toLowerCase().contains('no-store')) failures.add('Missing no-store cache control')\n"
        script += """if (failures.isEmpty()) { prev.setSuccessful(true) }
else { AssertionResult.setFailure(true); AssertionResult.setFailureMessage(failures.join('; ')) }
"""
        prop(assertion, 'script', script)
    if reference:
        legacy = thread(tree, 'DISABLED reference - captured credentials and request bodies removed', False)
        for i, row in enumerate(reference):
            path = re.sub(r'/\d+(?=/|$)', '/1', row['path'].split('?')[0])
            sampler(legacy, f'REFERENCE-{i + 1:02} ' + ('third-party omitted' if row['third_party'] else row['method'] + ' ' + path),
                    row['method'], '/' if row['third_party'] else path,
                    '{}' if row['method'] != 'GET' else None, False)
    ET.indent(root, space='  ')
    return root


def postman_script(row):
    lines = [f"pm.test('Expected status', () => pm.expect(pm.response.code).to.be.oneOf({json.dumps(row['statuses'])}));",
             "pm.test('JSON content type', () => pm.expect(pm.response.headers.get('Content-Type') || '').to.include('application/json'));",
             "pm.test('Valid JSON response', () => pm.expect(() => pm.response.json()).not.to.throw());",
             "const limit = Number(pm.variables.get('qaLatencyLimitMs'));",
             "pm.test('Latency within configured limit', () => { pm.expect(Number.isFinite(limit) && limit > 0).to.eql(true); pm.expect(pm.response.responseTime).to.be.at.most(limit); });"]
    if row['error']:
        lines.append(f"pm.test('Expected error contract', () => pm.expect(pm.response.json().error).to.eql('{row['error']}'));")
    if row['anonymous']:
        lines.append("pm.test('Anonymous session', () => { const data = pm.response.json(); pm.expect(data).to.be.an('object'); pm.expect(data.address == null).to.eql(true); });")
    if row['no_store']:
        lines.append("pm.test('Session must not be cached', () => pm.expect(pm.response.headers.get('Cache-Control') || '').to.include('no-store'));")
    lines.append("console.log('QA_LATENCY', JSON.stringify({case: pm.info.requestName, elapsedMs: pm.response.responseTime, status: pm.response.code}));")
    return lines


def build_postman(original):
    result = copy.deepcopy(original)
    result['info']['name'] += ' - extended QA'
    result.setdefault('variable', []).append({'key': 'qaLatencyLimitMs', 'value': '2000',
                                             'description': 'Provisional per-request response time limit in milliseconds; agree against environment SLOs.'})
    folder = {'name': FOLDER, 'description': 'Run this folder alone for independent anonymous security and public-read cases. Cookies and inherited auth disabled.', 'item': []}
    for i, row in enumerate(cases()[:20]):
        headers = [{'key': 'Accept', 'value': 'application/json'}, {'key': 'Content-Type', 'value': 'application/json'},
                   {'key': 'Origin', 'value': 'https://attacker.example' if row['foreign'] else '{{baseUrl}}'}]
        request = {'method': row['method'], 'auth': {'type': 'noauth'}, 'header': headers,
                   'url': '{{baseUrl}}' + row['path'], 'description': row['category'] + '. Expected status: ' + str(row['statuses'])}
        if row['method'] != 'GET':
            request['body'] = {'mode': 'raw', 'raw': '{}', 'options': {'raw': {'language': 'json'}}}
        folder['item'].append({'name': f'API-EXT-{i + 1:02} | ' + row['title'], 'request': request,
                               'protocolProfileBehavior': {'disableCookies': True, 'followRedirects': False},
                               'event': [{'listen': 'test', 'script': {'type': 'text/javascript', 'exec': postman_script(row)}}]})
    result['item'].append(folder)
    return result


def aggregate(samples):
    groups = {}
    for sample in samples:
        groups.setdefault(sample['label'], []).append(sample)
    rows = []
    for name, values in groups.items():
        times = sorted(s['elapsed_ms'] for s in values if isinstance(s.get('elapsed_ms'), (int, float)) and math.isfinite(s['elapsed_ms']) and s['elapsed_ms'] >= 0)
        starts = [s['start_ms'] for s in values if s.get('start_ms') is not None]
        ends = [s['start_ms'] + (s.get('elapsed_ms') or 0) for s in values if s.get('start_ms') is not None]
        bounds = [s['window'] for s in values if s.get('window')]
        duration = (max(b[1] for b in bounds) - min(b[0] for b in bounds)) if bounds else max(ends, default=0) - min(starts, default=0)
        def percentile(p):
            return times[max(0, math.ceil(len(times) * p) - 1)] if times else None
        catalog = next((r for r in cases() if name.split(' | ', 1)[-1] == r['title']), None)
        rows.append(dict(case=name, endpoint=(catalog['method'] + ' ' + catalog['path']) if catalog else None,
                         category=catalog['category'] if catalog else 'original case',
                         samples=len(values), latency_samples=len(times),
                         avg_ms=sum(times) / len(times) if times else None, p50_ms=percentile(.5),
                         p95_ms=percentile(.95), p99_ms=percentile(.99), max_ms=max(times) if times else None,
                         requests_per_second=len(values) * 1000 / duration if duration > 0 else None,
                         error_percent=100 * sum(bool(s['failed']) for s in values) / len(values)))
    return sorted(rows, key=lambda row: (row['p95_ms'] is not None, row['p95_ms'] or 0), reverse=True)


def newman_samples(data):
    run = data['run']
    timing = run.get('timings', {})
    window = [timing.get('started'), timing.get('completed')]
    window = window if all(isinstance(n, (int, float)) and math.isfinite(n) for n in window) else None
    samples = []
    for execution in run.get('executions', []):
        response = execution.get('response') or {}
        assertions = execution.get('assertions') or []
        failed = bool(execution.get('requestError')) or not response or any(a.get('error') or a.get('skipped') for a in assertions)
        # An expected 401/403 is successful only when its assertions actually passed.
        if not assertions and response.get('code', 0) >= 400:
            failed = True
        samples.append(dict(label=execution.get('item', {}).get('name', 'Unnamed request'),
                            elapsed_ms=response.get('responseTime'), start_ms=None, window=window, failed=failed))
    return samples


def jtl_samples(path):
    with Path(path).open(newline='') as stream:
        reader = csv.DictReader(stream)
        required = {'timeStamp', 'elapsed', 'label', 'success'}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError('Expected JMeter CSV JTL with timeStamp, elapsed, label and success headers')
        return [dict(label=row['label'], start_ms=float(row['timeStamp']), elapsed_ms=float(row['elapsed']),
                     failed=row['success'].lower() != 'true') for row in reader]


def markdown(rows):
    lines = ['# API latency ranking', '', 'Cases ranked by p95 response time (nearest-rank percentiles). Timings are full response durations in ms, not server-only processing time.',
             'Expected rejection cases are labelled separately from successful reads. Error % includes assertion/transport failures; an asserted expected 401/403 is not an error.',
             'JMeter RPS uses each case\'s first start to last finish; Newman RPS uses the collection run duration. Neither represents server capacity.', '',
             '| Case / API | Samples | Average ms | p50 ms | p95 ms | p99 ms | Max ms | Requests/sec | Error % |',
             '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    def fmt(value):
        return 'n/a' if value is None else f'{value:.2f}'
    catalog = {r['title']: r['category'] for r in cases()}
    for row in rows:
        title = row['case'].split(' | ', 1)[-1]
        category = catalog.get(title, 'original case')
        name = row['case'].replace('|', '\\|').replace('\n', ' ').replace('\r', ' ')
        endpoint = (' — ' + row['endpoint']) if row['endpoint'] else ''
        lines.append('| ' + name + endpoint + f' ({category}) | {row["samples"]} | ' + ' | '.join(fmt(row[k]) for k in
                     ['avg_ms', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'requests_per_second', 'error_percent']) + ' |')
    if not rows:
        lines.append('\nNo measured requests. No passing result or slowest API can be inferred.')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    build = sub.add_parser('build')
    build.add_argument('--jmx', type=Path, required=True)
    build.add_argument('--postman', type=Path, required=True)
    build.add_argument('--out', type=Path, default=Path('testplans'))
    report = sub.add_parser('report')
    report.add_argument('input', type=Path)
    report.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.command == 'build':
        source = ET.parse(args.jmx)
        reference = []
        for node in source.findall('.//HTTPSamplerProxy'):
            domain = node.findtext("stringProp[@name='HTTPSampler.domain']", '')
            reference.append(dict(method=node.findtext("stringProp[@name='HTTPSampler.method']", 'GET'),
                                  path='/' + node.findtext("stringProp[@name='HTTPSampler.path']", '').lstrip('/'),
                                  third_party=domain != '${BASE_URL_1}'))
        ET.ElementTree(build_jmx(reference)).write(args.out / 'MPC-load-testing-extended.jmx', encoding='utf-8', xml_declaration=True)
        collection = build_postman(json.loads(args.postman.read_text()))
        (args.out / 'mpc-waitlist-extended.postman_collection.json').write_text(json.dumps(collection, indent=2) + '\n')
        (args.out / 'case-catalog.json').write_text(json.dumps(cases(), indent=2) + '\n')
        print(f'Built 30 active load cases and 20 API additions in {args.out}; {len(reference)} disabled sanitized reference samplers.')
    else:
        samples = newman_samples(json.loads(args.input.read_text())) if args.input.suffix == '.json' else jtl_samples(args.input)
        rows = aggregate(samples)
        (args.out / 'api-latency.json').write_text(json.dumps(rows, indent=2, allow_nan=False) + '\n')
        (args.out / 'api-latency.md').write_text(markdown(rows))
        print(f'Reported {len(samples)} measured requests across {len(rows)} cases in {args.out}')


if __name__ == '__main__':
    main()
