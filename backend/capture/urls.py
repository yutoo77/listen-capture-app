from django.urls import include, path

from . import auth, playlist, views

urlpatterns = [
    path("", include("capture.narration_urls")),
    path("", include("capture.pdf_urls")),
    path("session/", auth.session),
    path("login/", auth.login_view),
    path("logout/", auth.logout_view),
    path("health/", views.HealthView.as_view()),
    path("documents/", views.DocumentListView.as_view()),
    path("documents/demo/", views.DemoView.as_view()),
    path("documents/<uuid:document_id>/", views.DocumentDetailView.as_view()),
    path(
        "documents/<uuid:document_id>/versions/<uuid:version_id>/",
        views.DocumentVersionDetailView.as_view(),
    ),
    path(
        "documents/<uuid:document_id>/audio-generation/",
        views.DocumentGenerationView.as_view(),
    ),
    path("audio-generations/<uuid:job_id>/", views.GenerationDetailView.as_view()),
    path("audio/<uuid:audio_id>/content/", views.AudioContentView.as_view()),
    path("audio/<uuid:audio_id>/playlist/", playlist.PlaylistView.as_view()),
    path(
        "audio/<uuid:audio_id>/segments/<int:index>/content/",
        playlist.SegmentContentView.as_view(),
    ),
    path("audio/<uuid:audio_id>/progress/", views.PlaybackProgressView.as_view()),
    path("memos/", views.MemoListView.as_view()),
    path("memos/<uuid:memo_id>/", views.MemoDetailView.as_view()),
    path("memos/<uuid:memo_id>/content/", views.MemoContentView.as_view()),
]
