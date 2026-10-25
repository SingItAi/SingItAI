"""GET/HEAD /health, /status and /status.json on the web API (web_api.py): public, keyless, no cookies.

/health says only that the process answers. /status and /status.json serve, byte for byte, the files
scripts/singit-uptime.py writes into SINGIT_STATUS_DIR; before the first report they answer 503.
"""
import json
import os
import tempfile
import threading
import unittest
import unittest.mock
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

from sign402_gateway import agent_allowance as aa
from sign402_gateway import web_api as wa
from sign402_gateway.web_accounts import WebAccountStore, WebAuth

NOW = 1_800_000_000
DOMAIN, URI = "app.singit.test", "https://app.singit.test"


class HealthStatusHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.status_dir = Path(self.tmp.name) / "status"
        env = unittest.mock.patch.dict(os.environ, {"SINGIT_STATUS_DIR": str(self.status_dir)})
        env.start()
        self.addCleanup(env.stop)
        base_store = aa.AllowanceStore(Path(self.tmp.name) / "allowance.db")
        web_store = WebAccountStore(Path(self.tmp.name) / "web.db")
        api = wa.WebApi(WebAuth(web_store, domain=DOMAIN, uri=URI, allowed=None, now=lambda: NOW),
                        SimpleNamespace(store=base_store), now=lambda: NOW)
        self.server = wa.WebServer(("127.0.0.1", 0), api, URI)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def request(self, method, path):
        req = urllib.request.Request(self.base_url + path, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def test_health_is_200_json_open_cors_and_uncached(self):
        status, headers, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True, "service": "sign402-web-api"})
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Set-Cookie", headers)

    def test_health_head_has_no_body(self):
        status, headers, body = self.request("HEAD", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)

    def test_status_is_503_before_the_first_report(self):
        for path in ("/status", "/status.json"):
            status, _, body = self.request("GET", path)
            self.assertEqual(status, 503, path)
            self.assertEqual(json.loads(body)["error"], "no_status")

    def test_status_files_are_served_as_written(self):
        self.status_dir.mkdir()
        page = b"<!doctype html><title>SingIt status</title>"
        doc = json.dumps({"overall": {"24h": 100.0}}).encode()
        (self.status_dir / "status.html").write_bytes(page)
        (self.status_dir / "status.json").write_bytes(doc)

        status, headers, body = self.request("GET", "/status")
        self.assertEqual((status, body), (200, page))
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertEqual(headers["Cache-Control"], f"public, max-age={wa.STATUS_CACHE_SECONDS}")

        status, headers, body = self.request("GET", "/status.json?x=1")
        self.assertEqual((status, body), (200, doc))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")

        status, headers, body = self.request("HEAD", "/status.json")
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(int(headers["Content-Length"]), len(doc))

    def test_no_other_file_is_reachable_through_status(self):
        self.status_dir.mkdir()
        (self.status_dir / "status.json").write_text("{}")
        for path in ("/status/../web.db", "/status.json/x", "/statuses", "/status.html"):
            status, _, _ = self.request("GET", path)
            self.assertNotEqual(status, 200, path)


if __name__ == "__main__":
    unittest.main()
