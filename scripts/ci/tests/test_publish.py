"""Exercise release publication against a local Git remote; only GitHub API reads are stubbed."""

import json
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
        for name in ["k3s/components/images/kustomization.yaml", "k3s/overlays/preview/kustomization.yaml"]:
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
        (self.work / "gh").write_text('#!/bin/sh\ncat "$MOCK_PR_FILE"\n')
        (self.work / "gh").chmod(0o755)
        self.env = dict(os.environ, PATH=f"{self.work}:{os.environ['PATH']}", SOURCE_REVISION=self.source,
                        PREVIEW_NUMBER="123", BASE_REVISION=self.source, CHART_VERSION="0.0.0-ci.123.1", GITHUB_REPOSITORY="pandoks/pandoks.com",
                        GITHUB_OUTPUT=str(self.work / "output"), GITHUB_STEP_SUMMARY=str(self.work / "summary"),
                        MOCK_PR_FILE=str(self.work / "pr.json"))
        self.pr = {"state": "open", "head": {"sha": self.source, "repo": {"full_name": "pandoks/pandoks.com"}}, "labels": [{"name": "preview"}]}

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True, stderr=subprocess.DEVNULL).strip()

    def publish(self, success=True):
        (self.work / "pr.json").write_text(json.dumps(self.pr))
        result = subprocess.run([str(ROOT / "scripts/ci/publish.sh"), str(self.artifacts)], cwd=self.repo,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def release(self, target="deploy/preview-123"):
        return self.git("ls-remote", "origin", f"refs/heads/{target}").split()[0]

    def test_preview_contains_complete_source_and_pins(self):
        self.publish()
        release = self.release()
        self.assertEqual(self.git("show", f"{release}:SOURCE_REVISION"), self.source)
        self.assertEqual(self.git("show", f"{release}:application.txt"), "full source snapshot")
        self.assertIn("namespace: preview-123", self.git("show", f"{release}:k3s/overlays/preview/kustomization.yaml"))
        pins = self.git("show", f"{release}:k3s/components/images/kustomization.yaml")
        self.assertEqual(pins.count("sha256:" + "a" * 64), 8)
        for chart in ["postgres", "valkey", "clickhouse"]:
            self.assertIn("0.0.0-ci.123.1", self.git("show", f"{release}:apps/example/kube/{chart}.yaml"))
        self.assertEqual(self.git("rev-parse", "HEAD"), self.source)

    def test_release_history_and_independent_preview_names(self):
        self.publish()
        first = self.release()
        self.publish()
        self.assertEqual(self.git("rev-parse", f"{self.release()}^"), first)
        self.env["PREVIEW_NUMBER"] = "456"
        self.publish()
        other = self.release("deploy/preview-456")
        self.assertIn("namespace: preview-456", self.git("show", f"{other}:k3s/overlays/preview/kustomization.yaml"))
        self.assertNotEqual(other, self.release())

    def test_main_release_and_stale_main(self):
        self.env["PREVIEW_NUMBER"] = ""
        self.publish()
        first = self.release("deploy/production")
        self.git("reset", "--hard", self.source)
        self.git("commit", "--allow-empty", "-m", "new main")
        self.git("push", "origin", "main")
        self.assertIn("newer main", self.publish().stdout)
        self.assertEqual(first, self.release("deploy/production"))

    def test_ineligible_or_outdated_preview_never_publishes(self):
        cases = [dict(state="closed"), dict(labels=[]),
                 dict(head={"sha": "b" * 40, "repo": {"full_name": "pandoks/pandoks.com"}}),
                 dict(head={"sha": self.source, "repo": {"full_name": "other/fork"}})]
        original = self.pr.copy()
        for change in cases:
            with self.subTest(change=change):
                self.pr = original | change
                self.assertIn("skipping", self.publish().stdout)
                self.assertEqual(self.git("ls-remote", "origin", "refs/heads/deploy/*"), "")

    def test_rebased_preview_can_replace_its_previous_release(self):
        self.publish()
        previous = self.release()
        self.git("checkout", "--orphan", "rebased")
        self.git("commit", "-m", "rebased source")
        self.env["SOURCE_REVISION"] = self.git("rev-parse", "HEAD")
        self.pr["head"]["sha"] = self.env["SOURCE_REVISION"]
        self.publish()
        self.assertEqual(self.git("rev-parse", f"{self.release()}^"), previous)
        self.assertEqual(self.git("show", f"{self.release()}:SOURCE_REVISION"), self.env["SOURCE_REVISION"])

    def test_shared_infrastructure_changes_are_selected_without_app_only_reverts(self):
        self.publish()
        self.assertIn("infrastructure=true", (self.work / "output").read_text())
        self.git("push", "origin", f"{self.release()}:refs/heads/deploy/dev")
        for name, expected in [("application.txt", False), ("k3s/bootstrap/local/test.yaml", False),
                               ("k3s/base/core/test.yaml", True), ("mise.toml", True)]:
            with self.subTest(name=name):
                self.git("reset", "--hard", self.source)
                path = self.repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("changed\n")
                self.git("add", ".")
                self.git("commit", "-m", name)
                self.env["SOURCE_REVISION"] = self.git("rev-parse", "HEAD")
                self.pr["head"]["sha"] = self.env["SOURCE_REVISION"]
                (self.work / "output").write_text("")
                self.publish()
                self.assertEqual("infrastructure=true" in (self.work / "output").read_text(), expected)

    def test_a_concurrent_ref_update_is_never_overwritten(self):
        import shlex
        self.git("push", "origin", "HEAD:refs/heads/race-candidate")
        hook = self.repo / ".git/hooks/pre-push"
        hook.write_text("#!/bin/sh\ngit --git-dir=" + shlex.quote(str(self.remote)) +
                        " update-ref refs/heads/deploy/preview-123 " + self.source + "\n")
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
