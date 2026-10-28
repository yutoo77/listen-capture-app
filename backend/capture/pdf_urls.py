from django.urls import path

from . import pdf_views

urlpatterns = [
    path("pdf-imports/", pdf_views.PdfImportListView.as_view()),
    path("pdf-imports/<uuid:job_id>/", pdf_views.PdfImportDetailView.as_view()),
    path("pdf-imports/<uuid:job_id>/pages/", pdf_views.PdfImportPagesView.as_view()),
    path(
        "pdf-imports/<uuid:job_id>/confirm/", pdf_views.PdfImportConfirmView.as_view()
    ),
    path("pdf-imports/<uuid:job_id>/source/", pdf_views.PdfImportSourceView.as_view()),
]
