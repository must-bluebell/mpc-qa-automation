import importlib.util
import json
import pathlib
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ExternalPlansTest(unittest.TestCase):
    def module(self):
        path = ROOT / 'scripts' / 'external_qa_plans.py'
        self.assertTrue(path.exists(), 'Plan builder and latency reporter are missing')
        spec = importlib.util.spec_from_file_location('plans', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_one_workload_and_thirty_distinct_cases(self):
        m = self.module()
        root = m.build_jmx([])
        groups = root.findall('.//ThreadGroup')
        self.assertEqual(len(groups), 1)
        group = groups[0]
        self.assertEqual(group.findtext("stringProp[@name='ThreadGroup.num_threads']"), '${__P(users,2000)}')
        self.assertEqual(group.findtext("stringProp[@name='ThreadGroup.ramp_time']"), '${__P(ramp_seconds,60)}')
        self.assertEqual(root.findtext(".//ConstantTimer/stringProp[@name='ConstantTimer.delay']"), '${__P(pacing_ms,2000)}')
        samplers = root.findall('.//HTTPSamplerProxy')
        self.assertEqual(len(samplers), 30)
        self.assertEqual(len({s.get('testname') for s in samplers}), 30)
        self.assertEqual(len(root.findall('.//JSR223Assertion')), 30)
        for s in samplers:
            self.assertEqual(s.findtext("stringProp[@name='HTTPSampler.domain']"), '${__P(host,127.0.0.1)}')
            self.assertEqual(s.findtext("boolProp[@name='HTTPSampler.follow_redirects']"), 'false')

    def test_postman_adds_twenty_without_mutating_original(self):
        m = self.module()
        original = {'info': {'name': 'Original'}, 'variable': [], 'item': [{'name': 'Original request', 'request': {'method': 'GET', 'url': '{{baseUrl}}/api/home'}}]}
        result = m.build_postman(original)
        self.assertEqual(len(original['item']), 1)
        added = result['item'][-1]['item']
        self.assertEqual(len(added), 20)
        self.assertEqual(len({x['name'] for x in added}), 20)
        for item in added:
            self.assertTrue(item['protocolProfileBehavior']['disableCookies'])
            self.assertEqual(item['request']['auth']['type'], 'noauth')
            script = '\n'.join(item['event'][0]['script']['exec'])
            self.assertIn('pm.response.responseTime', script)
            self.assertIn('Expected status', script)

    def test_percentiles_failures_and_ranking(self):
        m = self.module()
        samples = [dict(label='fast', start_ms=i * 1000, elapsed_ms=n, failed=False) for i, n in enumerate([10, 20, 30, 40])]
        samples += [dict(label='slow', start_ms=0, elapsed_ms=400, failed=False), dict(label='slow', start_ms=1000, elapsed_ms=None, failed=True)]
        rows = m.aggregate(samples)
        self.assertEqual(rows[0]['case'], 'slow')
        self.assertEqual(rows[0]['error_percent'], 50)
        self.assertEqual(rows[0]['samples'], 2)
        self.assertEqual(rows[0]['latency_samples'], 1)
        fast = rows[1]
        self.assertEqual(fast['p50_ms'], 20)
        self.assertEqual(fast['p95_ms'], 40)
        self.assertEqual(fast['max_ms'], 40)
        self.assertAlmostEqual(fast['requests_per_second'], 4 / 3.04, places=3)
        self.assertEqual(m.aggregate([]), [])

    def test_newman_assertion_and_transport_failures(self):
        m = self.module()
        data = {'run': {'executions': [
            {'item': {'name': 'read'}, 'cursor': {'iteration': 0}, 'response': {'code': 200, 'responseTime': 50}, 'assertions': [{'assertion': 'body', 'error': {'message': 'wrong body'}}]},
            {'item': {'name': 'read'}, 'requestError': {'message': 'timeout'}, 'assertions': []},
        ], 'timings': {'started': 1000, 'completed': 3000}}}
        samples = m.newman_samples(data)
        self.assertTrue(all(x['failed'] for x in samples))
        row = m.aggregate(samples)[0]
        self.assertEqual(row['error_percent'], 100)
        self.assertEqual(row['requests_per_second'], 1)

    def test_csv_quoted_names_and_expected_401(self):
        m = self.module()
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'results.jtl'
            path.write_text('timeStamp,elapsed,label,responseCode,success\n1000,30,"guard, anonymous",401,true\n2000,50,"guard, anonymous",401,false\n')
            rows = m.aggregate(m.jtl_samples(path))
            self.assertEqual(rows[0]['case'], 'guard, anonymous')
            self.assertEqual(rows[0]['error_percent'], 50)

    def test_reference_strips_recorded_headers_and_bodies(self):
        m = self.module()
        root = m.build_jmx([{'method': 'POST', 'path': '/api/auth/verify?secret=hidden', 'third_party': False}])
        xml = ET.tostring(root, encoding='unicode')
        self.assertNotIn('secret=hidden', xml)
        reference = root.findall('.//ThreadGroup')[1]
        self.assertEqual(reference.get('enabled'), 'false')


if __name__ == '__main__':
    unittest.main()
