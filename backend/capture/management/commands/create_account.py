import getpass

from django.contrib.auth import get_user_model, password_validation
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Create an invited non-staff account; prompt for password without command-line secrets"

    def add_arguments(self, parser):
        parser.add_argument("username")

    def handle(self, *args, **options):
        username = options["username"]
        user = get_user_model()(username=username, is_staff=False, is_superuser=False)
        try:
            user.full_clean(exclude=["password"])
            password = getpass.getpass("Password: ")
            if password != getpass.getpass("Confirm password: "):
                raise CommandError("Passwords do not match")
            password_validation.validate_password(password, user)
        except ValidationError as exc:
            raise CommandError("; ".join(exc.messages)) from exc
        user.set_password(password)
        user.save()
        self.stdout.write("Invited account created (non-staff).")
