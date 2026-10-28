"""Provision an empty application DB once, then verify least-privilege runtime.

No secrets are accepted on the command line or included in failure messages.
Initialization changes the configured database and must be explicitly requested.
Use an independently held bootstrap identity, never the running application's
credentials. Existing databases/roles are refused rather than silently adopted.
"""

import argparse
import os
import re
import sys

import psycopg
from psycopg import sql

# Preserve existing imports used by maintenance/recovery callers.
from database_role_config import NAME as NAME, configuration as configuration


def connection(values):
    return dict(
        dbname=values["POSTGRES_DB"],
        host=values.get("POSTGRES_HOST", "127.0.0.1"),
        port=values.get("POSTGRES_PORT", "54329"),
        user=values["POSTGRES_USER"],
        password=values["POSTGRES_PASSWORD"],
        connect_timeout=5,
        sslmode=values.get("POSTGRES_SSLMODE", "prefer"),
    )


def validate_existing_roles(admin, migrator, runtime):
    if (
        not NAME.fullmatch(migrator)
        or not NAME.fullmatch(runtime)
        or migrator == runtime
    ):
        raise ValueError("Restricted restore requires two distinct simple role names")
    rows = admin.execute(
        "SELECT rolname, rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) "
        "AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) "
        "FROM pg_roles WHERE rolname=ANY(%s)",
        ([migrator, runtime],),
    ).fetchall()
    if len(rows) != 2 or not all(row[1] for row in rows):
        raise ValueError(
            "Restricted restore requires existing non-administrative isolated login roles"
        )


def apply_database_policy(admin, names, *, existing_tables=False):
    admin.execute(
        sql.SQL("ALTER DATABASE {} OWNER TO {}").format(
            sql.Identifier(names["database"]), sql.Identifier(names["migrator"])
        )
    )
    admin.execute(
        sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(
            sql.Identifier(names["database"])
        )
    )
    admin.execute("REVOKE ALL ON SCHEMA public FROM PUBLIC")
    admin.execute(
        sql.SQL("ALTER SCHEMA public OWNER TO {}").format(
            sql.Identifier(names["migrator"])
        )
    )
    admin.execute(
        sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
            sql.Identifier(names["database"]), sql.Identifier(names["runtime"])
        )
    )
    admin.execute(
        sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(
            sql.Identifier(names["runtime"])
        )
    )
    for objects, privileges in (
        ("TABLES", "SELECT, INSERT, UPDATE, DELETE"),
        ("SEQUENCES", "USAGE, SELECT"),
    ):
        if existing_tables:
            admin.execute(
                sql.SQL("GRANT {} ON ALL {} IN SCHEMA public TO {}").format(
                    sql.SQL(privileges),
                    sql.SQL(objects),
                    sql.Identifier(names["runtime"]),
                )
            )
        admin.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public GRANT {} ON {} TO {}"
            ).format(
                sql.Identifier(names["migrator"]),
                sql.SQL(privileges),
                sql.SQL(objects),
                sql.Identifier(names["runtime"]),
            )
        )


def reconcile_restored(values, *, migrator, runtime):
    if not re.fullmatch(r"lc_restore_[a-z0-9_]{1,40}", values.get("POSTGRES_DB", "")):
        raise ValueError(
            "Grant reconciliation is limited to disposable restore databases"
        )
    with psycopg.connect(**connection(values)) as admin:
        validate_existing_roles(admin, migrator, runtime)
        owner = admin.execute(
            "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()"
        ).fetchone()[0]
        if owner != migrator:
            raise ValueError("Restored DB must be owned by the migration role")
        if admin.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') AND pg_get_userbyid(c.relowner)<>%s)",
            (migrator,),
        ).fetchone()[0]:
            raise ValueError(
                "Restored application objects must belong to the migration role"
            )
        apply_database_policy(
            admin,
            {
                "database": values["POSTGRES_DB"],
                "migrator": migrator,
                "runtime": runtime,
            },
            existing_tables=True,
        )
        admin.execute(
            sql.SQL(
                "REVOKE INSERT, UPDATE, DELETE ON public.django_migrations FROM {}"
            ).format(sql.Identifier(runtime))
        )


