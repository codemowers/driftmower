import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import release


class ReleaseTests(unittest.TestCase):
    def test_version_tags_and_prereleases(self):
        for tag in ["v1.2.3", "v0.9.3-rc.1"]:
            result = release.metadata("push", "tag", tag)
            self.assertEqual(result["publish"], "true")
            self.assertEqual(result["chart_version"], tag.removeprefix("v"))
        for tag in ["1.2.3", "0.9.3-rc.1", "v1", "v1.2", "v1.2.3+build", "v1.2.3-01", "v01.2.3", "v1.2.3\nmalicious"]:
            with self.assertRaises(ValueError):
                release.metadata("push", "tag", tag)
        self.assertEqual(release.metadata("push", "branch", "main"), {"publish": "false"})
        self.assertEqual(release.metadata("workflow_dispatch", "tag", "v1.2.3"), {"publish": "false"})

    def assets(self, directory, tag="1.2.3"):
        for target in release.TARGETS:
            (directory / f"driftmower-desktop-{target}").write_bytes(target.encode())
        (directory / f"driftmower-{tag}.tgz").write_bytes(b"packaged chart")

    def test_new_release_stays_draft_until_all_assets_are_uploaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assets(directory)
            with patch.object(release, "lookup_release", return_value=None), patch.object(release, "gh") as gh:
                release.publish("example/project", "v1.2.3", directory)
            calls = [call.args for call in gh.call_args_list]
            self.assertIn("--verify-tag", calls[0])
            self.assertIn("--draft", calls[0])
            self.assertEqual(sum(call[:2] == ("release", "upload") for call in calls), 6)
            self.assertEqual(calls[-1][:3], ("release", "edit", "v1.2.3"))
            self.assertIn("--draft=false", calls[-1])
            self.assertEqual(len((directory / "SHA256SUMS").read_text().splitlines()), 5)

    def test_failed_upload_does_not_publish_the_draft(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assets(directory)
            def fail_upload(*args):
                if args[:2] == ("release", "upload"):
                    raise RuntimeError("upload failed")
            with patch.object(release, "lookup_release", return_value=None), patch.object(release, "gh", side_effect=fail_upload) as gh:
                with self.assertRaises(RuntimeError):
                    release.publish("example/project", "v1.2.3", directory)
            self.assertFalse(any(call.args[:2] == ("release", "edit") for call in gh.call_args_list))

    def test_reruns_never_replace_different_published_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assets(directory)
            name = "driftmower-desktop-linux-amd64"
            existing = {"draft": False, "assets": [{"name": name, "digest": "sha256:" + "0" * 64}]}
            with patch.object(release, "lookup_release", return_value=existing), patch.object(release, "gh") as gh:
                with self.assertRaisesRegex(ValueError, "use a new release tag"):
                    release.publish("example/project", "v1.2.3", directory)
            gh.assert_not_called()

    def test_partial_reruns_skip_matching_assets_and_upload_missing_ones(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assets(directory)
            path = directory / "driftmower-desktop-darwin-arm64"
            existing = {"draft": True, "assets": [{"name": path.name, "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}]}
            with patch.object(release, "lookup_release", return_value=existing), patch.object(release, "gh") as gh:
                release.publish("example/project", "v1.2.3", directory)
            uploads = [call.args[3] for call in gh.call_args_list if call.args[:2] == ("release", "upload")]
            self.assertEqual(len(uploads), 5)
            self.assertNotIn(str(path), uploads)

    def test_legacy_assets_without_digest_are_downloaded_and_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assets(directory)
            path = directory / "driftmower-desktop-linux-arm64"
            existing = {"draft": False, "assets": [{"name": path.name, "digest": None}]}
            def download(*args):
                if args[:2] == ("release", "download"):
                    destination = Path(args[args.index("--dir") + 1])
                    (destination / path.name).write_bytes(path.read_bytes())
            with patch.object(release, "lookup_release", return_value=existing), patch.object(release, "gh", side_effect=download) as gh:
                release.publish("example/project", "v1.2.3", directory)
            self.assertTrue(any(call.args[:2] == ("release", "download") for call in gh.call_args_list))
            self.assertFalse(any(call.args[:2] == ("release", "edit") for call in gh.call_args_list))

    def test_prerelease_tag_uses_normalized_chart_name_and_prerelease_flag(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.assets(directory, "1.2.3-rc.1")
            with patch.object(release, "lookup_release", return_value=None), patch.object(release, "gh") as gh:
                release.publish("example/project", "v1.2.3-rc.1", directory)
            self.assertIn("--prerelease", gh.call_args_list[0].args)
            self.assertIn("--prerelease=true", gh.call_args_list[-1].args)

    def test_only_http_404_means_release_does_not_exist(self):
        for status, code, expected in [(404, 1, None), (200, 0, {"draft": True, "assets": []})]:
            response = subprocess.CompletedProcess([], code, f"HTTP/2.0 {status} Status\nserver: GitHub\n\n" + json.dumps(expected), "")
            with patch.object(release.subprocess, "run", return_value=response):
                self.assertEqual(release.lookup_release("example/project", "v1.2.3"), expected)
        response = subprocess.CompletedProcess([], 1, "HTTP/2.0 403 Forbidden\n\n{}", "permission denied")
        with patch.object(release.subprocess, "run", return_value=response):
            with self.assertRaises(RuntimeError):
                release.lookup_release("example/project", "v1.2.3")


if __name__ == "__main__":
    unittest.main()
