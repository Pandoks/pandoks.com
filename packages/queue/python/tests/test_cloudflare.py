import json
import os
import threading
import time
import unittest
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from pandoks_queue import Message, open_queue, open_topic
from pandoks_queue.cloudflare import DEAD_LETTERED, EMPTY_POLL_DELAY
from pandoks_queue.envelope import encode


class CloudflareRequestsTest(unittest.TestCase):
    """Checks what the adapter sends Cloudflare's API, which has no emulator; the CI job's live
    queues prove how Cloudflare answers."""

    def test_cloudflare_requests(self):
        requests = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                requests.setdefault(self.path, []).append(body)
                pushed = requests.get("/accounts/acct/queues/q1/messages/batch")
                result = {}
                if self.path.endswith("/pull") and pushed:
                    first = pushed[0]["messages"][0]
                    result["messages"] = [{"id": "m1", "body": first["body"], "lease_id": "lease-1", "attempts": 1}]
                elif self.path.endswith("/ack"):
                    result = {"ackCount": len(body["acks"]), "retryCount": len(body["retries"])}
                    if body["retries"]:
                        result["warnings"] = {"m1": DEAD_LETTERED}
                response = json.dumps({"success": True, "errors": [], "messages": [], "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        environment = {"CLOUDFLARE_BASE_URL": f"http://127.0.0.1:{server.server_port}", "CLOUDFLARE_API_TOKEN": "test"}
        with mock.patch.dict(os.environ, environment):
            queue = open_queue("cloudflare://acct/q1?lease=90s")
            started = time.monotonic()
            self.assertEqual(queue.receive(500), [])
            self.assertGreaterEqual(time.monotonic() - started, EMPTY_POLL_DELAY)

            messages = [Message(id=f"m{index}", source="//test", type="test", data=b"{}") for index in range(150)]
            messages[0].delay = 1.5
            queue.send(*messages)
            deliveries = queue.receive(500)
            self.assertEqual([(delivery.id, delivery.attempt) for delivery in deliveries], [("m0", 2)])
            queue.retry(3, *deliveries)
            queue.ack(*deliveries)
            queue.close()
            self.assertTrue(queue.client.is_closed())
            topic = open_topic("cloudflare://acct/q1,q2")
            topic.publish(Message(source="//test", type="test"))
            topic.close()
            self.assertTrue(topic.subscriptions[1].client.is_closed())

        batches = requests["/accounts/acct/queues/q1/messages/batch"]
        self.assertEqual([len(batch["messages"]) for batch in batches], [100, 50, 1])
        self.assertEqual(batches[0]["messages"][0]["content_type"], "text")
        self.assertEqual(batches[0]["messages"][0]["delay_seconds"], 2)
        self.assertNotIn("delay_seconds", batches[0]["messages"][1])
        self.assertEqual(len(requests["/accounts/acct/queues/q2/messages/batch"]), 1)
        self.assertEqual(requests["/accounts/acct/queues/q1/messages/pull"][0], {"batch_size": 100, "visibility_timeout_ms": 90000})
        retry, ack = requests["/accounts/acct/queues/q1/messages/ack"]
        self.assertEqual(retry["retries"], [{"lease_id": "lease-1", "delay_seconds": 3}])
        self.assertEqual(ack["acks"], [{"lease_id": "lease-1"}])

    def test_lease_starts_after_a_slow_pull(self):
        body = encode(Message(id="slow", source="//test", type="test", data=b"{}"), datetime.now(UTC))

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                time.sleep(1)
                pulled = [{"id": "m1", "body": body, "lease_id": "lease-1", "attempts": 0}]
                response = json.dumps({"success": True, "errors": [], "messages": [], "result": {"messages": pulled}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        environment = {"CLOUDFLARE_BASE_URL": f"http://127.0.0.1:{server.server_port}", "CLOUDFLARE_API_TOKEN": "test"}
        with mock.patch.dict(os.environ, environment):
            queue = open_queue("cloudflare://acct/q1?lease=500ms")
            deliveries = queue.receive(10)
            queue.close()
        self.assertEqual([delivery.id for delivery in deliveries], ["slow"])
        self.assertGreater(deliveries[0].deadline, datetime.now(UTC))

    def test_topic_pushes_subscriptions_concurrently(self):
        second_pushed = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                if self.path == "/accounts/acct/queues/q2/messages/batch":
                    second_pushed.set()
                elif not second_pushed.wait(5):
                    self.send_error(400, "q2 never pushed while q1 was slow")
                    return
                response = json.dumps({"success": True, "errors": [], "messages": [], "result": {}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        environment = {"CLOUDFLARE_BASE_URL": f"http://127.0.0.1:{server.server_port}", "CLOUDFLARE_API_TOKEN": "test"}
        with mock.patch.dict(os.environ, environment):
            topic = open_topic("cloudflare://acct/q1,q2")
            topic.publish(Message(source="//test", type="test"))
            topic.close()
