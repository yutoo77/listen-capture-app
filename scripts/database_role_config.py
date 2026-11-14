"""Pure DB-role input validation shared by host preflight and DB operations.

Importing this module needs only the Python standard library and never connects
to PostgreSQL. SQL operations remain in database_roles with the DB driver.
"""

import re

NAME = re.compile(r"[a-z][a-z0-9_]{0,62}\Z")


def configuration(values):
    names = {
        "database": values.get("POSTGRES_DB", ""),
        "admin": values.get("POSTGRES_USER", ""),
        "migrator": values.get("POSTGRES_MIGRATOR_USER", ""),
        "runtime": values.get("POSTGRES_RUNTIME_USER", ""),
    }
    if any(not NAME.fullmatch(value) for value in names.values()):
        raise ValueError("Database/role names must be simple lower-case identifiers")
    if names["database"] in {"postgres", "template0", "template1"}:
        raise ValueError(
            "Refusing to provision a PostgreSQL maintenance/template database"
        )
    if any(names[key].startswith("pg_") for key in ("admin", "migrator", "runtime")):
        raise ValueError(
            "Reserved PostgreSQL role names cannot be application identities"
        )
    if len({names["admin"], names["migrator"], names["runtime"]}) != 3:
        raise ValueError("Bootstrap, migrator and runtime role names must differ")
    passwords = [
        values.get(key, "")
        for key in (
            "POSTGRES_PASSWORD",
            "POSTGRES_MIGRATOR_PASSWORD",
            "POSTGRES_RUNTIME_PASSWORD",
        )
    ]
    if any(len(password) < 24 for password in passwords) or len(set(passwords)) != 3:
        raise ValueError(
            "Each DB identity needs its own password of at least 24 characters"
        )
    return names
