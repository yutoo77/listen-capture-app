"""Offline lifecycle checks for disposable E2E account ownership and secrets."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "e2e_accounts", Path(__file__).with_name("run-e2e.py")
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def listed(*ids):
    return {"suites": [{"specs": [{"id": identifier} for identifier in ids]}]}


class E2eAccountLifecycleTests(unittest.TestCase):
    def model(self, *, fail_after=None):
        manager = Mock()
        manager.create_user.side_effect = [
            SimpleNamespace(id=index) for index in range(1, (fail_after or 10) + 1)
        ] + ([RuntimeError("synthetic creation failure")] if fail_after else [])
        return SimpleNamespace(objects=manager)

    def test_ids_preserve_nested_filtered_repeat_and_project_identity(self):
        report = listed("project-one-test", "project-two-test")
        report["suites"][0]["suites"] = listed("repeat-one-test")["suites"]
        self.assertEqual(
            runner.collect_test_ids(report),
            ["project-one-test", "project-two-test", "repeat-one-test"],
        )
        for invalid in (
            {},
            {"errors": [{"message": "private"}]},
            listed(),
            listed("x", "x"),
        ):
            with self.subTest(report=invalid), self.assertRaises(ValueError):
                runner.collect_test_ids(invalid)

    def test_each_test_owns_two_unique_accounts_and_cleanup_uses_created_ids(self):
        model = self.model()
        with runner.seeded_accounts(model, ["first", "second"]) as accounts:
            first, second = accounts["first"], accounts["second"]
            self.assertNotEqual(first["alice"]["username"], second["alice"]["username"])
            self.assertNotEqual(first["alice"]["password"], second["alice"]["password"])
            self.assertEqual(first["alice"]["password"], first["bob"]["password"])
            model.objects.filter.assert_not_called()
        filters = model.objects.filter.call_args.kwargs
        self.assertEqual(filters["id__in"], [1, 2, 3, 4])
        self.assertEqual(len(filters["username__in"]), 4)
        model.objects.filter.return_value.delete.assert_called_once()

    def test_partial_creation_failure_still_cleans_only_successfully_created_users(
        self,
    ):
        model = self.model(fail_after=1)
        with self.assertRaises(RuntimeError):
            with runner.seeded_accounts(model, ["first"]):
                self.fail("Partial seed must not start a test")
        self.assertEqual(model.objects.filter.call_args.kwargs["id__in"], [1])
        model.objects.filter.return_value.delete.assert_called_once()

    def test_failed_test_run_removes_credentials_and_accounts_without_environment_mutation(
        self,
    ):
        model = self.model()
        environment = {"LC_E2E_ALICE": "existing-user", "LC_E2E_PASSWORD": "old-secret"}
        seen = []

        def execute(command, **kwargs):
            self.assertEqual(kwargs["encoding"], "utf-8")
            if "--list" in command:
                self.assertNotIn("LC_E2E_PASSWORD", kwargs["env"])
                self.assertNotIn("LC_E2E_ACCOUNTS_FILE", kwargs["env"])
                return SimpleNamespace(stdout=json.dumps(listed("one", "two")))
            path = Path(kwargs["env"]["LC_E2E_ACCOUNTS_FILE"])
            self.assertEqual(set(json.loads(path.read_text())), {"one", "two"})
            self.assertNotIn("old-secret", path.read_text())
            self.assertNotIn("LC_E2E_PASSWORD", kwargs["env"])
            seen.append(path)
            return SimpleNamespace(returncode=1)

        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(runner, "ROOT", Path(folder)),
            patch.object(runner.subprocess, "run", side_effect=execute),
        ):
            self.assertEqual(runner.run([], model, environment=environment), 1)
            self.assertFalse(seen[0].exists())
            self.assertEqual(list((Path(folder) / ".local").iterdir()), [])
        self.assertEqual(environment["LC_E2E_ALICE"], "existing-user")
        self.assertEqual(model.objects.filter.call_args.kwargs["id__in"], [1, 2, 3, 4])

    def test_discovery_failure_never_creates_accounts(self):
        model = self.model()
        with (
            patch.object(
                runner.subprocess,
                "run",
                side_effect=subprocess.CalledProcessError(1, ["node", "test"]),
            ),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            runner.run([], model, environment={})
        model.objects.create_user.assert_not_called()
        model.objects.filter.assert_not_called()

    def test_interrupted_runner_still_removes_the_password_file_and_owned_users(self):
        model = self.model()
        seen = []

        def execute(command, **kwargs):
            if "--list" in command:
                return SimpleNamespace(stdout=json.dumps(listed("one")))
            seen.append(Path(kwargs["env"]["LC_E2E_ACCOUNTS_FILE"]))
            self.assertTrue(seen[0].exists())
            raise KeyboardInterrupt()

        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(runner, "ROOT", Path(folder)),
            patch.object(runner.subprocess, "run", side_effect=execute),
        ):
            with self.assertRaises(KeyboardInterrupt):
                runner.run([], model, environment={})
            self.assertFalse(seen[0].exists())
        self.assertEqual(model.objects.filter.call_args.kwargs["id__in"], [1, 2])
        model.objects.filter.return_value.delete.assert_called_once()


if __name__ == "__main__":
    unittest.main()