def initialize(values, *, confirmed):
    if not confirmed:
        raise ValueError(
            "--confirm-role-setup is required for initial empty-DB provisioning"
        )
    names = configuration(values)
    # CREATE ROLE and privilege/ownership changes share one transaction. A refusal
    # or failed grant cannot leave a partially provisioned login behind.
    with psycopg.connect(**connection(values)) as admin:
        if admin.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = ANY(%s))",
            ([names["migrator"], names["runtime"]],),
        ).fetchone()[0]:
            raise ValueError("Refusing to reuse existing migration/runtime roles")
        if admin.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%%' "
            "AND c.relkind IN ('r','p','v','m','S','f')) "
            "OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')"
        ).fetchone()[0]:
            raise ValueError(
                "Refusing to provision a database containing application objects"
            )
        for kind in ("migrator", "runtime"):
            admin.execute(
                sql.SQL(
                    "CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                    "NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {}"
                ).format(
                    sql.Identifier(names[kind]),
                    sql.Literal(values[f"POSTGRES_{kind.upper()}_PASSWORD"]),
                )
            )
        apply_database_policy(admin, names)


def check_runtime(values):
    """Read catalog permissions only; never issue DDL or test writes in production."""
    with psycopg.connect(**connection(values)) as runtime:
        dangerous = runtime.execute(
            "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls "
            "FROM pg_roles WHERE rolname=current_user"
        ).fetchone()[0]
        if dangerous:
            raise ValueError("Runtime role has administrative privileges")
        if runtime.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user))"
        ).fetchone()[0]:
            raise ValueError("Runtime role must not belong to other roles")
        if runtime.execute(
            "SELECT has_database_privilege(current_user, current_database(), 'CREATE') "
            "OR has_database_privilege(current_user, current_database(), 'TEMP') "
            "OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' "
            "AND nspname <> 'information_schema' AND has_schema_privilege(current_user,oid,'CREATE'))"
        ).fetchone()[0]:
            raise ValueError("Runtime role can create database/schema objects")
        if runtime.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p','S') "
            "AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))"
        ).fetchone()[0]:
            raise ValueError("Runtime role owns application objects")
        if (
            runtime.execute(
                "SELECT to_regclass('public.django_migrations')"
            ).fetchone()[0]
            is None
        ):
            raise ValueError("Migrations must finish before runtime starts")
        if runtime.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS required(privilege) "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p') "
            "AND (c.relname <> 'django_migrations' OR required.privilege='SELECT') "
            "AND NOT has_table_privilege(current_user,c.oid,required.privilege))"
        ).fetchone()[0]:
            raise ValueError("Runtime role is missing application table privileges")
        if runtime.execute(
            "SELECT has_table_privilege(current_user,'public.django_migrations','INSERT,UPDATE,DELETE')"
        ).fetchone()[0]:
            raise ValueError("Runtime role can alter migration history")
        if runtime.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind='S' AND NOT has_sequence_privilege(current_user,c.oid,'USAGE'))"
        ).fetchone()[0]:
            raise ValueError("Runtime role is missing sequence privileges")


def protect_migrations(values):
    role = values.get("POSTGRES_RUNTIME_USER", "")
    if not NAME.fullmatch(role) or role == values.get("POSTGRES_USER"):
        raise ValueError("Migration protection requires a separate runtime role")
    with psycopg.connect(**connection(values)) as migrator:
        migrator.execute(
            sql.SQL(
                "REVOKE INSERT, UPDATE, DELETE ON public.django_migrations FROM {}"
            ).format(sql.Identifier(role))
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=["initialize", "check-runtime", "protect-migrations"]
    )
    parser.add_argument("--confirm-role-setup", action="store_true")
    args = parser.parse_args()
    try:
        if args.action == "initialize":
            initialize(os.environ, confirmed=args.confirm_role_setup)
        elif args.action == "protect-migrations":
            protect_migrations(os.environ)
        else:
            check_runtime(os.environ)
    except ValueError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    except psycopg.Error:
        # Never print connection strings, SQL/password literals or provider detail.
        print(
            "FAIL: database role operation failed; inspect DB health and privileges privately",
            file=sys.stderr,
        )
        return 1
    print(f"Database role {args.action} passed; no credentials printed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
