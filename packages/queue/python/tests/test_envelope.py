import json
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

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
        }.items():
            with self.subTest(name), self.assertRaises(ValueError):
                encode(message, datetime.now(UTC))
        encode(valid, datetime.now(UTC))
