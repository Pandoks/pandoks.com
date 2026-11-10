import json
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from pandoks_queue import open_queue, open_topic
from pandoks_queue.envelope import MAX_DELAY, MAX_ENVELOPE_BYTES, Message, decode, encode

FIXTURES = sorted((Path(__file__).resolve().parents[2] / "testdata" / "envelopes").glob("*.json"))


class EnvelopeTest(unittest.TestCase):
    def test_golden_envelopes_round_trip(self):
        self.assertTrue(FIXTURES)
        for path in FIXTURES:
            with self.subTest(path.name):
                body = path.read_text()
                delivery = decode(body, attempt=1, deadline=datetime.now(UTC))
                self.assertEqual(json.loads(encode(delivery, delivery.time)), json.loads(body))

    def test_encode_rejects_what_other_brokers_cannot_carry(self):
        valid = Message(source="//test", type="test")
        for name, message in {
            "extension name": replace(valid, extensions={"Notification-ID": "1"}),
            "attribute shadow": replace(valid, extensions={"source": "x"}),
            "delay": replace(valid, delay=MAX_DELAY + 1),
            "size": replace(valid, data=json.dumps("x" * MAX_ENVELOPE_BYTES).encode()),
            "invalid json": replace(valid, data=b"{"),
            "id": replace(valid, id=1),
            "source": replace(valid, source=1),
            "type": replace(valid, type=b"test"),
            "extension value": replace(valid, extensions={"ext": 1}),
        }.items():
            with self.subTest(name), self.assertRaises(ValueError):
                encode(message, datetime.now(UTC))
        encode(valid, datetime.now(UTC))

    def test_open_keeps_valkey_passwords_out_of_errors(self):
        for password in ("xq1/zq2", "xq1?zq2", "xq1#zq2", "123/zq2", "123?zq2", "123#zq2"):
            for opener in (open_queue, open_topic):
                with self.subTest(password, opener=opener.__name__), self.assertRaises(ValueError) as raised:
                    opener(f"valkey://client:{password}@127.0.0.1:1/q?lease=1s&max_attempts=1")
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

    def test_decode_rejects_what_go_and_ts_reject(self):
        envelope = '{"specversion":"1.0","id":"x","source":"//test","type":"test","time":"2026-11-09T18:00:00.000Z",%s}'
        for member in ('"data":NaN', '"data":Infinity', '"data":-Infinity', '"data_base64":"e31="'):
            with self.subTest(member), self.assertRaises(ValueError):
                decode(envelope % member, attempt=1, deadline=datetime.now(UTC))
