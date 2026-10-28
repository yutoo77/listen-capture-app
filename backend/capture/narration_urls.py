from django.urls import path

from . import narration_views as views

urlpatterns = [
    path("narration/config/", views.ConfigView.as_view()),
    path("documents/<uuid:document_id>/narration/", views.StartView.as_view()),
    path("narrations/<uuid:job_id>/", views.DetailView.as_view()),
    path("narrations/<uuid:job_id>/retry/", views.RetryView.as_view()),
    path("narrations/<uuid:job_id>/cancel/", views.CancelView.as_view()),
    path("audio/<uuid:audio_id>/narration-map/", views.MappingView.as_view()),
]
