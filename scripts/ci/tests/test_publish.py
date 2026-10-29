"""Exercise release publication against a local Git remote."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.repo = self.work / "source"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "test")
        self.git("config", "user.email", "test@example.test")
        for name in ["k3s/components/images/kustomization.yaml"]:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        for chart in ["postgres", "valkey", "clickhouse"]:
            for name in [f"packages/{chart}/chart/Chart.yaml", f"apps/example/kube/{chart}.yaml"]:
                target = self.repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
        (self.repo / "application.txt").write_text("full source snapshot\n")
        self.git("add", ".")
        self.git("commit", "-m", "source")
        self.source = self.git("rev-parse", "HEAD")
        self.remote = self.work / "origin.git"
        self.git("init", "--bare", str(self.remote))
        self.git("remote", "add", "origin", str(self.remote))
        self.git("push", "origin", "main")
        self.artifacts = self.work / "artifacts"
        self.artifacts.mkdir()
        names = subprocess.check_output(["yq", ".images[].name", "k3s/components/images/kustomization.yaml"], cwd=self.repo, text=True).splitlines()
        for name in names:
            (self.artifacts / (name.rsplit("/", 1)[1] + ".txt")).write_text(f"{name}@sha256:{'a' * 64}\n")
        for chart in ["postgres", "valkey", "clickhouse"]:
            (self.artifacts / f"{chart}.version").write_text("0.0.0-ci.123.1\n")
        self.env = dict(os.environ, SOURCE_REVISION=self.source, CHART_VERSION="0.0.0-ci.123.1",
                        GITHUB_OUTPUT=str(self.work / "output"), GITHUB_STEP_SUMMARY=str(self.work / "summary"))

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True, stderr=subprocess.DEVNULL).strip()

    def publish(self, success=True):
        result = subprocess.run([str(ROOT / "scripts/ci/publish.sh"), str(self.artifacts)], cwd=self.repo,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def release(self):
        return self.git("ls-remote", "origin", "refs/heads/deploy/production").split()[0]

    def test_release_contains_complete_source_and_pins(self):
        self.publish()
        release = self.release()
        self.assertEqual(self.git("show", f"{release}:SOURCE_REVISION"), self.source)
        self.assertEqual(self.git("show", f"{release}:application.txt"), "full source snapshot")
        pins = self.git("show", f"{release}:k3s/components/images/kustomization.yaml")
        self.assertEqual(pins.count("sha256:" + "a" * 64), 8)
        for chart in ["postgres", "valkey", "clickhouse"]:
            self.assertIn("0.0.0-ci.123.1", self.git("show", f"{release}:apps/example/kube/{chart}.yaml"))
        self.assertEqual(self.git("rev-parse", "HEAD"), self.source)

    def test_release_history(self):
        self.publish()
        first = self.release()
        self.publish()
        self.assertEqual(self.git("rev-parse", f"{self.release()}^"), first)

    def test_stale_main_never_publishes(self):
        self.publish()
        first = self.release()
        self.git("reset", "--hard", self.source)
        self.git("commit", "--allow-empty", "-m", "new main")
        self.git("push", "origin", "main")
        self.assertIn("newer main", self.publish().stdout)
        self.assertEqual(first, self.release())

    def test_a_concurrent_ref_update_is_never_overwritten(self):
        import shlex
        self.git("push", "origin", "HEAD:refs/heads/race-candidate")
        hook = self.repo / ".git/hooks/pre-push"
        hook.write_text("#!/bin/sh\ngit --git-dir=" + shlex.quote(str(self.remote)) +
                        " update-ref refs/heads/deploy/production " + self.source + "\n")
        hook.chmod(0o755)
        self.publish(success=False)
        self.assertEqual(self.release(), self.source)

    def test_bad_or_incomplete_artifacts_cannot_advance_a_release(self):
        self.publish()
        first = self.release()
        cases = [("patroni.txt", None), ("patroni.txt", "ghcr.io/pandoks/patroni@sha256:bad\n"),
                 ("extra.txt", "ghcr.io/pandoks/patroni@sha256:" + "a" * 64 + "\n"),
                 ("postgres.version", None), ("postgres.version", "0.0.0-ci.123.2\n")]
        for name, value in cases:
            with self.subTest(name=name, value=value):
                path = self.artifacts / name
                original = path.read_text() if path.exists() else None
                if value is None:
                    path.unlink()
                else:
                    path.write_text(value)
                self.publish(success=False)
                self.assertEqual(first, self.release())
                if original is None:
                    path.unlink()
                else:
                    path.write_text(original)


if __name__ == "__main__":
    unittest.main()
