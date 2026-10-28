"""Offline refusal tests; live PostgreSQL behavior is exercised by the role drill."""

import unittest
from unittest.mock import patch

from database_roles import configuration, initialize
from backup_private import restore_pair


class DatabaseRoleSafetyTests(unittest.TestCase):
    def valid(self):
        return {
            "POSTGRES_DB": "listen_capture",
            "POSTGRES_USER": "lc_admin",
            "POSTGRES_PASSWORD": "a" * 32,
            "POSTGRES_MIGRATOR_USER": "lc_migrator",
            "POSTGRES_MIGRATOR_PASSWORD": "m" * 32,
            "POSTGRES_RUNTIME_USER": "lc_runtime",
            "POSTGRES_RUNTIME_PASSWORD": "r" * 32,
        }

    def test_initialization_requires_confirmation_before_any_connection(self):
        with patch("database_roles.psycopg.connect") as connect:
            with self.assertRaises(ValueError):
                initialize(self.valid(), confirmed=False)
            connect.assert_not_called()

    def test_rejects_shared_identity_password_or_sql_name_before_connection(self):
        for changes in (
            {"POSTGRES_RUNTIME_USER": "lc_admin"},
            {"POSTGRES_MIGRATOR_USER": "lc_runtime"},
            {"POSTGRES_RUNTIME_PASSWORD": "a" * 32},
            {"POSTGRES_RUNTIME_PASSWORD": "short"},
            {"POSTGRES_MIGRATOR_USER": 'role";DROP DATABASE postgres;--'},
            {"POSTGRES_DB": "postgres"},
            {"POSTGRES_DB": "template1"},
            {"POSTGRES_RUNTIME_USER": "pg_app"},
        ):
            with self.subTest(changes=list(changes)):
                with patch("database_roles.psycopg.connect") as connect:
                    with self.assertRaises(ValueError):
                        initialize(self.valid() | changes, confirmed=True)
                    connect.assert_not_called()

    def test_accepts_separate_roles_and_secrets(self):
        self.assertEqual(configuration(self.valid())["runtime"], "lc_runtime")

    def test_restricted_restore_refuses_incomplete_or_injected_roles_offline(self):
        for migrator, runtime in (
            ("lc_migrator", None),
            ("same", "same"),
            ('x";DROP ROLE postgres;--', "lc_runtime"),
        ):
            with self.subTest(migrator=migrator):
                with patch("backup_private.psycopg.connect") as connect:
                    with self.assertRaises(ValueError):
                        restore_pair(
                            "missing",
                            "lc_restore_test",
                            "missing-target",
                            confirm_disposable=True,
                            migrator_role=migrator,
                            runtime_role=runtime,
                        )
                    connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
