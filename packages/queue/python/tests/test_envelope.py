import json
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from pandoks_queue import open_queue, open_topic
from pandoks_queue.envelope import (
    MAX_DELAY,
    MAX_DEPTH,
    MAX_ENVELOPE_BYTES,
    Message,
    decode,
    decode_rows,
    delay_milliseconds,
    encode,
)

TESTDATA = Path(__file__).resolve().parents[2] / "testdata"
FIXTURES = sorted((TESTDATA / "envelopes").glob("*.json"))
MALFORMED = sorted((TESTDATA / "malformed").glob("*.json"))
MALFORMED_URLS = json.loads((TESTDATA / "malformed-urls.json").read_text())


class EnvelopeTest(unittest.TestCase):
    def test_golden_envelopes_round_trip(self):
        self.assertTrue(FIXTURES)
        for path in FIXTURES:
            with self.subTest(path.name):
                body = path.read_text()
                delivery = decode(body, attempt=1, deadline=datetime.now(UTC))
                encoded = encode(delivery, delivery.time)
                self.assertEqual(json.loads(encoded), json.loads(body))
                self.assertNotRegex(encoded, "[\ufffe\uffff]", "SQS rejects them raw")

    def test_delay_milliseconds_round_up(self):
        for seconds, milliseconds in [(0, 0), (0.0005, 1), (0.0019, 2), (0.002, 2), (2.007, 2007)]:
            with self.subTest(seconds=seconds):
                self.assertEqual(delay_milliseconds(seconds), milliseconds)

    def test_encode_rejects_what_other_brokers_cannot_carry(self):
        valid = Message(source="//test", type="test")
        for name, message in {
            "extension name": replace(valid, extensions={"Notification-ID": "1"}),
            "attribute shadow": replace(valid, extensions={"source": "x"}),
            "delay": replace(valid, delay=MAX_DELAY + 1),
            "size": replace(valid, data=json.dumps("x" * MAX_ENVELOPE_BYTES).encode()),
            "invalid json": replace(valid, data=b"{"),
            "leading bom": replace(valid, data="\ufeff{}".encode()),
            "infinite number": replace(valid, data=b"1e400"),
            "nesting depth": replace(valid, data=b"[" * MAX_DEPTH + b"]" * MAX_DEPTH),
            "id": replace(valid, id=1),
            "falsy id": replace(valid, id=0),
            "falsy content type": replace(valid, content_type=False),
            "source": replace(valid, source=1),
            "type": replace(valid, type=b"test"),
            "extension value": replace(valid, extensions={"ext": 1}),
            "lone surrogate id": replace(valid, id="cut \ud83d"),
            "lone surrogate content type": replace(valid, content_type="text/plain\udc00"),
            "lone surrogate extension": replace(valid, extensions={"ext": "\udc00"}),
        }.items():
            with self.subTest(name), self.assertRaises(ValueError):
                encode(message, datetime.now(UTC))
        encode(valid, datetime.now(UTC))

    def test_open_rejects_a_valkey_url_without_a_port(self):
        for opener in (open_queue, open_topic):
            with self.subTest(opener.__name__), self.assertRaisesRegex(ValueError, "host:port"):
                opener("valkey://127.0.0.1/q?lease=1s&max_attempts=1")

    def test_open_rejects_malformed_urls(self):
        for opener, urls in ((open_queue, MALFORMED_URLS["queues"]), (open_topic, MALFORMED_URLS["topics"])):
            for url in urls:
                with self.subTest(url):
                    with self.assertRaisesRegex(ValueError, "URL") as raised:
                        opener(url)
                    self.assertNotRegex(str(raised.exception), "xq1|zq2")

    def test_open_hides_a_netloc_python_cannot_split(self):
        for opener in (open_queue, open_topic):
            with self.subTest(opener.__name__), self.assertRaisesRegex(ValueError, "URL") as raised:
                opener("valkey://client:xq1\uff03zq2@127.0.0.1:1/t")
            self.assertNotRegex(str(raised.exception), "xq1|zq2")

    def test_decode_rejects_times_go_rejects(self):
        body = json.loads(FIXTURES[0].read_text())
        for time in ("2026-11-09T18:00:00", "2026-11-09", "20261109T180000Z", "2026-11-09T24:00:00Z", "2026-02-30T18:00:00Z"):
            with self.subTest(time), self.assertRaises(ValueError):
                decode(json.dumps(body | {"time": time}), attempt=1, deadline=datetime.now(UTC))

    def test_decode_rejects_both_data_members(self):
        body = json.loads(FIXTURES[0].read_text())
        with self.assertRaises(ValueError):
            decode(json.dumps(body | {"data": {}, "data_base64": "e30="}), attempt=1, deadline=datetime.now(UTC))

    def test_decode_drops_malformed_envelopes(self):
        self.assertTrue(MALFORMED)
        for path in MALFORMED:
            with self.subTest(path.name), self.assertLogs("pandoks_queue"):
                self.assertEqual(decode_rows([(path.read_text(), 1, path.name)], datetime.now(UTC)), ([], [path.name]))

    def test_decode_keeps_an_empty_content_type(self):
        body = json.loads(FIXTURES[0].read_text())
        delivery = decode(json.dumps(body | {"datacontenttype": ""}), attempt=1, deadline=datetime.now(UTC))
        self.assertEqual(delivery.content_type, "")

    def test_decode_rejects_what_go_and_ts_reject(self):
        envelope = '{"specversion":"1.0","id":"x","source":"//test","type":"test","time":"2026-11-09T18:00:00.000Z",%s}'
        for member in ('"data":NaN', '"data":Infinity', '"data":-Infinity', '"data_base64":"e31="'):
            with self.subTest(member), self.assertRaises(ValueError):
                decode(envelope % member, attempt=1, deadline=datetime.now(UTC))
