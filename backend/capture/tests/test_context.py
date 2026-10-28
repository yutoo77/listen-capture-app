from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from capture import services


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class DocumentVersionContextTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user("context-owner")
        self.other = get_user_model().objects.create_user("context-other")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.document = services.create_document(
            self.owner,
            {"title": "改訂する資料", "text": "音声を作ったときの元の本文です。"},
        )
        self.original = self.document.versions.first()
        self.url = f"/api/documents/{self.document.id}/versions/{self.original.id}/"

    def test_immutable_original_context_survives_new_text_version(self):
        services.update_document(
            self.owner, self.document.id, {"text": "改訂後の新しい本文です。"}
        )
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["text"], self.original.text)
        self.assertEqual(response.data["number"], 1)
        self.assertEqual(str(response.data["document"]), str(self.document.id))
        self.assertIn("no-store", response["Cache-Control"])

    def test_other_account_and_wrong_parent_cannot_read_context(self):
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.client.force_authenticate(self.owner)
        another = services.create_document(
            self.owner, {"title": "別の資料", "text": "無関係の本文"}
        )
        wrong_parent = f"/api/documents/{another.id}/versions/{self.original.id}/"
        self.assertEqual(self.client.get(wrong_parent).status_code, 404)

    def test_context_requires_login_and_cannot_be_mutated(self):
        self.assertEqual(APIClient().get(self.url).status_code, 403)
        self.assertEqual(
            self.client.patch(
                self.url, {"text": "差し替え"}, format="json"
            ).status_code,
            405,
        )
        self.original.refresh_from_db()
        self.assertEqual(self.original.text, "音声を作ったときの元の本文です。")

    def test_deleted_document_context_is_no_longer_available(self):
        self.document.delete()
        self.assertEqual(self.client.get(self.url).status_code, 404)
